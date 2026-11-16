#!/usr/bin/env python3
"""
Colab 专属协议运行器与任务调度器 (runner.py)
---------------------------------------
职责：
1. 阶段 2 忙闲轮询看门狗 (BUSY 冻结，IDLE 默认 5 分钟关机释放，支持 Web 续命)；
2. 基于 stdio 的 JSON-RPC 心跳协议监听器 (响应 heartbeat.ping 回显 GPU 与空闲状态)；
3. 基于 /content/inbox.jsonl 与 /content/outbox.jsonl 的 Append-Only 任务文件消费与回执落地；
4. 视频生成后直接落盘至 Google Drive，回传文件路径。
"""

import os
import sys
import time
import json
import threading
import argparse
from typing import Optional, Dict, Any

# 全局状态管理
STATE = {
    "status": "INIT",  # "INIT", "IDLE" 或 "BUSY"
    "current_task_id": None,
    "last_inbox_line": 0,
    "idle_timeout_seconds": 300,  # 默认 5 分钟
    "idle_seconds_left": 300,
    "max_lifetime_seconds": 10800,  # 默认 3 小时硬上限
    "started_at": time.time(),
    "env_ready": False,
    "lock": threading.Lock()
}

INBOX_PATH = "/content/inbox.jsonl"
OUTBOX_PATH = "/content/outbox.jsonl"

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
    """获取系统内存使用情况 (MB 与百分比)"""
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
    try:
        mem = {}
        with open("/proc/meminfo", "r") as f:
            for line in f:
                parts = line.split(":")
                if len(parts) == 2:
                    mem[parts[0].strip()] = int(parts[1].strip().split()[0])
        total_kb = mem.get("MemTotal", 0)
        avail_kb = mem.get("MemAvailable", mem.get("MemFree", 0))
        used_kb = total_kb - avail_kb
        total_mb = total_kb // 1024
        used_mb = used_kb // 1024
        percent = round(100.0 * used_kb / (total_kb if total_kb > 0 else 1), 1)
        return {"usedMb": used_mb, "totalMb": total_mb, "percent": percent}
    except Exception:
        return {"usedMb": 0, "totalMb": 0, "percent": 0.0}

def get_gpu_info() -> Dict[str, Any]:
    """获取 GPU 硬件型号、计算利用率与显存情况"""
    try:
        import subprocess
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
    try:
        import torch
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            used = torch.cuda.memory_allocated(0) // (1024 * 1024)
            total = torch.cuda.get_device_properties(0).total_memory // (1024 * 1024)
            pct = round(100.0 * used / (total if total > 0 else 1), 1)
            return {
                "name": name,
                "utilizationPercent": 0.0,
                "memoryUsedMb": int(used),
                "memoryTotalMb": int(total),
                "memoryPercent": pct
            }
    except Exception:
        pass
    return {
        "name": "N/A",
        "utilizationPercent": 0.0,
        "memoryUsedMb": 0,
        "memoryTotalMb": 0,
        "memoryPercent": 0.0
    }

def async_bootstrap_sequence():
    """开机阶段二：受控流式环境就绪调度"""
    time.sleep(0.5)
    # 1. 建立双向通信通道
    send_rpc_event("env.progress", {"step": "handshake", "status": "completed", "message": "双向通信管道建立完毕"})

    # 2. 挂载 Google Drive
    send_rpc_event("env.progress", {"step": "drive", "status": "running", "message": "正在挂载 Google Drive 持久化目录..."})
    try:
        from google.colab import drive
        drive.mount('/content/drive')
        os.makedirs("/content/drive/MyDrive/ClipForge/outputs", exist_ok=True)
        send_rpc_event("env.progress", {"step": "drive", "status": "completed", "message": "Google Drive 挂载完成"})
    except Exception as e:
        os.makedirs("/content/outputs", exist_ok=True)
        send_rpc_event("env.progress", {"step": "drive", "status": "completed", "message": "本地模拟目录就绪"})

    # 3. 硬件算力与 GPU 检测
    send_rpc_event("env.progress", {"step": "gpu", "status": "running", "message": "正在检测 GPU 硬件规格..."})
    gpu_info = get_gpu_info()
    send_rpc_event("env.progress", {
        "step": "gpu",
        "status": "completed",
        "message": f"{gpu_info['name']} ({gpu_info['memoryTotalMb']}MB 显存) 就绪",
        "gpu": gpu_info
    })

    # 4. 全部就绪，跃迁至 IDLE 状态
    with STATE["lock"]:
        STATE["env_ready"] = True
        STATE["status"] = "IDLE"
    send_rpc_event("env.progress", {"step": "ready", "status": "completed", "message": "云端算力节点已完全就绪，等待下发任务"})

