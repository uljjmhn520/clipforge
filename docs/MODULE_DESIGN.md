# 核心系统模块拆解与接口设计规范 (v3.0 目录队列与独立监控看板版)

本文档将系统拆解为 **6 个高内聚、低耦合的内部模块** 与 **1 个独立的 Colab 云端协议运行器**，明确各模块的职责边界、输入输出契约、基于 OpenSSH 隧道 (`colab ssh`) 的非阻塞通信与 `/content/tasks/pending/` 目录文件队列、高频轮询状态快照同步机制，以及本地独立监控看板 (`/colab`)。

---

## 一、 顶层代码目录架构

系统采用 **“标准分层全栈 (Next.js App Router + `src/lib/modules` + `colab/`)”** 组织，结构如下：

```
clipforge/
├── colab/                          # 【云端运行脚本】运行于 Colab L4/A100 实例
│   ├── clipforge_colab.ipynb       # 规范化 Colab 笔记本 (一键启动极速握手与受控安装)
│   ├── setup_env.sh                # 依赖与 ComfyUI / MiniMax 权重多线程拉取脚本
│   ├── runner.py                   # 核心协议守护进程 (秒级启动、后台流式安装、目录任务扫描、看门狗)
│   └── minimax_engine.py           # MiniMax-H3 / MiniMax-H3-Image 显存加载与推理
├── src/
│   ├── app/                        # 【Web 交互层】Next.js App Router (UI 与 API Routes)
│   │   ├── colab/                  # 【全新】Colab 独立全功能监控看板页面
│   │   │   └── page.tsx            # (全流程树、硬件仪表盘、队列卡片、看门狗控制)
│   │   ├── api/                    # API 接口层
│   │   │   ├── projects/route.ts   # 项目全量列表概览 (含音画资产探测) & 批量彻底删除 (级联清理)
│   │   │   ├── brain/              # 脚本与模型 API (Gemini 动态列表/生成/质检)
│   │   │   ├── storyboard/         # 九宫格处理 (切片/单格替换/审核通过/MiniMax云端直出)
│   │   │   ├── colab/              # Colab 会话控制与状态接口
│   │   │   │   ├── status/route.ts # 高频 Polling 状态聚合端点 (内存快照)
│   │   │   │   ├── submit/route.ts # 目录队列任务下发接口 (支持单分镜增量)
│   │   │   │   └── redo-shot/      # 单分镜就地重渲与图片重做端点
│   │   │   ├── audio/              # 配音与语音转写 (Edge-TTS / Whisper)
│   │   │   └── compose/            # 最终混音渲染与多格式导出
│   │   └── page.tsx                # 双视图全功能控制台 (制作工作台 + 视频进度列表卡片流及内嵌资产面板)
│   ├── lib/
│   │   ├── db/                     # 【持久化层】Drizzle ORM + SQLite
│   │   │   ├── schema.ts           # 核心表结构定义 (包含强只读锁定状态机)
│   │   │   └── index.ts
│   │   └── modules/                # 【核心业务逻辑层】6 大功能子系统
│   │       ├── brain/              # 模块 1：创意与判官大脑 (Gemini API)
│   │       ├── storyboard/         # 模块 2：九宫格几何切片与外部提示词导出
│   │       ├── colab-rpc/          # 模块 3：OpenSSH 隧道客户端与目录队列调度器
│   │       ├── audio/              # 模块 4：Edge-TTS 高保真配音与时间戳对齐引擎
│   │       ├── composer/           # 模块 5：FFmpeg NVENC 硬件压制与字幕混音引擎
│   │       └── state-machine/      # 模块 6：任务全生命周期调度与只读锁
│   └── ...
```

---

## 二、 Colab 通信与目录任务队列机制 (`modules/colab-rpc/`)

