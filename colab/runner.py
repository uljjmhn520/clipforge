#!/usr/bin/env python3
"""
Colab 专属协议运行器与任务调度器 (runner.py - v3.0 极速双向通信与目录队列版)
-------------------------------------------------------------------------
职责：
1. 阶段 1：秒级启动 stdio JSON-RPC 通信，向本地发送 handshake.ready，消除开机盲区；
2. 阶段 2：后台受控执行 ComfyUI 与 MiniMax-H3/Image 权重 (40GB+) 多线程拉取，向本地流式推送安装进度、网络下行速率与日志流；
3. 阶段 3：目录任务队列扫描器 (/content/tasks/pending/)，顺序消费文生图与图生视频任务，产物写入 Google Drive 并移入 completed/；
4. 阶段 4：两阶段看门狗守护 (BUSY 与安装期计时冻结，IDLE 默认 5 分钟自动释放防扣费，支持 Web 端一键续命)；
5. 实时硬件指标监控 (CPU/GPU/显存/网络速度)，向本地解释 CPU 偏低的真实原因。
"""

import os
import sys
import time
import json
import shutil
import threading
import subprocess
import argparse
from typing import Optional, Dict, Any, List

# 全局运行状态树
STATE = {
    "session_name": "clipforge_default",
    "lifecycle": "INIT_BOOT",  # "INIT_BOOT" | "RPC_READY" | "INSTALLING_MODELS" | "IDLE" | "BUSY"
    "status": "INIT",          # "INIT" | "IDLE" | "BUSY"
    "current_task": None,
    "idle_timeout_seconds": 300,   # 默认 5 分钟空闲关机
    "idle_seconds_left": 300,
    "max_lifetime_seconds": 14400, # 4 小时硬性生命周期上限
    "started_at": time.time(),
    "env_ready": False,
    "install_progress": {
        "stage": "init",
        "percent": 0,
        "speed_mbps": 0.0,
        "message": "正在初始化通信隧道...",
        "log_tail": []
    },
    "current_progress": {
        "taskId": None,
        "taskType": None,
        "percent": 0,
        "step": "idle",
        "message": "空闲等待任务中",
        "elapsedSec": 0.0,
        "extra": {}
    },
    "lock": threading.Lock()
}

# 关键目录定义
TASKS_DIR = "/content/tasks"
PENDING_DIR = os.path.join(TASKS_DIR, "pending")
RUNNING_DIR = os.path.join(TASKS_DIR, "running")
COMPLETED_DIR = os.path.join(TASKS_DIR, "completed")
FAILED_DIR = os.path.join(TASKS_DIR, "failed")
DRIVE_OUTPUT_DIR = "/content/drive/MyDrive/ClipForge/outputs"
LOCAL_OUTPUT_DIR = "/content/outputs"
TUNNEL_URL_FILE = "/content/tunnel_url.txt"
STATE["tunnel_url"] = None

# 全局网络流量采样
_LAST_NET_BYTES = 0
_LAST_NET_TIME = time.time()

# 线程安全输出队列与异步投递机制
import queue
import re

try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.responses import FileResponse, JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn
    import asyncio
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False
    FastAPI = None
    WebSocket = None

_LOOP = None
_ACTIVE_WEBSOCKETS: set = set()
_WS_LOCK = threading.Lock()
_OUTPUT_QUEUE: "queue.Queue[str]" = queue.Queue()

async def _broadcast_ws(data_dict: dict):
    """向所有连接的 WebSocket 客户端广播事件帧"""
    if not HAS_FASTAPI or not _ACTIVE_WEBSOCKETS:
        return
    text = json.dumps(data_dict, ensure_ascii=False)
    with _WS_LOCK:
        clients = list(_ACTIVE_WEBSOCKETS)
    dead = []
    for client in clients:
        try:
            await client.send_text(text)
        except Exception:
            dead.append(client)
    if dead:
        with _WS_LOCK:
            for d in dead:
                _ACTIVE_WEBSOCKETS.discard(d)

def _stdout_writer_daemon():
    """独占输出守护线程：保证所有 RPC 消息单线程、有序、原子写入 stdout，绝不阻塞任何工作线程"""
    while True:
        try:
            line = _OUTPUT_QUEUE.get()
            if line is None:
                break
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except Exception:
            pass

def send_rpc_raw(data: dict):
    """向标准输出投递原始 JSON 消息（无锁高吞吐投递，并同时广播给 WebSocket 客户端）"""
    try:
        _OUTPUT_QUEUE.put(json.dumps(data, ensure_ascii=False))
        if HAS_FASTAPI and _LOOP and _LOOP.is_running():
            asyncio.run_coroutine_threadsafe(_broadcast_ws(data), _LOOP)
    except Exception:
        pass

def send_rpc_event(method: str, params: Dict[str, Any]):
    """向标准输出与 WebSocket 客户端投递异步通知事件 (JSON-RPC Notification)"""
    send_rpc_raw({
        "jsonrpc": "2.0",
        "method": method,
        "params": params
    })