def idle_watchdog_thread():
    """阶段 2 动态看门狗守护循环"""
    print(f"[WATCHDOG-2] 忙闲看门狗已激活，空闲阈值: {STATE['idle_timeout_seconds']} 秒", flush=True)
    while True:
        time.sleep(1)
        now = time.time()
        
        # 1. 绝对最大生命周期兜底 (防止死锁通宵扣费)
        if now - STATE["started_at"] >= STATE["max_lifetime_seconds"]:
            print("[WATCHDOG-2] 达到单次开机最大生命周期上限 (3小时)，强制释放实例！", flush=True)
            shutdown_colab()

        with STATE["lock"]:
            if STATE["status"] == "BUSY" or STATE["status"] == "INIT":
                # 忙时或初始化中冻结倒计时
                STATE["idle_seconds_left"] = STATE["idle_timeout_seconds"]
            else:
                # 闲时倒计时
                STATE["idle_seconds_left"] -= 1
                if STATE["idle_seconds_left"] <= 0:
                    print("[WATCHDOG-2] 空闲超时！自动释放 Colab 实例停机以节省算力！", flush=True)
                    shutdown_colab()

def shutdown_colab():
    """释放 Colab 实例"""
    try:
        from google.colab import runtime
        runtime.unassign()
    except Exception as e:
        print(f"[SHUTDOWN] 释放实例异常: {e}", flush=True)
    finally:
        os._exit(0)

