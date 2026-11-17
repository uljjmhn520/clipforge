"""
MiniMax-H3 与 MiniMax-H3-Image 真实权重推理引擎封装模块 (minimax_engine.py)
------------------------------------------------------------------
对接运行在 Colab L4 (24GB) 上的 ComfyUI 0.40.0 原生 API:
1. 3x3 九宫格分镜异构大图渲染生成 (MiniMax-H3-Image INT8 扩散模型 + Qwen3VL NVFP4, 6 步 Euler)
2. 分镜关键帧首帧绝对锚定动态视频生成 (MiniMax-H3 Ref2VA INT8, 14 步 res_multistep, 无 DMAD)
3. 实时流式进度反馈回调 (progress_callback) 与产物落盘
"""

import os
import sys
import time
import json
import base64
import urllib.request
import urllib.error
import shutil
from pathlib import Path
from typing import Optional, List, Dict, Any, Callable
from PIL import Image

COMFY_HOST = os.environ.get("COMFY_HOST", "http://127.0.0.1:8188")
COMFY_INPUT_DIR = Path(os.environ.get("COMFY_INPUT_DIR", "/content/ComfyUI/input"))
COMFY_OUTPUT_DIR = Path(os.environ.get("COMFY_OUTPUT_DIR", "/content/ComfyUI/output"))

def check_comfyui_ready(host: str = COMFY_HOST, timeout: int = 5) -> bool:
    """检查 ComfyUI 服务是否已就绪"""
    try:
        req = urllib.request.Request(f"{host}/system_stats")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False

def post_comfy_prompt(graph: dict, host: str = COMFY_HOST) -> str:
    """向 ComfyUI 提交推理任务，返回 prompt_id"""
    payload = json.dumps({"prompt": graph}).encode("utf-8")
    req = urllib.request.Request(
        f"{host}/prompt",
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data["prompt_id"]

def wait_for_comfy_completion(
    prompt_id: str,
    host: str = COMFY_HOST,
    timeout_sec: int = 900,
    poll_interval: int = 3,
    progress_callback: Optional[Callable[[int, str, str, Optional[dict]], None]] = None,
    progress_range: tuple = (10, 90)
) -> dict:
    """轮询等待 ComfyUI prompt 执行完成并返回产物信息"""
    t0 = time.time()
    p_start, p_end = progress_range
    while time.time() - t0 < timeout_sec:
        try:
            req = urllib.request.Request(f"{host}/history/{prompt_id}")
            with urllib.request.urlopen(req, timeout=10) as resp:
                hist = json.loads(resp.read().decode("utf-8"))
                if prompt_id in hist:
                    entry = hist[prompt_id]
                    # 检查是否成功产出
                    outputs = entry.get("outputs", {})
                    status = entry.get("status", {})
                    if status.get("status_str") == "error":
                        raise RuntimeError(f"ComfyUI 执行出错: {status.get('messages')}")
                    if outputs:
                        return outputs
        except urllib.error.URLError:
            pass

        # 进度插值估算
        elapsed = time.time() - t0
        pct = p_start + int(min(0.9, elapsed / (timeout_sec * 0.5)) * (p_end - p_start))
        if progress_callback:
            progress_callback(pct, "running", f"MiniMax GPU 扩散去噪中 (已耗时 {int(elapsed)}s)...", None)

        time.sleep(poll_interval)

    raise TimeoutError(f"ComfyUI 任务 {prompt_id} 超时未完成 ({timeout_sec}s)")

def stage_file_to_comfy(file_path: str, filename_override: Optional[str] = None) -> str:
    """将本地或内存图片/音频复制到 ComfyUI input 目录，返回文件名"""
    COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    src = Path(file_path)
    dest_name = filename_override or src.name
    dest = COMFY_INPUT_DIR / dest_name
    if src.resolve() != dest.resolve():
        shutil.copy2(src, dest)
    return dest_name

def stage_bytes_to_comfy(data: bytes, filename: str) -> str:
    """将二进制数据直接保存到 ComfyUI input 目录"""
    COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = COMFY_INPUT_DIR / filename
    dest.write_bytes(data)
    return filename

# ==============================================================================
# 1. MiniMax-H3-Image 九宫格分镜大图生成 (6 步极速出片)
# ==============================================================================

def build_h3_image_graph(
    prompt: str,
    width: int = 768,
    height: int = 1344,
    steps: int = 6,
    seed: int = 42,
    ref_images: Optional[List[str]] = None,
    prefix: str = "h3_img"
) -> dict:
    """构建 MiniMax-H3-Image ComfyUI 工作流图"""
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "minimax_h3_image_pruned_int8_convrot.safetensors",
            "weight_dtype": "default"
        }},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
            "type": "minimax",
            "device": "default"
        }},
        "3": {"class_type": "VAELoader", "inputs": {
            "vae_name": "minimax_h3_image_vae_fp16.safetensors"
        }},
        "7": {"class_type": "VAEDecode", "inputs": {
            "samples": ["6", 0],
            "vae": ["3", 0]
        }},
        "8": {"class_type": "SaveImage", "inputs": {
            "images": ["7", 0],
            "filename_prefix": prefix
        }}
    }

    if ref_images and len(ref_images) > 0:
        inputs = {
            "clip": ["2", 0],
            "vae": ["3", 0],
            "prompt": prompt,
            "width": width,
            "height": height
        }
        for idx, ref_name in enumerate(ref_images, start=1):
            node_id = str(10 + idx)
            g[node_id] = {"class_type": "LoadImage", "inputs": {"image": ref_name}}
            inputs[f"images.image_{idx}"] = [node_id, 0]

        g["4"] = {"class_type": "MiniMaxH3ImageConditioning", "inputs": inputs}
        g["9"] = {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}}
        g["6"] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "latent_image": ["4", 1],
                "positive": ["4", 0],
                "negative": ["9", 0],
                "seed": seed,
                "steps": steps,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0
            }
        }
    else:
        g["5"] = {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}}
        g["4"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}}
        g["9"] = {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}}
        g["6"] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "latent_image": ["5", 0],
                "positive": ["4", 0],
                "negative": ["9", 0],
                "seed": seed,
                "steps": steps,
                "cfg": 1.0,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0
            }
        }

    return g