def process_rpc_frame(req: dict) -> Optional[dict]:
    """统一处理 JSON-RPC 请求，支持 stdio 与 WebSocket 共享复用"""
    req_id = req.get("id")
    method = req.get("method")
    params = req.get("params", {})

    if method == "heartbeat.ping":
        with STATE["lock"]:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "pong": True,
                    "sessionName": STATE["session_name"],
                    "lifecycle": STATE["lifecycle"],
                    "state": STATE["status"],
                    "currentTask": STATE["current_task"],
                    "currentProgress": STATE["current_progress"],
                    "idleSecondsLeft": STATE["idle_seconds_left"],
                    "envReady": STATE["env_ready"],
                    "tunnelUrl": STATE["tunnel_url"],
                    "installProgress": STATE["install_progress"],
                    "hardware": _CACHED_METRICS
                }
            }

    elif method == "watchdog.extend":
        add_sec = int(params.get("seconds", 900))
        with STATE["lock"]:
            STATE["idle_seconds_left"] += add_sec
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"extended": True, "idleSecondsLeft": STATE["idle_seconds_left"]}
        }

    elif method == "watchdog.shutdown":
        resp = {"jsonrpc": "2.0", "id": req_id, "result": {"shuttingDown": True}}
        send_rpc_raw(resp)
        try:
            from google.colab import runtime
            runtime.unassign()
        except Exception:
            os._exit(0)
        return None

    elif method == "task.submit":
        task_id = params.get("taskId") or f"rpc_{int(time.time()*1000)}"
        task_file = os.path.join(PENDING_DIR, f"{int(time.time())}_{task_id}.json")
        with open(task_file, "w", encoding="utf-8") as f:
            json.dump(params, f, ensure_ascii=False, indent=2)
        return {"jsonrpc": "2.0", "id": req_id, "result": {"queued": True, "taskId": task_id}}

    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Method {method} not found"}}

if HAS_FASTAPI:
    app = FastAPI(title="ClipForge Colab Runner API")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health_http():
        return {"status": "ok", "session": STATE["session_name"], "lifecycle": STATE["lifecycle"]}

    @app.get("/status")
    def get_status_http():
        with STATE["lock"]:
            return {
                "sessionName": STATE["session_name"],
                "lifecycle": STATE["lifecycle"],
                "state": STATE["status"],
                "currentTask": STATE["current_task"],
                "currentProgress": STATE["current_progress"],
                "idleSecondsLeft": STATE["idle_seconds_left"],
                "envReady": STATE["env_ready"],
                "tunnelUrl": STATE["tunnel_url"],
                "hardware": _CACHED_METRICS
            }

    @app.get("/outputs/{filename}")
    def get_output_file_http(filename: str):
        filepath = os.path.join(LOCAL_OUTPUT_DIR, filename)
        if os.path.exists(filepath):
            return FileResponse(filepath)
        return JSONResponse(status_code=404, content={"error": f"File {filename} not found"})

    @app.post("/tasks/submit")
    def submit_task_http(task_data: dict):
        task_id = task_data.get("taskId") or f"http_{int(time.time()*1000)}"
        task_file = os.path.join(PENDING_DIR, f"{int(time.time())}_{task_id}.json")
        with open(task_file, "w", encoding="utf-8") as f:
            json.dump(task_data, f, ensure_ascii=False, indent=2)
        return {"queued": True, "taskId": task_id}

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        await websocket.accept()
        with _WS_LOCK:
            _ACTIVE_WEBSOCKETS.add(websocket)
        try:
            while True:
                data_text = await websocket.receive_text()
                try:
                    req = json.loads(data_text)
                    resp = process_rpc_frame(req)
                    if resp:
                        await websocket.send_text(json.dumps(resp, ensure_ascii=False))
                except Exception as e:
                    err_resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": str(e)}}
                    await websocket.send_text(json.dumps(err_resp, ensure_ascii=False))
        except WebSocketDisconnect:
            pass
        finally:
            with _WS_LOCK:
                _ACTIVE_WEBSOCKETS.discard(websocket)

def ensure_cloudflared_installed() -> bool:
    """自动安装 cloudflared 二进制程序至 /usr/local/bin (耗时约 2~3 秒)"""
    if shutil.which("cloudflared") and os.path.exists("/usr/local/bin/cloudflared"):
        return True
    print("[TUNNEL] 正在自动安装 Cloudflare Tunnel (cloudflared)...", flush=True)
    try:
        url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
        subprocess.run(["curl", "-fsSL", "-o", "/usr/local/bin/cloudflared", url], timeout=30, check=True)
        subprocess.run(["chmod", "+x", "/usr/local/bin/cloudflared"], check=True)
        print("[TUNNEL] cloudflared 自动安装完成！", flush=True)
        return True
    except Exception as e:
        print(f"[TUNNEL] 自动安装 cloudflared 异常: {e}", flush=True)
        return False

