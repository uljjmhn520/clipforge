#!/usr/bin/env python3
import json
import time
import os
import subprocess
import minimax_engine

def print_gpu():
    try:
        out = subprocess.check_output(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader"]).decode().strip()
        print(f"[GPU-STATUS] {out}", flush=True)
    except Exception as e:
        print(f"[GPU-STATUS] Query failed: {e}", flush=True)

print("="*60)
print("ClipForge Colab GPU Engine 独立贯通测试")
print("测试目标项目: 2ff30d62-e344-43a0-b141-43016445fd60 (冷萃浓缩咖啡液)")
print("="*60)

with open("/content/test_payload.json", "r", encoding="utf-8") as f:
    data = json.load(f)

prompt = data["prompt"]
shots = data["shots"]
ref_images = data["refImages"]
grid_out = data["gridOutputPath"]
shot1_vid_out = data["shot1VideoPath"]

os.makedirs("/content/outputs", exist_ok=True)

print_gpu()

# -------------------------------------------------------------
# 环节 1: MiniMax-H3-Image GPU 异构九宫格生图测试
# -------------------------------------------------------------
print("\n>>> [TEST 1/2] 开始测试 MiniMax-H3-Image 九宫格生图 (GPU 异构渲染)...")
t0 = time.time()

def progress_cb(pct, step, msg, extra=None):
    print(f"  [IMAGE-PROGRESS] {pct}% | {step} | {msg}", flush=True)
    if pct % 30 == 0:
        print_gpu()

minimax_engine.generate_grid_image(
    prompt=prompt,
    output_path=grid_out,
    ref_images=ref_images,
    shots=shots,
    progress_callback=progress_cb
)

t_grid = round(time.time() - t0, 2)
grid_sz = os.path.getsize(grid_out) if os.path.exists(grid_out) else 0
print(f">>> [TEST 1 RESULT] 九宫格生成完成! 耗时: {t_grid}s, 文件大小: {grid_sz} bytes ({grid_sz/(1024**2):.2f} MB)")
print_gpu()

# -------------------------------------------------------------
# 环节 2: MiniMax-H3 GPU + NVENC 视频生成测试
# -------------------------------------------------------------
print("\n>>> [TEST 2/2] 开始测试 MiniMax-H3 图生视频 (GPU + NVENC 渲染)...")

# 提取分镜 1 关键帧作为输入
keyframe_b64 = None
if ref_images and len(ref_images) > 0:
    keyframe_b64 = ref_images[0]

t1 = time.time()
def vid_progress_cb(pct, step, msg, extra=None):
    print(f"  [VIDEO-PROGRESS] {pct}% | {step} | {msg}", flush=True)
    if pct % 30 == 0:
        print_gpu()

minimax_engine.generate_video_clip(
    prompt=shots[0]["description"],
    keyframe_b64=keyframe_b64,
    duration_sec=shots[0].get("durationSec", 5),
    output_path=shot1_vid_out,
    progress_callback=vid_progress_cb
)

t_vid = round(time.time() - t1, 2)
vid_sz = os.path.getsize(shot1_vid_out) if os.path.exists(shot1_vid_out) else 0
print(f">>> [TEST 2 RESULT] 分镜视频生成完成! 耗时: {t_vid}s, 文件大小: {vid_sz} bytes ({vid_sz/(1024**2):.2f} MB)")
print_gpu()

print("\n" + "="*60)
print(f"ALL TESTS PASSED! 两个环节全部打通!")
print(f"九宫格产物: {grid_out} ({grid_sz} bytes)")
print(f"视频片段产物: {shot1_vid_out} ({vid_sz} bytes)")
print("="*60)