def generate_single_frame(
    prompt: str,
    ref_images: Optional[List[str]] = None,
    width: int = 768,
    height: int = 1344,
    steps: int = 6,
    seed: int = 42,
    prefix: str = "frame"
) -> str:
    """渲染单张分镜画格，返回保存的物理图片路径"""
    graph = build_h3_image_graph(prompt, width, height, steps, seed, ref_images, prefix)
    prompt_id = post_comfy_prompt(graph)
    outputs = wait_for_comfy_completion(prompt_id, timeout_sec=180)
    save_node = outputs.get("8", {})
    images = save_node.get("images", [])
    if not images:
        raise RuntimeError("ComfyUI 未返回输出图片")
    filename = images[0]["filename"]
    subfolder = images[0].get("subfolder", "")
    out_path = COMFY_OUTPUT_DIR / subfolder / filename
    return str(out_path)

def generate_grid_image(
    prompt: str,
    output_path: str,
    ref_images: Optional[list] = None,
    shots: Optional[list] = None,
    progress_callback: Optional[Callable[[int, str, str, Optional[dict]], None]] = None
):
    """
    使用 MiniMax-H3-Image 扩散模型生成 3x3 九宫格分镜大图:
    1. 确保商品图与主角肖像立绘就绪；
    2. 对 9 个分镜逐一执行 Multi-reference 条件生图；
    3. 拼接为 3x3 高清大图 (2304x4032) 并保存单格切片。
    """
    print(f"[ENGINE] 启动 MiniMax-H3-Image 真实生图: {output_path}", flush=True)
    if progress_callback:
        progress_callback(5, "init", "正在初始化 MiniMax-H3-Image GPU 引擎并验证 ComfyUI 状态...")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    output_dir = Path(output_path).parent

    # 1. 处理传入的商品参考图
    staged_refs = []
    if ref_images:
        for idx, r in enumerate(ref_images):
            if isinstance(r, str) and r.startswith("data:"):
                # base64 格式
                b64_data = r.split(",", 1)[1] if "," in r else r
                raw = base64.b64decode(b64_data)
                fname = stage_bytes_to_comfy(raw, f"product_ref_{idx}.png")
                staged_refs.append(fname)
            elif isinstance(r, str) and os.path.exists(r):
                fname = stage_file_to_comfy(r, f"product_ref_{idx}.png")
                staged_refs.append(fname)

    # 2. 主角锚定图 (Actor Anchor)
    # 如果用户未传入人物肖像，先使用 MiniMax-H3-Image 纯文本生成一张标准正面带货主角立绘
    actor_ref_name = "ref_actor.png"
    actor_ref_path = COMFY_INPUT_DIR / actor_ref_name
    if not actor_ref_path.exists():
        if progress_callback:
            progress_callback(10, "anchor_actor", "正在生成统一的带货主播正面肖像卡 (Anchor Actor)...")
        actor_prompt = (
            "A high-quality commercial portrait of a young East Asian female office worker in her late 20s, "
            "wearing a clean beige knit cardigan and white shirt, friendly engaging smile, crisp skin texture, "
            "warm natural daylight in modern clean office, 8k resolution, photorealistic, masterpiece"
        )
        actor_img_path = generate_single_frame(actor_prompt, ref_images=None, seed=42, prefix="actor_anchor")
        shutil.copy2(actor_img_path, actor_ref_path)

    # 组合参考：<Picture 1> 主播肖像，<Picture 2> 商品图
    dual_refs = [actor_ref_name]
    if staged_refs:
        dual_refs.append(staged_refs[0])

    # 3. 逐一渲染 9 个分镜
    cell_images = []
    total_shots = 9

    # 9 个标准分镜描述备用
    default_shot_prompts = [
        "Cell 1: Close-up on the desk. The female anchor slaps a $35 coffee delivery receipt onto the wooden desk and sighs looking at the camera.",
        "Cell 2: Medium shot. The anchor leans on the computer desk, rubbing her sleepy eyes and yawning, looking exhausted in the afternoon.",
        "Cell 3: Product reveal. The anchor firmly places a 1L carton of cold brew coffee concentrate on the desk and twists open the white cap.",
        "Cell 4: Demonstration. The anchor pours rich dark coffee concentrate into a glass of oat milk and ice cubes, creating marble layers.",
        "Cell 5: Call to action. The anchor happily sips the iced latte with a straw and points rhythmically to the bottom-left yellow cart icon.",
        "Cell 6: Detail macro. Macro shot of the coffee concentrate carton showing 0 fat 0 sugar label and aromatic nutty crema.",
        "Cell 7: Comparison. Split screen concept showing expensive takeaway coffee cup versus affordable 1L concentrate bottle.",
        "Cell 8: Daily lifestyle. The anchor comfortably carrying the coffee flask out of the elevator into the modern studio.",
        "Cell 9: Brand outro. The anchor holding the finished latte bottle with official genuine warranty badge and fast shipping guarantee."
    ]

    for idx in range(total_shots):
        shot_desc = default_shot_prompts[idx]
        if shots and idx < len(shots) and shots[idx].get("description"):
            shot_desc = f"Shot {idx+1}: {shots[idx]['description']}"

        # 核心提示词：强制锁定 <Picture 1> 人物脸部与服装，并展示 <Picture 2> 咖啡单品
        frame_prompt = (
            f"Edit <Picture 1>. The face, hair and beige clothing of the female character in <Picture 1> are strictly preserved. "
            f"The coffee product package is <Picture 2>. Action: {shot_desc}. Crisp 4k photography, natural lighting, commercial ad."
        )

        pct = 15 + int((idx / total_shots) * 75)
        if progress_callback:
            progress_callback(pct, "rendering_cell", f"正在渲染分镜 #{idx+1}/9 真实画格...")

        frame_path = generate_single_frame(
            prompt=frame_prompt,
            ref_images=dual_refs,
            seed=42 + idx * 7,
            prefix=f"shot_{idx+1}"
        )
        cell_images.append(Image.open(frame_path).convert("RGB"))

        # 保存单格切片关键帧至输出目录
        shot_kf_path = output_dir / f"shot_{idx+1}_keyframe.png"
        shutil.copy2(frame_path, shot_kf_path)

    # 4. 拼贴为 3x3 九宫格大图 (2304x4032)
    if progress_callback:
        progress_callback(92, "stitching", "正在拼装 3x3 商业九宫格大图 (2304x4032)...")

    cw, ch = 768, 1344
    gw, gh = cw * 3, ch * 3
    grid_img = Image.new("RGB", (gw, gh))
    for i, cell_img in enumerate(cell_images):
        col = i % 3
        row = i // 3
        resized_cell = cell_img.resize((cw, ch), Image.Resampling.LANCZOS)
        grid_img.paste(resized_cell, (col * cw, row * ch))

    grid_img.save(output_path, quality=95)
    print(f"[ENGINE] 九宫格大图生成成功: {output_path}", flush=True)

    if progress_callback:
        progress_callback(100, "completed", "MiniMax-H3-Image 九宫格分镜大图与切片渲染完成！")