def start_cloudflared_tunnel_daemon(port: int = 8000):
    """启动 Cloudflare Quick Tunnel 守护进程，提取动态 trycloudflare 域名并写入 /content/tunnel_url.txt"""
    if not shutil.which("cloudflared"):
        if not ensure_cloudflared_installed():
            # 轮询等待 setup_env.sh 或外部安装完成
            for _ in range(30):
                time.sleep(2)
                if shutil.which("cloudflared"):
                    break
    if not shutil.which("cloudflared"):
        print("[TUNNEL] cloudflared 安装未就绪，跳过隧道启动", flush=True)
        return
    cmd = ["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{port}"]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        t0 = time.time()
        tunnel_url = None
        while time.time() - t0 < 45:
            line = proc.stderr.readline()
            if not line:
                time.sleep(0.2)
                continue
            if "trycloudflare.com" in line:
                m = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", line)
                if m:
                    tunnel_url = m.group(0)
                    break
        if tunnel_url:
            print(f"[TUNNEL] Cloudflare 穿透隧道建立成功: {tunnel_url}", flush=True)
            STATE["tunnel_url"] = tunnel_url
            try:
                with open(TUNNEL_URL_FILE, "w", encoding="utf-8") as f:
                    f.write(tunnel_url.strip())
            except Exception:
                pass
            send_rpc_event("tunnel.ready", {"tunnelUrl": tunnel_url})
        else:
            print("[TUNNEL] 45秒内未提取到 trycloudflare.com 域名", flush=True)
    except Exception as e:
        print(f"[TUNNEL] 运行 cloudflared 异常: {e}", flush=True)

# 异步解耦的硬件指标缓存 (避免 ping 同步调用 nvidia-smi 产生阻塞)
_CACHED_METRICS = {
    "cpu": {"percent": 0.0, "note": "GPU 推理中，CPU 负载偏低属正常现象"},
    "ram": {"usedMb": 0, "totalMb": 0, "percent": 0.0},
    "gpu": {"name": "NVIDIA L4", "utilizationPercent": 0.0, "memoryUsedMb": 0, "memoryTotalMb": 23034, "memoryPercent": 0.0},
    "net": {"downloadSpeedMbps": 0.0},
    "last_update": 0.0
}

def metrics_collector_daemon():
    """独立硬件指标采集线程：将 nvidia-smi 与网络监控解耦至独立后台线程，绝不阻塞通信循环"""
    global _CACHED_METRICS
    while True:
        try:
            cpu_p = get_cpu_percent()
            ram_i = get_ram_info()
            gpu_i = get_gpu_info()
            net_s = get_net_download_mbps()
            _CACHED_METRICS = {
                "cpu": {"percent": cpu_p, "note": "GPU 推理中，CPU 负载偏低属正常现象"},
                "ram": ram_i,
                "gpu": gpu_i,
                "net": {"downloadSpeedMbps": net_s},
                "last_update": time.time()
            }
        except Exception:
            pass
        time.sleep(2.0)

def get_net_download_mbps() -> float:
    """计算网络下行瞬时速率 (Mbps)"""
    global _LAST_NET_BYTES, _LAST_NET_TIME
    try:
        rx_bytes = 0
        with open("/proc/net/dev", "r") as f:
            lines = f.readlines()[2:]
        for line in lines:
            parts = line.strip().split()
            if len(parts) >= 2:
                rx_bytes += int(parts[1])
        now = time.time()
        dt = max(now - _LAST_NET_TIME, 0.1)
        if _LAST_NET_BYTES > 0 and rx_bytes >= _LAST_NET_BYTES:
            speed_bps = (rx_bytes - _LAST_NET_BYTES) / dt
            mbps = round((speed_bps * 8) / (1024 * 1024), 2)
        else:
            mbps = 0.0
        _LAST_NET_BYTES = rx_bytes
        _LAST_NET_TIME = now
        return mbps
    except Exception:
        return 0.0

def get_cpu_percent() -> float:
    """获取 CPU 使用率百分比"""
    try:
        import psutil
        return float(psutil.cpu_percent(interval=None))
    except Exception:
        pass
    try:
        with open("/proc/stat", "r") as f:
            fields = [float(column) for column in f.readline().strip().split()[1:5]]
        idle, total = fields[3], sum(fields)
        return round(100.0 * (1.0 - idle / (total if total > 0 else 1)), 1)
    except Exception:
        return 0.0

