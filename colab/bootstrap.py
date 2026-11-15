#!/usr/bin/env python3
"""
Colab 专属启动与初始化引导器 (bootstrap.py)
---------------------------------------
职责：
1. 立即启动【阶段 1 启动看门狗】(默认 15 分钟)，防止初始化/依赖下载卡死无限制扣费；
2. 自动挂载 Google Drive，建立持久化输出目录；
3. 检测 GPU 规格 (默认推荐 L4，亦兼容 A100)；
4. 完成初始化后打印 [SERVER_READY]，移交控制权给 runner.py。
"""

import os
import sys
import time
import threading
import argparse

def start_boot_watchdog(timeout_minutes: int):
    """阶段 1 看门狗：若在 timeout_minutes 内未完成初始化，强行释放实例断开扣费"""
    def watchdog_target():
        print(f"[WATCHDOG-1] 启动初始化保护已激活，超时阈值: {timeout_minutes} 分钟", flush=True)
        time.sleep(timeout_minutes * 60)
        print("[WATCHDOG-1] 警告：初始化阶段超过时限！判定为网络或下载卡死，执行强制关机释放实例！", flush=True)
        try:
            from google.colab import runtime
            runtime.unassign()
        except Exception as e:
            print(f"[WATCHDOG-1] 释放实例失败: {e}", flush=True)
            os._exit(1)

    t = threading.Thread(target=watchdog_target, daemon=True)
    t.start()
    return t

def setup_google_drive(output_dir: str):
    """挂载 Google Drive 并初始化输出目录"""
    print("[INIT] 正在挂载 Google Drive...", flush=True)
    try:
        from google.colab import drive
        drive.mount('/content/drive')
        os.makedirs(output_dir, exist_ok=True)
        print(f"[INIT] Google Drive 挂载成功，视频持久化落盘目录: {output_dir}", flush=True)
    except Exception as e:
        print(f"[WARN] Google Drive 挂载跳过或失败 (本地模拟模式?): {e}", flush=True)
        os.makedirs(output_dir, exist_ok=True)

def verify_gpu():
    """检测 GPU 环境"""
    try:
        import torch
        if torch.cuda.is_available():
            gpu_name = torch.cuda.get_device_name(0)
            vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            print(f"[GPU] 检测到可用加速卡: {gpu_name} (显存: {vram_gb:.1f} GB)", flush=True)
        else:
            print("[WARN] 未检测到 CUDA GPU！请在 Colab 顶部菜单修改运行时类型为 GPU (L4 或 A100)！", flush=True)
    except ImportError:
        print("[INIT] PyTorch 尚未就绪，稍后验证 GPU", flush=True)

def main():
    parser = argparse.ArgumentParser(description="ClipForge Colab Bootstrap")
    parser.add_argument("--session-name", default="clipforge_default", help="专属 Session 标识")
    parser.add_argument("--boot-timeout", type=int, default=15, help="阶段 1 启动超时分钟数")
    parser.add_argument("--idle-timeout", type=int, default=5, help="阶段 2 空闲超时分钟数")
    parser.add_argument("--drive-dir", default="/content/drive/MyDrive/ClipForge/outputs", help="Drive 存储路径")
    args = parser.parse_args()

    # 1. 第 1 秒激活启动看门狗！
    start_boot_watchdog(args.boot_timeout)

    print(f"==================================================", flush=True)
    print(f"  ClipForge 云端推理节点启动中", flush=True)
    print(f"  Session 绑定: {args.session_name}", flush=True)
    print(f"==================================================", flush=True)

    # 2. 挂载 Google Drive
    setup_google_drive(args.drive_dir)

    # 3. 验证 GPU
    verify_gpu()

    # 4. 创建初始通信文件
    inbox_path = "/content/inbox.jsonl"
    outbox_path = "/content/outbox.jsonl"
    if not os.path.exists(inbox_path):
        with open(inbox_path, "w", encoding="utf-8") as f:
            pass
    if not os.path.exists(outbox_path):
        with open(outbox_path, "w", encoding="utf-8") as f:
            pass

    print("[SERVER_READY] 阶段 1 初始化完成！交由 runner.py 启动核心协议监听器", flush=True)

if __name__ == "__main__":
    main()