# ==============================================================================
# 2. MiniMax-H3 视频生成 (图生视频 Ref2VA, 14 步 res_multistep, 无 DMAD)
# ==============================================================================

def build_h3_video_graph(
    prompt: str,
    first_frame_filename: str,
    duration_sec: float = 4.0,
    fps: int = 24,
    seed: int = 42,
    steps: int = 4,
    use_4step_lora: bool = True,
    prefix: str = "cf_h3_video"
) -> dict:
    """构建 MiniMax-H3 官方标准 Ref2VA 图生视频工作流图 (支持 DMAD 4 步极速出片)"""
    # 帧数公式：最小 17n + 5 >= duration * fps
    n = 0
    while 17 * n + 5 < duration_sec * fps:
        n += 1
    frames = 17 * n + 5
    width, height = 768, 1344

    g = {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
            "weight_dtype": "default"
        }},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
            "type": "minimax",
            "device": "default"
        }},
        "3": {"class_type": "VAELoader", "inputs": {
            "vae_name": "minimax_h3_video_vae_fp16.safetensors"
        }},
        "4": {"class_type": "VAELoader", "inputs": {
            "vae_name": "minimax_h3_audio_vae_fp32.safetensors"
        }},
        "5": {"class_type": "LoadImage", "inputs": {
            "image": first_frame_filename
        }},
        "6": {
            "class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": {
                "clip": ["2", 0],
                "vae": ["3", 0],
                "audio_vae": ["4", 0],
                "prompt": prompt,
                "length": frames,
                "width": width,
                "height": height,
                "ref_image_size": "match",
                "ref_images.ref_image_0": ["5", 0]
            }
        },
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "40": {
            "class_type": "MiniMaxH3AddGuide",
            "inputs": {
                "positive": ["6", 0],
                "latent": ["6", 1],
                "vae": ["3", 0],
                "image": ["5", 0],
                "frame_idx": 0
            }
        },
        "12": {"class_type": "VAEDecode", "inputs": {
            "samples": ["11", 0],
            "vae": ["3", 0]
        }},
        "13": {"class_type": "VAEDecodeAudio", "inputs": {
            "samples": ["11", 0],
            "vae": ["4", 0]
        }},
        "14": {"class_type": "CreateVideo", "inputs": {
            "images": ["12", 0],
            "audio": ["13", 0],
            "fps": fps
        }},
        "15": {"class_type": "SaveVideo", "inputs": {
            "video": ["14", 0],
            "filename_prefix": prefix,
            "format": "mp4",
            "codec": "h264"
        }}
    }

    model_ref = ["1", 0]
    sampler_name = "res_multistep"
    if use_4step_lora:
        g["82"] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": ["1", 0],
                "lora_name": "dmad_h3_4step_lora_critic_comfy.safetensors",
                "strength_model": 1.0
            }
        }
        g["83"] = {
            "class_type": "MiniMaxH3SigmaShift",
            "inputs": {
                "model": ["82", 0],
                "shift_video": 12.0,
                "shift_audio": 2.0
            }
        }
        model_ref = ["83", 0]
        sampler_name = "euler"

    g["8"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": sampler_name}}
    g["9"] = {"class_type": "BasicScheduler", "inputs": {
        "model": model_ref,
        "scheduler": "simple",
        "steps": steps,
        "denoise": 1.0
    }}
    g["10"] = {"class_type": "BasicGuider", "inputs": {
        "model": model_ref,
        "conditioning": ["40", 0]
    }}
    g["11"] = {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
            "noise": ["7", 0],
            "guider": ["10", 0],
            "sampler": ["8", 0],
            "sigmas": ["9", 0],
            "latent_image": ["6", 1]
        }
    }

    return g

