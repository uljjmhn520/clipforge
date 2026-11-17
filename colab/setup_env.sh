#!/usr/bin/env bash
# ==============================================================================
# ClipForge Colab Setup Script (v3.0 流式受控安装版)
# 安装 ComfyUI 与 MiniMax-H3 / MiniMax-H3-Image 权重与 DMAD 4 步极速 LoRA
# ==============================================================================
set -euo pipefail

WORKSPACE="/content/clipforge"
MODELS_DIR="/content/models/H3/models"
COMFY_DIR="/content/ComfyUI"

mkdir -p "${MODELS_DIR}/diffusion_models" \
         "${MODELS_DIR}/text_encoders" \
         "${MODELS_DIR}/vae" \
         "${MODELS_DIR}/loras" \
         "/content/tasks/pending" \
         "/content/tasks/running" \
         "/content/tasks/completed" \
         "/content/tasks/failed" \
         "${WORKSPACE}/outputs"

echo ">>> [STAGE:SYS_DEPS] 安装系统级依赖 (ffmpeg, aria2, git-lfs)..."
apt-get update -qq && apt-get install -y -qq ffmpeg aria2 git-lfs > /dev/null

if [ ! -d "${COMFY_DIR}" ]; then
    echo ">>> [STAGE:COMFY_CLONE] 克隆 ComfyUI 官方仓库..."
    git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI "${COMFY_DIR}"
fi

echo ">>> [STAGE:COMFY_DEPS] 安装 Python 运行环境与 Comfy 扩展库..."
pip install -q uv
grep -viE '^(torch|torchvision|torchaudio)([=<> ]|$)' "${COMFY_DIR}/requirements.txt" > /tmp/req_comfy.txt
uv pip install --system -q -r /tmp/req_comfy.txt "comfy-kitchen>=0.2.41" "comfy-aimdo>=0.6.0" huggingface_hub

# 绑定 extra_model_paths.yaml
cat <<EOF > "${COMFY_DIR}/extra_model_paths.yaml"
clipforge:
    base_path: ${MODELS_DIR}
    checkpoints: diffusion_models
    diffusion_models: diffusion_models
    clip: text_encoders
    text_encoders: text_encoders
    vae: vae
    loras: loras
EOF

download_if_missing() {
    local rel_path="$1"
    local url="$2"
    local dest="${MODELS_DIR}/${rel_path}"
    if [ ! -f "${dest}" ]; then
        echo ">>> [STAGE:DOWNLOADING] 正在拉取 ${rel_path} ..."
        aria2c -c -x 16 -s 16 --console-log-level=warn "${url}" -d "$(dirname "${dest}")" -o "$(basename "${dest}")"
    else
        echo ">>> [STAGE:CACHED] 已存在 ${rel_path}"
    fi
}

echo ">>> [STAGE:MODELS] 开始拉取 MiniMax-H3 / Image 官方权重与文本编码器..."

# 1. 文本编码器 Qwen3-VL NVFP4 (15.6 GB)
download_if_missing "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" \
    "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"

# 2. MiniMax-H3-Image 扩散模型与 VAE (19.5 GB + 1.09 GB)
download_if_missing "diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors" \
    "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors"
download_if_missing "vae/minimax_h3_image_vae_fp16.safetensors" \
    "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/vae/minimax_h3_image_vae_fp16.safetensors"

# 3. MiniMax-H3 视频 Ref2VA 扩散模型与 VAE (20.9 GB + 5.2 GB + 0.6 GB)
download_if_missing "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors" \
    "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"
download_if_missing "vae/minimax_h3_video_vae_fp16.safetensors" \
    "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors"
download_if_missing "vae/minimax_h3_audio_vae_fp32.safetensors" \
    "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors"

