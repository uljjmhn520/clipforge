# ClipForge ⚡ Commercial AI Short-Video Generator

> 适配个人异构算力（本地 Tesla T4 + 云端 Google Colab L4/A100）的 **100% 商业合规** 爆款短视频全自动生成系统。

---

## 🌟 核心特色

1. **异构算力自动编排**：
   - **本地 (Tesla T4 16G)**：Gemini 剧本生成、广告法合规过滤、3x3 九宫格切片、CosyVoice 2 / 本地 TTS、本地 Whisper 毫秒级字幕对齐、FFmpeg 硬件成片合成。
   - **云端 (Google Colab L4 24G / A100 40G)**：MiniMax 高清视频生成引擎。
2. **零第三方穿透隧道 (`colab exec` + Append-Only 协议)**：
   - 不依赖 ngrok / Cloudflare Tunnel；本地通过 `colab exec` 进程管道交互。
   - 任务追加写入 `/content/inbox.jsonl`，执行结果写入 `/content/outbox.jsonl`，彻底抵御网络瞬断。
3. **双阶看门狗与成本防护**：
   - **阶段 1（启动看门狗 15 分钟）**：环境安装或模型下载卡死自动强行释放实例，防无限扣费。
   - **阶段 2（空闲看门狗 5 分钟）**：渲染忙碌时冻结计时，完成空闲超 5 分钟自动释放；Web 端第 4 分钟弹出「+15分钟保活」按键。
4. **人工审核门禁与状态只读加锁**：
   - 剧本生成 -> 提示词导出 -> 3x3 九宫格生成 -> **人工审核/单图替换** -> **人工确认解锁** -> 云端提交 -> **状态机只读锁 (防止篡改并发冲突)** -> Google Drive 持久化落盘 -> 终态成片。
5. **100% 商业版权与广告法安全**：
   - 严禁 Edge-TTS（规避微软商业侵权）；内置开源 Apache 2.0 商业安全语音方案与开源 SIL OFL 1.1 思源黑体。
   - 内置中国《广告法》极限词过滤引擎。
   - 严格合规合成 AIGC 标识与人声落地（Voice Grounding）防人工耳刺。

---

## 📁 目录结构

```text
clipforge/
├── colab/                      # Colab 云端推理与守护进程
│   ├── bootstrap.py            # 阶段 1 启动引导与 15 分钟看门狗
│   ├── runner.py               # 阶段 2 核心服务、5 分钟空闲关机与 stdio 响应器
│   ├── minimax_engine.py       # MiniMax-H3 云端视频生成引擎
│   └── clipforge_colab.ipynb   # 一键在 Google Colab 中运行的 Notebook
├── docs/                       # 架构与开发规范文档
│   ├── README.md               # 文档索引
│   ├── ARCHITECTURE.md         # 异构编排与通信架构设计
│   ├── MODULE_DESIGN.md        # 6 大核心模块与协议设计
│   ├── COMPLIANCE_AND_DEPS.md  # 商业版权矩阵与合规方案
│   └── DEVELOPMENT_PLAN.md     # 开发计划与验证清单
├── src/                        # 本地全栈源码 (Next.js 15 + TypeScript)
│   ├── app/                    # WebUI 仪表盘与各模块 API 路由
│   └── lib/
│       ├── db/                 # SQLite + DrizzleORM 数据库与迁移
│       └── modules/            # 核心业务模块 (Brain / Storyboard / Colab-RPC / Audio / Composer / State-Machine)
├── assets/fonts/               # OFL 商业安全字体库 (Noto Sans CJK SC)
├── tests/                      # 自动化验证测试用例
└── temp/from_src/              # 原始代码归档备份
```

---

## 🚀 快速启动

### 1. 本地启动 Web 控制台
```bash
# 1. 复制环境变量模板并填入你的 Google AI API Key 与 Colab 配置
cp .env.example .env

# 2. 安装依赖并启动本地服务
pnpm install
pnpm dev
```
打开浏览器访问: `http://localhost:3000`

### 2. 运行自动化测试套件
```bash
pnpm test
```

### 3. 云端 Colab 节点运行
直接将 `colab/clipforge_colab.ipynb` 导入至 [Google Colab](https://colab.research.google.com/)，选择 **L4 GPU**，点击「运行所有单元格」即可。成片将直接落盘于你的 Google Drive：
`/content/drive/MyDrive/ClipForge/outputs/`