def generate_video_clip(
    prompt: str,
    keyframe_b64: Optional[str] = None,
    duration_sec: int = 5,
    output_path: str = "/content/output.mp4",
    progress_callback: Optional[Callable[[int, str, str, Optional[dict]], None]] = None,
    keyframe_path: Optional[str] = None,
    steps: int = 4,
    use_4step_lora: bool = True
):
    """
    使用 MiniMax-H3 官方 Ref2VA 模型渲染真实动态运镜视频 (默认 4 步 DMAD 极速出片):
    1. 首帧注入 MiniMaxH3AddGuide(frame_idx=0) 确保绝对吻合分镜；
    2. 挂载 DMAD 4 步 LoRA 与 SigmaShift，约 3~4 分钟极速出片；
    3. 输出 MP4 视频落盘。
    """
    print(f"[ENGINE] 启动 MiniMax-H3 真实视频渲染 (4步加速): {output_path}", flush=True)
    if progress_callback:
        progress_callback(5, "init", "初始化 MiniMax-H3 视频生成流水线 (Ref2VA 4步极速模式)...")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # 1. 暂存首帧图片至 ComfyUI input
    if keyframe_path and os.path.exists(keyframe_path):
        first_frame_name = stage_file_to_comfy(keyframe_path, "h3_video_kf.png")
    elif keyframe_b64:
        b64_str = keyframe_b64.split(",", 1)[1] if "," in keyframe_b64 else keyframe_b64
        raw = base64.b64decode(b64_str)
        first_frame_name = stage_bytes_to_comfy(raw, "h3_video_kf.png")
    else:
        raise ValueError("生成视频必须提供首帧参考图 (keyframe_path 或 keyframe_b64)")

    # 2. 构建官方 6 段式提示词格式
    official_prompt = (
        "subject_definitions:\n"
        "<Subject 1> is the Asian female anchor in a beige cardigan, visible in <Picture 1>.\n"
        "<Picture 1> is the first frame of [Shot 1], fixing the camera position, framing, set layout and lighting.\n\n"
        "summary:\n"
        "A commercial e-commerce product video showcasing the cold brew coffee concentrate.\n\n"
        "retention_analysis:\n"
        "The clothing and facial likeness of <Subject 1> in <Picture 1> remain strictly consistent throughout the video.\n\n"
        "detailed_description:\n"
        f"[Shot 1] At 00:00.000, starting from <Picture 1>, {prompt}\n\n"
        "overall_soundscape:\n"
        "Subtle modern office room tone with faint ambience.\n\n"
        "non_diegetic_music:\n"
        "N/A"
    )

    # 3. 提交 ComfyUI 工作流
    if progress_callback:
        progress_callback(15, "submitting", "已提交 MiniMax-H3 Ref2VA 计算任务至 ComfyUI (4步极速模式)...")

    graph = build_h3_video_graph(
        prompt=official_prompt,
        first_frame_filename=first_frame_name,
        duration_sec=float(duration_sec),
        fps=24,
        seed=42,
        steps=steps,
        use_4step_lora=use_4step_lora,
        prefix="h3_rendered_clip"
    )

    prompt_id = post_comfy_prompt(graph)

    # 4. 轮询等待出片
    outputs = wait_for_comfy_completion(
        prompt_id,
        timeout_sec=600,
        progress_callback=progress_callback,
        progress_range=(20, 95)
    )

    # 提取输出视频
    save_node = outputs.get("15", {})
    videos = save_node.get("videos", []) or save_node.get("images", [])
    if not videos:
        # 兼容部分 ComfyUI 插件的命名
        for k, v in outputs.items():
            if "videos" in v:
                videos = v["videos"]
                break

    if not videos:
        raise RuntimeError("ComfyUI 未返回输出视频")

    v_filename = videos[0]["filename"]
    v_subfolder = videos[0].get("subfolder", "")
    src_video = COMFY_OUTPUT_DIR / v_subfolder / v_filename

    shutil.copy2(src_video, output_path)
    print(f"[ENGINE] 视频生成完成落盘: {output_path} (大小: {os.path.getsize(output_path)} bytes)", flush=True)

    if progress_callback:
        progress_callback(100, "completed", f"MiniMax-H3 视频生成完成: {os.path.basename(output_path)}")