```
[本地 Node.js 客户端]                                 [云端 Colab L4 实例]
        │                                                         │
        │ 1. 建立 OpenSSH 隧道长连接 (colab ssh -s <session>)      │
        ├────────────────────────────────────────────────────────►│  秒级启动 runner.py
        │◄────────────────────────────────────────────────────────┤  回传 [HANDSHAKE_READY]
        │                                                         │
        │ 2. 云端受控后台安装 ComfyUI + MiniMax 权重              │
        │◄─── 每秒流式回传下载进度、网络速度、硬件负载 ─────────────┤  多线程 aria2 下载至 /content/models/
        │                                                         │
        │ 3. 投递任务包至目录队列                                  │
        ├────────────────────────────────────────────────────────►│  写入 /content/tasks/pending/<id>/task.json
        │                                                         │         │
        │                                                         │         ▼
        │                                                         │  [按时间戳顺序轮询消费]
        │                                                         │  状态: running -> completed
        │                                                         │  执行 MiniMax 文生图 / 图生视频
        │                                                         │         │
        │                                                         │         ▼
        │ 4. 结果回传与状态同步                                    │  任务移入 /content/tasks/completed/<id>/
        │◄────────────────────────────────────────────────────────┤  成片直存 Google Drive 并回传元数据
```

### 1. 目录任务包协议格式 (`/content/tasks/pending/<timestamp>_<taskId>/task.json`)
```json
{
  "taskId": "task_1710500123_proj01_shot1",
  "projectId": "proj01",
  "taskType": "video_gen", // "image_grid_gen" | "video_gen"
  "createdAt": 1710500123,
  "params": {
    "prompt": "女主播微笑着看向镜头，右手举起产品，轻微点头",
    "keyframeImage": "input_frame.png", // 同目录下存有图片
    "durationSec": 4.0,
    "steps": 4,
    "use4StepLora": true
  },
  "driveOutputDir": "/content/drive/MyDrive/ClipForge/outputs/proj01"
}
```

### 2. 状态机响应格式 (RPC 回传与本地缓存)
本地 Node.js 维护单例 `ColabStateStore`，响应前端高频轮询 (`/api/colab/status`)：
```typescript
interface ColabStatusResponse {
  connected: boolean;
  sessionName: string;
  lifecycleStage: "INIT_BOOT" | "RPC_READY" | "INSTALLING_MODELS" | "IDLE" | "BUSY" | "OFFLINE";
  installProgress: {
    stage: string;
    percent: number;
    speedMbps: number;
    logTail: string[];
  };
  hardware: {
    cpuPercent: number;
    cpuNote: string; // "处于 GPU 推理/下载中，CPU 占用偏低属正常"
    ramUsedMb: number;
    ramTotalMb: number;
    gpuName: string;
    gpuUtilPercent: number;
    vramUsedMb: number;
    vramTotalMb: number;
  };
  tasks: {
    current: TaskSummary | null;
    pendingCount: number;
    pendingList: TaskSummary[];
    completedList: TaskSummary[];
  };
  watchdog: {
    idleSecondsLeft: number;
    maxLifetimeLeft: number;
    isBusyFrozen: boolean;
  };
}
```

---

## 三、 6 大核心模块职责与接口契约

### 模块 1：创意与判官大脑 (`src/lib/modules/brain/`)
* **职责**：
  1. 调用 Google AI Studio `client.models.list()` 动态枚举最新模型（默认推荐 `gemini-3.5-flash` / `gemini-3.8-flash`）；
  2. 接收商品实拍图，提取核心卖点与痛点；
  3. 生成结构化 JSON 分镜初稿；
  4. 五判官对抗质检与等长重写，违禁词过滤；
  5. 输出优化后的 MiniMax-H3-Image 提示词。

### 模块 2：九宫格分镜与切片引擎 (`src/lib/modules/storyboard/`)
* **职责**：
  1. 组织 3×3 九宫格生成 Prompt；
  2. 接收由 Colab MiniMax-H3-Image 或外部生成的 9:16 大图，使用 `sharp` 等分裁切为 9 张独立 9:16 关键帧；
  3. 审查工作台的“单格替换”与“人工审核通过”放行门禁。

