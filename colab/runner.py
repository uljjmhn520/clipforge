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

# 全局网络流量采样
_LAST_NET_BYTES = 0
_LAST_NET_TIME = time.time()

def send_rpc_event(method: str, params: Dict[str, Any]):
    """向标准输出投递异步通知事件 (JSON-RPC Notification)"""
    event = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params
    }
    try:
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass

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
            res_file = os.path.join(p, "result.json")
            if os.path.exists(res_file):
                try:
                    with open(res_file, "r", encoding="utf-8") as rf:
                        summary.append(json.load(rf))
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
        send_rpc_event("task.progress", {
            "taskId": task_id,
            "taskType": task_type,
            "percent": pct,
            "step": step_name,
            "message": message,
            "elapsedSec": round(time.time() - t0, 1),
            "extra": extra or {}
        })

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
            "taskType": task_type,
            "status": "completed",
            "outputFile": output_file,
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
            "taskType": task_type,
            "status": "completed",
            "outputFile": output_file,
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

            else:
                # 队列暂空，休眠 1 秒
                time.sleep(1)

        except Exception as e:
            time.sleep(2)

def metrics_reporter_thread():
    """后台硬件监控指标上报：每 2 秒向本地同步最新 CPU/GPU/显存/网络与看门狗状态"""
    while True:
        time.sleep(2)
        try:
            cpu_pct = get_cpu_percent()
            ram_info = get_ram_info()
            gpu_info = get_gpu_info()
            net_mbps = get_net_download_mbps()

            # 计算队列中的任务数量
            pending_count = len(os.listdir(PENDING_DIR)) if os.path.exists(PENDING_DIR) else 0

            with STATE["lock"]:
                STATE["install_progress"]["speed_mbps"] = net_mbps
                send_rpc_event("system.metrics", {
                    "sessionName": STATE["session_name"],
                    "lifecycle": STATE["lifecycle"],
                    "status": STATE["status"],
                    "currentTask": STATE["current_task"],
                    "pendingTasksCount": pending_count,
                    "watchdog": {
                        "idleSecondsLeft": STATE["idle_seconds_left"],
                        "isFrozen": STATE["status"] == "BUSY" or not STATE["env_ready"]
                    },
                    "installProgress": STATE["install_progress"],
                    "hardware": {
                        "cpu": {
                            "percent": cpu_pct,
                            "note": "GPU 推理或网络下载中，CPU 负载较低属正常现象"
                        },
                        "ram": ram_info,
                        "gpu": gpu_info,
                        "net": {
                            "downloadSpeedMbps": net_mbps
                        }
                    }
                })
        except Exception:
            pass

def idle_watchdog_thread():
    """两阶段看门狗：BUSY 与环境安装中计时彻底冻结，IDLE 默认 5 分钟自动安全关机"""
    print(f"[WATCHDOG-2] 忙闲看门狗激活，空闲阈值: {STATE['idle_timeout_seconds']} 秒", flush=True)
    while True:
        time.sleep(1)
        now = time.time()

        # 绝对生命周期硬上限检查
        if now - STATE["started_at"] > STATE["max_lifetime_seconds"]:
            print("[WATCHDOG] 触发实例硬性绝对寿命上限 (4小时)，强制关机防超额扣费！", flush=True)
            try:
                from google.colab import runtime
                runtime.unassign()
            except Exception:
                os._exit(0)

        # 忙闲倒计时计算
        with STATE["lock"]:
            if STATE["status"] == "BUSY" or not STATE["env_ready"]:
                # 忙时或未安装完毕：重置并冻结倒计时！
                STATE["idle_seconds_left"] = STATE["idle_timeout_seconds"]
            else:
                STATE["idle_seconds_left"] -= 1
                if STATE["idle_seconds_left"] <= 0:
                    print("[WATCHDOG] 实例空闲超时达到 5 分钟！正在执行关机释放...", flush=True)
                    try:
                        from google.colab import runtime
                        runtime.unassign()
                    except Exception:
                        os._exit(0)

def handle_stdin_rpc():
    """主线程：处理标准输入的 JSON-RPC 请求"""
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method")
            params = req.get("params", {})

            if method == "heartbeat.ping":
                with STATE["lock"]:
                    resp = {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "pong": True,
                            "sessionName": STATE["session_name"],
                            "lifecycle": STATE["lifecycle"],
                            "state": STATE["status"],
                            "currentTask": STATE["current_task"],
                            "idleSecondsLeft": STATE["idle_seconds_left"],
                            "envReady": STATE["env_ready"],
                            "completedTasks": get_completed_tasks_summary(),
                            "installProgress": STATE["install_progress"],
                            "hardware": {
                                "cpu": {"percent": get_cpu_percent()},
                                "ram": get_ram_info(),
                                "gpu": get_gpu_info()
                            }
                        }
                    }
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()

            elif method == "watchdog.extend":
                add_sec = int(params.get("seconds", 900))  # 默认加 15 分钟
                with STATE["lock"]:
                    STATE["idle_seconds_left"] += add_sec
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"extended": True, "idleSecondsLeft": STATE["idle_seconds_left"]}
                }
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()

            elif method == "watchdog.shutdown":
                resp = {"jsonrpc": "2.0", "id": req_id, "result": {"shuttingDown": True}}
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
                try:
                    from google.colab import runtime
                    runtime.unassign()
                except Exception:
                    os._exit(0)

            elif method == "task.submit":
                # 直接通过 RPC 投递任务
                task_id = params.get("taskId") or f"rpc_{int(time.time()*1000)}"
                task_file = os.path.join(PENDING_DIR, f"{int(time.time())}_{task_id}.json")
                with open(task_file, "w", encoding="utf-8") as f:
                    json.dump(params, f, ensure_ascii=False, indent=2)
                resp = {"jsonrpc": "2.0", "id": req_id, "result": {"queued": True, "taskId": task_id}}
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()

        except Exception as e:
            err_resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32603, "message": str(e)}}
            sys.stdout.write(json.dumps(err_resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()

def main():
    parser = argparse.ArgumentParser(description="ClipForge Colab Protocol Runner")
    parser.add_argument("--session-name", default="clipforge_default", help="专属 Session 标识")
    parser.add_argument("--idle-timeout", type=int, default=5, help="空闲超时分钟数")
    parser.add_argument("--skip-install", action="store_true", help="跳过模型下载与环境安装 (调试用)")
    args = parser.parse_args()

    STATE["session_name"] = args.session_name
    STATE["idle_timeout_seconds"] = args.idle_timeout * 60
    STATE["idle_seconds_left"] = STATE["idle_timeout_seconds"]

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