def get_ram_info() -> Dict[str, Any]:
    """获取系统内存使用情况"""
    try:
        import psutil
        vm = psutil.virtual_memory()
        return {
            "usedMb": int(vm.used // (1024 * 1024)),
            "totalMb": int(vm.total // (1024 * 1024)),
            "percent": round(vm.percent, 1)
        }
    except Exception:
        pass
    return {"usedMb": 0, "totalMb": 0, "percent": 0.0}

def get_gpu_info() -> Dict[str, Any]:
    """获取 GPU 核心利用率与显存情况"""
    try:
        cmd = ["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]
        out = subprocess.check_output(cmd, timeout=3).decode("utf-8").strip()
        if out:
            parts = [p.strip() for p in out.split(",")]
            name = parts[0]
            util_pct = float(parts[1]) if len(parts) > 1 else 0.0
            used_mb = int(parts[2]) if len(parts) > 2 else 0
            total_mb = int(parts[3]) if len(parts) > 3 else 0
            vram_pct = round(100.0 * used_mb / (total_mb if total_mb > 0 else 1), 1)
            return {
                "name": name,
                "utilizationPercent": util_pct,
                "memoryUsedMb": used_mb,
                "memoryTotalMb": total_mb,
                "memoryPercent": vram_pct
            }
    except Exception:
        pass
    return {
        "name": "NVIDIA GPU",
        "utilizationPercent": 0.0,
        "memoryUsedMb": 0,
        "memoryTotalMb": 22937,
        "memoryPercent": 0.0
    }

def heal_cuda_environment():
    """显存溢出 (OOM) 与环境异常自愈：清理 PyTorch CUDA 缓存并探测/拉起 ComfyUI"""
    print("[HEAL] 触发显存自愈回收与环境健康检查...", flush=True)
    try:
        import gc
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass

    try:
        import urllib.request
        urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=3)
    except Exception:
        print("[HEAL] ComfyUI 进程无响应，执行自愈平滑重启...", flush=True)
        try:
            subprocess.run(["pkill", "-f", "ComfyUI/main.py"], timeout=5)
            time.sleep(2)
            if os.path.exists("/content/ComfyUI/main.py"):
                subprocess.Popen(
                    ["python3", "/content/ComfyUI/main.py", "--listen", "127.0.0.1", "--port", "8188"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
                time.sleep(5)
        except Exception:
            pass

def get_completed_tasks_summary() -> List[Dict[str, Any]]:
    """获取云端已完成任务清单 (用于断线重连时本地瞬间自动补齐与补录)"""
    summary = []
    if os.path.exists(COMPLETED_DIR):
        for name in sorted(os.listdir(COMPLETED_DIR), reverse=True)[:50]:
            p = os.path.join(COMPLETED_DIR, name)
            if os.path.isdir(p):
                res_file = os.path.join(p, "result.json")
                if os.path.exists(res_file):
                    try:
                        with open(res_file, "r", encoding="utf-8") as rf:
                            summary.append(json.load(rf))
                    except Exception:
                        pass
            elif p.endswith(".json"):
                try:
                    with open(p, "r", encoding="utf-8") as rf:
                        data = json.load(rf)
                        tid = data.get("taskId") or data.get("task_id")
                        ofile = data.get("outputFile") or data.get("drive_file")
                        if not ofile:
                            target_dir = DRIVE_OUTPUT_DIR if os.path.exists("/content/drive/MyDrive") else LOCAL_OUTPUT_DIR
                            ofile = os.path.join(target_dir, f"{tid}_grid.png")
                        summary.append({
                            "taskId": tid,
                            "task_id": tid,
                            "status": "completed",
                            "outputFile": ofile,
                            "drive_file": ofile,
                            "driveFile": ofile,
                        })
                except Exception:
                    pass
    return summary

def ensure_directories():
    """初始化运行环境所需的目录结构"""
    for d in [PENDING_DIR, RUNNING_DIR, COMPLETED_DIR, FAILED_DIR, LOCAL_OUTPUT_DIR]:
        os.makedirs(d, exist_ok=True)
    try:
        if os.path.exists("/content/drive/MyDrive"):
            os.makedirs(DRIVE_OUTPUT_DIR, exist_ok=True)
    except Exception:
        pass

def run_environment_installer():
    """后台受控安装线程：拉取 ComfyUI、MiniMax-H3/Image 40GB+ 权重与 LoRA，流式推送进度"""
    with STATE["lock"]:
        STATE["lifecycle"] = "INSTALLING_MODELS"
        STATE["install_progress"]["stage"] = "starting"
        STATE["install_progress"]["message"] = "准备拉取 ComfyUI 与模型权重..."

    send_rpc_event("env.progress", STATE["install_progress"])

    setup_script = "/content/clipforge/colab/setup_env.sh"
    if not os.path.exists(setup_script):
        # 兼容当前执行目录
        setup_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "setup_env.sh")

    if os.path.exists(setup_script):
        try:
            p = subprocess.Popen(
                ["bash", setup_script],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1
            )

            stage_weights = {
                "SYS_DEPS": (5, "安装系统核心编解码与网络依赖 (ffmpeg, aria2)..."),
                "COMFY_CLONE": (15, "正在克隆 ComfyUI 最新核心仓库..."),
                "COMFY_DEPS": (25, "安装 ComfyUI Python 依赖与算力加速扩展..."),
                "MODELS": (35, "开始多线程拉取 MiniMax-H3/Image 官方权重 (40GB+)..."),
                "DOWNLOADING": (50, "多线程高速下载模型分片中..."),
                "DMAD_DOWNLOAD": (80, "下载 DMAD 4 步极速蒸馏 LoRA..."),
                "DMAD_CONVERT": (90, "转换并融合 DMAD LoRA 权重结构..."),
                "FINISHED": (98, "模型与环境就绪，正在拉起 ComfyUI 服务...")
            }

            for raw_line in iter(p.stdout.readline, ""):
                line = raw_line.strip()
                if not line:
                    continue

                # 记录日志尾部
                with STATE["lock"]:
                    tail = STATE["install_progress"]["log_tail"]
                    tail.append(line)
                    if len(tail) > 30:
                        tail.pop(0)

                # 解析阶段标记
                matched_stage = False
                for tag, (pct, desc) in stage_weights.items():
                    if f"[STAGE:{tag}]" in line:
                        with STATE["lock"]:
                            STATE["install_progress"]["stage"] = tag.lower()
                            STATE["install_progress"]["percent"] = pct
                            STATE["install_progress"]["message"] = desc
                        matched_stage = True
                        break

                if matched_stage:
                    send_rpc_event("env.progress", STATE["install_progress"])

            p.wait()
        except Exception as e:
            with STATE["lock"]:
                STATE["install_progress"]["message"] = f"环境安装异常: {str(e)}"
            send_rpc_event("env.progress", STATE["install_progress"])

    # 启动 ComfyUI 后台守护进程 (若未启动)
    try:
        import urllib.request
        try:
            urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=2)
            comfy_running = True
        except Exception:
            comfy_running = False

        if not comfy_running and os.path.exists("/content/ComfyUI/main.py"):
            subprocess.Popen(
                ["python3", "/content/ComfyUI/main.py", "--listen", "127.0.0.1", "--port", "8188"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            # 等待就绪最多 30 秒
            for _ in range(30):
                time.sleep(1)
                try:
                    urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=2)
                    break
                except Exception:
                    pass
    except Exception:
        pass

    # 标记就绪
    with STATE["lock"]:
        STATE["env_ready"] = True
        STATE["lifecycle"] = "IDLE"
        STATE["status"] = "IDLE"
        STATE["install_progress"]["percent"] = 100
        STATE["install_progress"]["stage"] = "ready"
        STATE["install_progress"]["message"] = "MiniMax-H3 / Image 推理环境已完全就绪！"

    send_rpc_event("env.ready", {
        "status": "ready",
        "gpu": get_gpu_info(),
        "tasks_pending_dir": PENDING_DIR
    })

def execute_task_packet(task_data: dict, task_work_dir: str) -> dict:
    """执行单个任务包 (文生图或图生视频)"""
    task_id = task_data.get("taskId") or task_data.get("task_id", f"t_{int(time.time())}")
    task_type = task_data.get("taskType") or task_data.get("task_type", "video_gen")
    params = task_data.get("params", {})
    t0 = time.time()

    # 确定持久化落盘路径
    target_dir = DRIVE_OUTPUT_DIR if os.path.exists("/content/drive/MyDrive") else LOCAL_OUTPUT_DIR
    os.makedirs(target_dir, exist_ok=True)

    def progress_callback(pct: int, step_name: str, message: str, extra: Optional[dict] = None):
        elapsed = round(time.time() - t0, 1)
        prog_data = {
            "taskId": task_id,
            "task_id": task_id,
            "taskType": task_type,
            "percent": pct,
            "step": step_name,
            "message": message,
            "elapsedSec": elapsed,
            "extra": extra or {}
        }
        with STATE["lock"]:
            STATE["current_progress"] = prog_data
        send_rpc_event("task.progress", prog_data)

    progress_callback(5, "init", f"开始执行 {task_type} 任务: {task_id}")

    # 导入推理引擎
    sys.path.append("/content")
    sys.path.append("/content/clipforge/colab")
    import minimax_engine

    if task_type == "image_grid_gen":
        # 1. MiniMax-H3-Image 文生图 / 3x3 九宫格大图
        output_file = os.path.join(target_dir, f"{task_id}_grid.png")
        prompt = params.get("prompt", "High quality commercial product display")
        ref_images = params.get("refImages", [])
        shots = params.get("shots", [])

        minimax_engine.generate_grid_image(
            prompt=prompt,
            output_path=output_file,
            ref_images=ref_images,
            shots=shots,
            progress_callback=progress_callback
        )
        elapsed = round(time.time() - t0, 2)
        return {
            "taskId": task_id,
            "task_id": task_id,
            "taskType": task_type,
            "status": "completed",
            "outputFile": output_file,
            "drive_file": output_file,
            "driveFile": output_file,
            "elapsedSec": elapsed,
            "fileSize": os.path.getsize(output_file) if os.path.exists(output_file) else 0
        }

    elif task_type == "video_gen":
        # 2. MiniMax-H3 图生视频 (首帧锚定 + 4步 DMAD 运镜)
        output_file = os.path.join(target_dir, f"{task_id}_video.mp4")
        prompt = params.get("prompt", "Smooth dynamic camera movement, commercial quality")
        duration_sec = params.get("durationSec", 4.0)
        steps = params.get("steps", 4)
        use_4step_lora = params.get("use4StepLora", True)

        # 寻找首帧图片 (支持直接传入文件路径、同目录相对路径或 Base64)
        keyframe_path = params.get("keyframePath")
        if not keyframe_path and params.get("keyframeImage"):
            cand = os.path.join(task_work_dir, params["keyframeImage"])
            if os.path.exists(cand):
                keyframe_path = cand

        # 兼容 keyframeBase64 与 keyframeB64
        keyframe_b64 = params.get("keyframeB64") or params.get("keyframeBase64")
        if keyframe_b64 and not keyframe_path:
            b64_file = os.path.join(task_work_dir, "input_keyframe.png")
            try:
                import base64
                with open(b64_file, "wb") as bf:
                    bf.write(base64.b64decode(keyframe_b64))
                keyframe_path = b64_file
            except Exception:
                pass

        minimax_engine.generate_video_clip(
            prompt=prompt,
            keyframe_path=keyframe_path,
            keyframe_b64=keyframe_b64,
            duration_sec=duration_sec,
            output_path=output_file,
            progress_callback=progress_callback,
            steps=steps,
            use_4step_lora=use_4step_lora
        )
        elapsed = round(time.time() - t0, 2)
        return {
            "taskId": task_id,
            "task_id": task_id,
            "taskType": task_type,
            "status": "completed",
            "outputFile": output_file,
            "drive_file": output_file,
            "driveFile": output_file,
            "elapsedSec": elapsed,
            "fileSize": os.path.getsize(output_file) if os.path.exists(output_file) else 0
        }

    else:
        raise ValueError(f"未知的任务类型: {task_type}")

def task_directory_scanner_thread():
    """后台任务扫描线程：按时间戳顺序轮询消费 /content/tasks/pending/ 目录下的任务"""
    while True:
        try:
            if not STATE["env_ready"]:
                time.sleep(1)
                continue

            # 检索 pending 目录下的条目 (支持目录包或单个 .json 文件)
            entries = os.listdir(PENDING_DIR) if os.path.exists(PENDING_DIR) else []
            entries.sort()  # 按文件名前缀（时间戳/序号）严格排序

            if entries:
                entry_name = entries[0]
                entry_path = os.path.join(PENDING_DIR, entry_name)
                running_path = os.path.join(RUNNING_DIR, entry_name)
                completed_path = os.path.join(COMPLETED_DIR, entry_name)
                failed_path = os.path.join(FAILED_DIR, entry_name)

                # 原子性移动至 running/
                try:
                    shutil.move(entry_path, running_path)
                except Exception:
                    time.sleep(1)
                    continue

                # 读取任务元数据
                task_data = {}
                work_dir = running_path
                if os.path.isdir(running_path):
                    task_json_file = os.path.join(running_path, "task.json")
                    if os.path.exists(task_json_file):
                        with open(task_json_file, "r", encoding="utf-8") as f:
                            task_data = json.load(f)
                elif running_path.endswith(".json"):
                    with open(running_path, "r", encoding="utf-8") as f:
                        task_data = json.load(f)
                    work_dir = os.path.dirname(running_path)

                task_id = task_data.get("taskId") or task_data.get("task_id", entry_name)

                with STATE["lock"]:
                    STATE["lifecycle"] = "BUSY"
                    STATE["status"] = "BUSY"
                    STATE["current_task"] = task_data

                send_rpc_event("task.started", {
                    "taskId": task_id,
                    "taskType": task_data.get("taskType", "unknown"),
                    "task": task_data
                })

                # 智能自愈与重试 1 次机制 (防止偶尔 CUDA OOM 或 ComfyUI 卡死直接中断队列)
                result = None
                max_retries = 1
                for attempt in range(max_retries + 1):
                    try:
                        result = execute_task_packet(task_data, work_dir)
                        break
                    except Exception as e:
                        if attempt < max_retries:
                            print(f"[RETRY] 任务 {task_id} 执行遇到异常，触发显存自愈并重试: {e}", flush=True)
                            send_rpc_event("task.progress", {
                                "taskId": task_id,
                                "taskType": task_data.get("taskType", "unknown"),
                                "percent": 10,
                                "step": "recovering",
                                "message": f"遇到显存或推理抖动，正在自愈清理显存并重新尝试 (1/{max_retries})..."
                            })
                            heal_cuda_environment()
                            time.sleep(2)
                        else:
                            raise e

                try:
                    # 执行成功：移动到 completed 目录
                    shutil.move(running_path, completed_path)
                    # 写出 result.json
                    if os.path.isdir(completed_path):
                        with open(os.path.join(completed_path, "result.json"), "w", encoding="utf-8") as rf:
                            json.dump(result, rf, ensure_ascii=False, indent=2)

                    send_rpc_event("task.completed", result)

                except Exception as e:
                    err_msg = str(e)
                    result = {"taskId": task_id, "status": "failed", "error": err_msg}
                    try:
                        shutil.move(running_path, failed_path)
                    except Exception:
                        pass
                    send_rpc_event("task.failed", result)

                finally:
                    with STATE["lock"]:
                        STATE["lifecycle"] = "IDLE"
                        STATE["status"] = "IDLE"
                        STATE["current_task"] = None
                        STATE["current_progress"] = {
                            "taskId": None,
                            "taskType": None,
                            "percent": 100 if result and result.get("status") == "completed" else 0,
                            "step": "idle",
                            "message": "空闲等待任务中",
                            "elapsedSec": 0.0,
                            "extra": {}
                        }

            else:
                # 队列暂空，休眠 1 秒
                time.sleep(1)

        except Exception as e:
            time.sleep(2)

def check_comfyui_has_active_prompt() -> bool:
    """检查 ComfyUI 是否有正在运行或排队的 Prompt"""
    try:
        req = urllib.request.Request("http://127.0.0.1:8188/queue", headers={"User-Agent": "ClipForge"})
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            running = data.get("queue_running", [])
            pending = data.get("queue_pending", [])
            return len(running) > 0 or len(pending) > 0
    except Exception:
        return False

def check_active_generation_processes() -> bool:
    """检查系统层是否有 ffmpeg、minimax_engine 或 comfyui 活跃计算进程"""
    try:
        res = subprocess.run(["pgrep", "-f", "ffmpeg|minimax_engine"], capture_output=True)
        return res.returncode == 0 and bool(res.stdout.strip())
    except Exception:
        return False

def check_is_busy_multi_factor() -> tuple:
    """
    多维智能忙碌感知：
    1. 内部生命周期状态：STATE["status"] == "BUSY" 或未安装完成 (STATE["lifecycle"] == "INSTALLING_MODELS" 或 not STATE["env_ready"])
    2. 任务队列目录：/content/tasks/pending 或 /content/tasks/running 存在待处理或执行中的文件
    3. ComfyUI 内部队列：正在执行 prompt 或有排队
    4. GPU 计算核心负载：利用率 > 5.0%
    5. 核心渲染进程：ffmpeg、minimax_engine 正在活跃运行
    只要满足任一条件，即判定为 BUSY 并无条件冻结看门狗！
    """
    # 维度 1: 内部状态
    if STATE["status"] == "BUSY":
        return True, "正在执行任务 (STATE=BUSY)"
    if not STATE["env_ready"] or STATE["lifecycle"] == "INSTALLING_MODELS":
        return True, "正在安装环境/下载模型权重"

    # 维度 2: 任务队列目录
    if os.path.exists(RUNNING_DIR) and len(os.listdir(RUNNING_DIR)) > 0:
        return True, "任务目录 running/ 存在活跃任务包"
    if os.path.exists(PENDING_DIR) and len(os.listdir(PENDING_DIR)) > 0:
        return True, "任务目录 pending/ 存在待分发任务包"

    # 维度 3: ComfyUI 队列
    if check_comfyui_has_active_prompt():
        return True, "ComfyUI 内部队列正在执行扩散推理"

    # 维度 4: GPU 核心负载 (GPU 利用率 > 5% 判定为活跃计算中)
    gpu_util = _CACHED_METRICS.get("gpu", {}).get("utilizationPercent", 0.0)
    if gpu_util > 5.0:
        return True, f"GPU 活跃计算中 (利用率: {gpu_util}%)"

    # 维度 5: 核心渲染进程
    if check_active_generation_processes():
        return True, "检测到活跃的多媒体渲染进程 (ffmpeg/minimax_engine)"

    return False, "空闲"

def metrics_reporter_thread():
    """后台硬件监控指标上报：每 2 秒向本地同步最新硬件与看门狗状态"""
    while True:
        time.sleep(2)
        try:
            pending_count = len(os.listdir(PENDING_DIR)) if os.path.exists(PENDING_DIR) else 0
            is_busy, busy_reason = check_is_busy_multi_factor()

            with STATE["lock"]:
                STATE["install_progress"]["speed_mbps"] = _CACHED_METRICS.get("net", {}).get("downloadSpeedMbps", 0.0)
                send_rpc_event("system.metrics", {
                    "sessionName": STATE["session_name"],
                    "lifecycle": STATE["lifecycle"],
                    "status": STATE["status"],
                    "currentTask": STATE["current_task"],
                    "currentProgress": STATE["current_progress"],
                    "pendingTasksCount": pending_count,
                    "watchdog": {
                        "idleSecondsLeft": STATE["idle_seconds_left"],
                        "isFrozen": is_busy
                    },
                    "installProgress": STATE["install_progress"],
                    "hardware": _CACHED_METRICS
                })
        except Exception:
            pass

def idle_watchdog_thread():
    """两阶段多维看门狗：BUSY、模型下载、GPU 负载、ComfyUI 队列与渲染进程存活期间彻底冻结计时，连续空闲 15 分钟自动释放"""
    print(f"[WATCHDOG-2] 多维智能看门狗激活，空闲阈值: {STATE['idle_timeout_seconds']} 秒 (15分钟)", flush=True)
    last_reason = ""
    while True:
        time.sleep(1)
        now = time.time()

        # 绝对生命周期硬上限检查 (4 小时)
        if now - STATE["started_at"] > STATE["max_lifetime_seconds"]:
            print("[WATCHDOG] 触发实例硬性绝对寿命上限 (4小时)，强制关机防超额扣费！", flush=True)
            try:
                from google.colab import runtime
                runtime.unassign()
            except Exception:
                os._exit(0)

        is_busy, busy_reason = check_is_busy_multi_factor()

        with STATE["lock"]:
            if is_busy:
                # 忙碌状态：重置并彻底冻结倒计时！
                STATE["idle_seconds_left"] = STATE["idle_timeout_seconds"]
                if busy_reason != last_reason:
                    print(f"[WATCHDOG] 忙碌状态锁定 (倒计时冻结): {busy_reason}", flush=True)
                    last_reason = busy_reason
            else:
                last_reason = ""
                STATE["idle_seconds_left"] -= 1
                if STATE["idle_seconds_left"] <= 0:
                    print(f"[WATCHDOG] 实例连续空闲达到 {STATE['idle_timeout_seconds']//60} 分钟且无任何后台活动！正在执行安全释放...", flush=True)
                    try:
                        from google.colab import runtime
                        runtime.unassign()
                    except Exception:
                        os._exit(0)

def handle_stdin_rpc():
    """主线程：处理标准输入的 JSON-RPC 请求，通过 process_rpc_frame 与异步响应机制杜绝阻塞"""
    try:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                resp = process_rpc_frame(req)
                if resp:
                    send_rpc_raw(resp)
            except Exception as e:
                err_resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": str(e)}}
                send_rpc_raw(err_resp)
    except Exception:
        pass

    # 若 stdin 结束（如作为无头 daemon 运行），主线程持续常驻，等待看门狗超时或外部请求
    while True:
        time.sleep(1)

def main():
    parser = argparse.ArgumentParser(description="ClipForge Colab Protocol Runner")
    parser.add_argument("--session-name", default="clipforge_default", help="专属 Session 标识")
    parser.add_argument("--idle-timeout", type=int, default=15, help="空闲超时分钟数 (默认 15 分钟)")
    parser.add_argument("--skip-install", action="store_true", help="跳过模型下载与环境安装 (调试用)")
    args = parser.parse_args()

    STATE["session_name"] = args.session_name
    STATE["idle_timeout_seconds"] = args.idle_timeout * 60
    STATE["idle_seconds_left"] = STATE["idle_timeout_seconds"]

    # 0. 启动标准输出独占守护线程与异步硬件指标采样线程 (保证双向通信绝不阻塞)
    t_writer = threading.Thread(target=_stdout_writer_daemon, daemon=True)
    t_writer.start()
    t_collector = threading.Thread(target=metrics_collector_daemon, daemon=True)
    t_collector.start()

    # 0.1 若环境支持 FastAPI 则启动 Web 服务与 Cloudflare 隧道 (释放 colab ssh 单连接限制)
    if HAS_FASTAPI:
        def _fastapi_thread_func():
            global _LOOP
            _LOOP = asyncio.new_event_loop()
            asyncio.set_event_loop(_LOOP)
            config = uvicorn.Config(app, host="127.0.0.1", port=8000, log_level="warning", loop="asyncio")
            server = uvicorn.Server(config)
            _LOOP.run_until_complete(server.serve())

        t_api = threading.Thread(target=_fastapi_thread_func, daemon=True)
        t_api.start()

        t_tunnel = threading.Thread(target=start_cloudflared_tunnel_daemon, args=(8000,), daemon=True)
        t_tunnel.start()

    # 1. 创建工作目录
    ensure_directories()

    # 2. 开机第 1 秒：立即向本地发送握手成功通知！
    send_rpc_event("handshake.ready", {
        "sessionName": args.session_name,
        "message": "ClipForge 云端双向通信服务已成功连通！",
        "gpu": get_gpu_info(),
        "completedTasks": get_completed_tasks_summary()
    })

    # 3. 启动受控后台模型/环境安装线程
    if not args.skip_install:
        t_install = threading.Thread(target=run_environment_installer, daemon=True)
        t_install.start()
    else:
        STATE["env_ready"] = True
        STATE["lifecycle"] = "IDLE"
        STATE["status"] = "IDLE"

    # 4. 启动目录任务扫描器线程 (/content/tasks/pending/)
    t_scanner = threading.Thread(target=task_directory_scanner_thread, daemon=True)
    t_scanner.start()

    # 5. 启动指标上报线程 (每 2 秒)
    t_metrics = threading.Thread(target=metrics_reporter_thread, daemon=True)
    t_metrics.start()

    # 6. 启动动态忙闲看门狗线程
    t_wd = threading.Thread(target=idle_watchdog_thread, daemon=True)
    t_wd.start()

    # 7. 主线程处理 stdin JSON-RPC 消息
    handle_stdin_rpc()

if __name__ == "__main__":
    main()