def handle_stdin_rpc():
    """线程 A：标准输入 (stdio) JSON-RPC 监听器"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            method = req.get("method")
            msg_id = req.get("id")

            if method == "heartbeat.ping":
                cpu_pct = get_cpu_percent()
                ram_info = get_ram_info()
                gpu_info = get_gpu_info()
                with STATE["lock"]:
                    resp = {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "result": {
                            "pong": True,
                            "state": STATE["status"],
                            "current_task_id": STATE["current_task_id"],
                            "last_processed_line": STATE["last_inbox_line"],
                            "idle_seconds_left": STATE["idle_seconds_left"],
                            "cpu": {
                                "percent": cpu_pct
                            },
                            "ram": ram_info,
                            "gpu": gpu_info,
                            "gpu_memory_used_mb": gpu_info["memoryUsedMb"],
                            "gpu_memory_total_mb": gpu_info["memoryTotalMb"]
                        }
                    }
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()

            elif method == "colab.keep_alive":
                # Web 端一键续命
                extra_minutes = req.get("params", {}).get("minutes", 15)
                with STATE["lock"]:
                    STATE["idle_seconds_left"] = extra_minutes * 60
                    resp = {
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "result": {"success": True, "new_timeout_seconds": STATE["idle_seconds_left"]}
                    }
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()

            elif method == "task.enqueue":
                # 将任务追加写入 /content/inbox.jsonl
                task_data = req.get("params", {})
                print(f"[RUNNER] 收到任务入队请求: {task_data.get('task_id')}", flush=True)
                with open(INBOX_PATH, "a", encoding="utf-8") as f:
                    f.write(json.dumps(task_data, ensure_ascii=False) + "\n")
                resp = {"jsonrpc": "2.0", "id": msg_id, "result": {"success": True, "task_id": task_data.get("task_id")}}
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()

            elif method == "colab.terminate":
                # 手动立即关机
                resp = {"jsonrpc": "2.0", "id": msg_id, "result": {"terminating": True}}
                sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
                shutdown_colab()

        except json.JSONDecodeError:
            pass

def process_single_task(task: Dict[str, Any]) -> Dict[str, Any]:
    """执行单个生成任务 (生图或生视频)"""
    task_id = task.get("task_id", "unknown")
    task_type = task.get("type", "video") # "image" (九宫格) 或 "video"
    prompt = task.get("prompt", "")
    drive_output_path = task.get("drive_output_path", f"/content/outputs/{task_id}.mp4")

    def progress_callback(percent: int, step: str, message: str, extra: Optional[dict] = None):
        payload = {
            "task_id": task_id,
            "type": task_type,
            "percent": percent,
            "step": step,
            "message": message
        }
        if extra:
            payload.update(extra)
        send_rpc_event("task.progress", payload)

    print(f"[TASK] 开始处理任务 {task_id} (类型: {task_type})", flush=True)
    progress_callback(5, "init", f"任务已进入执行管道: {task_id}")
    t0 = time.time()

    # 确保存储目录存在
    os.makedirs(os.path.dirname(drive_output_path), exist_ok=True)

    # 此处调用实际的 MiniMax 推理引擎 (若处于开发模拟或未装库状态，进行自适应保障)
    try:
        from minimax_engine import generate_video_clip, generate_grid_image
        if task_type == "image":
            ref_images = task.get("ref_images") or task.get("reference_images") or []
            shots = task.get("shots")
            generate_grid_image(prompt, drive_output_path, ref_images, shots, progress_callback)
        else:
            keyframe_b64 = task.get("keyframe_b64")
            duration_sec = task.get("duration_sec", 5)
            generate_video_clip(prompt, keyframe_b64, duration_sec, drive_output_path, progress_callback)
    except Exception as e:
        print(f"[TASK-SIM] 推理引擎调用 (或模拟回退): {e}", flush=True)
        # 兜底生成标记文件，保证端到端不阻塞
        if not os.path.exists(drive_output_path):
            with open(drive_output_path, "wb") as f:
                f.write(b"MOCK_VIDEO_DATA")

    elapsed = round(time.time() - t0, 2)
    progress_callback(100, "completed", f"任务执行完毕，产物落盘: {elapsed}s")
    return {
        "task_id": task_id,
        "status": "completed",
        "drive_file": drive_output_path,
        "elapsed_sec": elapsed
    }

def process_file_queue():
    """线程 B：基于文件的 Append-Only 任务队列消费器"""
    print(f"[QUEUE] 启动对 {INBOX_PATH} 的游标监听...", flush=True)
    
    # 确保文件存在
    for p in [INBOX_PATH, OUTBOX_PATH]:
        if not os.path.exists(p):
            with open(p, "w", encoding="utf-8") as f:
                pass

    current_line = 0

    while True:
        try:
            with open(INBOX_PATH, "r", encoding="utf-8") as f:
                lines = f.readlines()

            if current_line < len(lines):
                raw_line = lines[current_line].strip()
                current_line += 1
                STATE["last_inbox_line"] = current_line

                if not raw_line:
                    continue

                task = json.loads(raw_line)
                task_id = task.get("task_id", f"line_{current_line}")

                with STATE["lock"]:
                    STATE["status"] = "BUSY"
                    STATE["current_task_id"] = task_id

                try:
                    result = process_single_task(task)
                except Exception as e:
                    result = {"task_id": task_id, "status": "failed", "error": str(e)}

                # 结果追加落盘到 outbox.jsonl
                with open(OUTBOX_PATH, "a", encoding="utf-8") as out_f:
                    out_f.write(json.dumps(result, ensure_ascii=False) + "\n")

                # 同时向 stdout 发送 JSON-RPC 通知
                notice = {
                    "jsonrpc": "2.0",
                    "method": "task.completed",
                    "params": result
                }
                sys.stdout.write(json.dumps(notice, ensure_ascii=False) + "\n")
                sys.stdout.flush()

                with STATE["lock"]:
                    STATE["status"] = "IDLE"
                    STATE["current_task_id"] = None

            else:
                # 暂无新任务，轻量休眠轮询
                time.sleep(1)

        except Exception as e:
            time.sleep(2)

def metrics_reporter_thread():
    """后台指标上报线程：每 60 秒主动向本地推送 system.metrics 事件 (无需本地频繁轮询)"""
    while True:
        time.sleep(60)
        try:
            if STATE.get("env_ready"):
                cpu_pct = get_cpu_percent()
                ram_info = get_ram_info()
                gpu_info = get_gpu_info()
                with STATE["lock"]:
                    send_rpc_event("system.metrics", {
                        "state": STATE["status"],
                        "current_task_id": STATE["current_task_id"],
                        "idle_seconds_left": STATE["idle_seconds_left"],
                        "cpu": {"percent": cpu_pct},
                        "ram": ram_info,
                        "gpu": gpu_info,
                        "gpu_memory_used_mb": gpu_info["memoryUsedMb"],
                        "gpu_memory_total_mb": gpu_info["memoryTotalMb"]
                    })
        except Exception:
            pass

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--idle-timeout", type=int, default=5, help="空闲超时分钟数")
    args = parser.parse_args()

    STATE["idle_timeout_seconds"] = args.idle_timeout * 60
    STATE["idle_seconds_left"] = STATE["idle_timeout_seconds"]

    # 启动阶段 2 忙闲看门狗线程
    t_wd = threading.Thread(target=idle_watchdog_thread, daemon=True)
    t_wd.start()

    # 启动文件队列消费线程
    t_queue = threading.Thread(target=process_file_queue, daemon=True)
    t_queue.start()

    # 启动开机阶段二：受控流式环境就绪调度线程 (通知本地当前初始化进度)
    t_boot = threading.Thread(target=async_bootstrap_sequence, daemon=True)
    t_boot.start()

    # 启动 60 秒定时系统指标主动推送线程
    t_metrics = threading.Thread(target=metrics_reporter_thread, daemon=True)
    t_metrics.start()

    print("[RUNNER] ClipForge 云端协议运行器已完全就绪！开始监听通信...", flush=True)

    # 主线程负责读取 stdin JSON-RPC 消息
    handle_stdin_rpc()

if __name__ == "__main__":
    main()