# 4. DMAD 4 步极速蒸馏 LoRA (1.3 GB 下载，转档为 ComfyUI 格式 1.86 GB)
DMAD_COMFY="${MODELS_DIR}/loras/dmad_h3_4step_lora_critic_comfy.safetensors"
if [ ! -f "${DMAD_COMFY}" ]; then
    echo ">>> [STAGE:DMAD_DOWNLOAD] 下载 DMAD 4 步原始权重..."
    mkdir -p "${MODELS_DIR}/loras/dmad_raw"
    DMAD_RAW="${MODELS_DIR}/loras/dmad_raw/dmad_minimax_h3_4step_lora_critic.safetensors"
    if [ ! -f "${DMAD_RAW}" ]; then
        aria2c -c -x 16 -s 16 --console-log-level=warn \
            "https://huggingface.co/ZhengmingYu/DMAD/resolve/723954a331b372747f390afdc097e8f5699acad9/minimax_h3/dmad_minimax_h3_4step_lora_critic.safetensors" \
            -d "$(dirname "${DMAD_RAW}")" -o "$(basename "${DMAD_RAW}")"
    fi
    echo ">>> [STAGE:DMAD_CONVERT] 转换 DMAD LoRA 权重结构以适配 ComfyUI..."
    python3 -c "
import re, torch
from safetensors.torch import load_file, save_file

RENAME = {'attn.to_out.0': 'attn.out_proj', 'ff.net.0.proj': 'mlp.fc1', 'ff.net.2': 'mlp.fc2'}
QKV = ('attn.to_q', 'attn.to_k', 'attn.to_v')

def split_key(k):
    for suf, ab in (('.lora.down.weight', 'A'), ('.lora.up.weight', 'B'), ('.lora_A.weight', 'A'), ('.lora_B.weight', 'B')):
        if k.endswith(suf):
            return k[: -len(suf)], ab
    raise ValueError(f'unexpected key {k}')

def comfy_block(module):
    m = re.match(r'^transformer_blocks\.(\d+)\.(.+)$', module)
    if m:
        return f'blocks.{m.group(1)}', m.group(2)
    m = re.match(r'^token_refiner\.refiner_blocks\.(\d+)\.(.+)$', module)
    if m:
        return f'token_refiner.blocks.{m.group(1)}', m.group(2)
    raise ValueError(f'unexpected module {module}')

src = load_file('${DMAD_RAW}')
pairs = {}
for k, t in src.items():
    mod, ab = split_key(k)
    pairs.setdefault(mod, {})[ab] = t
out, qkv = {}, {}
for mod, p in pairs.items():
    blk, sub = comfy_block(mod)
    if sub in QKV:
        qkv.setdefault(blk, {})[QKV.index(sub)] = p
    else:
        sub = RENAME.get(sub, sub)
        out[f'diffusion_model.{blk}.{sub}.lora_down.weight'] = p['A']
        out[f'diffusion_model.{blk}.{sub}.lora_up.weight'] = p['B']
        out[f'diffusion_model.{blk}.{sub}.alpha'] = torch.tensor(float(p['A'].shape[0]))
for blk, parts in qkv.items():
    A_q, A_k, A_v = parts[0]['A'], parts[1]['A'], parts[2]['A']
    B_q, B_k, B_v = parts[0]['B'], parts[1]['B'], parts[2]['B']
    A_qkv = torch.cat([A_q, A_k, A_v], dim=0)
    B_qkv = torch.block_diag(B_q, B_k, B_v)
    out[f'diffusion_model.{blk}.attn.qkv_proj.lora_down.weight'] = A_qkv
    out[f'diffusion_model.{blk}.attn.qkv_proj.lora_up.weight'] = B_qkv
    out[f'diffusion_model.{blk}.attn.qkv_proj.alpha'] = torch.tensor(float(A_qkv.shape[0]))
save_file(out, '${DMAD_COMFY}')
print('DMAD ComfyUI LoRA 转档完成!')
"
    mkdir -p "${COMFY_DIR}/models/loras"
    ln -sf "${DMAD_COMFY}" "${COMFY_DIR}/models/loras/dmad_h3_4step_lora_critic_comfy.safetensors"
else
    echo ">>> [STAGE:CACHED] DMAD LoRA 已就绪"
    mkdir -p "${COMFY_DIR}/models/loras"
    ln -sf "${DMAD_COMFY}" "${COMFY_DIR}/models/loras/dmad_h3_4step_lora_critic_comfy.safetensors"
fi

echo ">>> [STAGE:FINISHED] 全部模型权重与环境配置就绪！"