### 模块 3：Colab OpenSSH 通道与目录队列客户端 (`src/lib/modules/colab-rpc/`)
* **职责**：
  1. 采用 OpenSSH 隧道 (`colab ssh`) 建立与 Colab 会话的非阻塞稳定管道；
  2. 方案 A 运行时环境注入 (`getColabEnv`)，自动补齐 uv 依赖至 `PYTHONPATH`；
  3. 任务打包推送到 `/content/tasks/pending/`；
  4. **断线自动补偿机制**：重新建立连接时，Colab 立即上报 `/content/tasks/completed/` 历史收据，本地对比数据库自动补录并拉取成片；
  5. **显存 OOM 智能自愈与重试 1 次**：云端遇到 CUDA OOM 或推理异常时，自动清空 PyTorch CUDA 缓存并重启 ComfyUI 后自动重试 1 次，再次失败归档至 `failed/` 并通知本地，不阻断主队列；
  6. 维护本地内存快照，收集安装进度、硬件指标与看门狗状态，向前端 `/colab` 提供 1~2s 短轮询数据；
  7. 响应续命、关机、取消任务等控制指令。

### 模块 4：Edge-TTS 高保真配音与时间戳对齐引擎 (`src/lib/modules/audio/`)
* **职责**：
  1. 基于微软 Edge-TTS 原生协议生成自然流畅的解说音频（零成本、免授权、开箱即用）；
  2. **内置电商爆款预设音色库**：
     - `zh-CN-XiaoxiaoNeural`（晓晓 - 热情亲切带货女声，默认首选）
     - `zh-CN-YunxiNeural`（云希 - 阳光自然解说男声）
     - `zh-CN-YunjianNeural`（云健 - 专业沉稳影视解说男声）
     - `zh-CN-XiaoyiNeural`（晓伊 - 活泼灵动电商女声）
  3. **紧凑电商语速微调**：默认预设 `rate="+15%"`（节奏紧凑不拖沓），输出带起止时间戳的 VTT 歌词字幕；
  4. 组装 Voice Grounding 模拟真实手机收音（90Hz高通 + 9500Hz低通 + 动态压缩 + 环境底噪混音）。

### 模块 5：FFmpeg NVENC 硬件压制与字幕合成引擎 (`src/lib/modules/composer/`)
* **职责**：
  1. 流规范化统一滤镜（`yuv420p,setsar=1,fps=30`）；
  2. Tesla T4 专用的 `h264_nvenc` 硬件压制；
  3. 绑定思源黑体烧录卡拉OK高亮字幕，打上“本视频由 AI 辅助生成”合规角标与商品标签；
  4. EBU R128 音频标准化。

### 模块 6：任务全生命周期调度与只读锁 (`src/lib/modules/state-machine/`)
* **职责**：
  1. 基于 Drizzle + SQLite 严格维护任务状态跃迁与悲观锁；
  2. 状态流：`draft` → `grid_reviewing` → `grid_approved` → `cloud_queued` → `cloud_running (locked)` → `cloud_done` → `completed`；
  3. **单分镜增量失效与重渲**：支持单独传入 `targetShotId` 将指定单分镜推入云端重新渲染，其余已渲染完成的分镜绝对保留，极大节约算力与时间；
  4. 门禁检查：未人工审核禁止下发云端；云端运行中禁止任何修改。

### 模块 7：本地目录任务队列消费与重生成调度器 (`src/lib/modules/state-machine/local-dispatcher.ts`)
* **职责**：
  1. **本地任务目录管理**：维护 `data/local_tasks/pending/`、`dispatched/`、`failed/` 三级文件队列；
  2. **离线任务暂存 (Offline Queuing)**：用户在“五判官质检报告”点击自动生图或在审核后提交视频生成时，无论 Colab 是否开机，先在本地 `pending/` 目录完成原子入队，DB 标记为 `waiting_for_cloud`；
  3. **双向通信开机消费 (Online Auto-Dispatch)**：监听 Colab 双向通信握手就绪（`handshake_ready` / `env_ready`）及周期巡检，**仅当 Colab 已开机且通信正常**时，将任务按时间戳顺序上传分发至云端 `/content/tasks/pending/`，分发成功移至 `dispatched/`；
  4. **防卡死任务重生成 (Task Re-generation)**：暴露 `resubmitProjectTasks` 接口与前端操作，支持一键清洗旧待办、重新组装最新任务入队。
