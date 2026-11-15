# 核心系统模块拆解与接口设计规范 (v2.5 文件队列与断线重连定案版)

本文档将系统拆解为 **6 个高内聚、低耦合的内部模块** 与 **1 个独立的 Colab 云端协议运行器**，明确各模块的职责边界、输入输出契约、基于文件追加 (Append-Only) 的高容错通信队列、以及基于 stdio 的 JSON-RPC 心跳机制。

---

## 一、 顶层代码目录架构

系统采用 **“标准分层全栈 (Next.js App Router + `src/lib/modules` + `colab/`)”** 组织，结构如下：

```
clipforge/
├── colab/                          # 【云端运行脚本】运行于 Colab A100/L4 实例
│   ├── bootstrap.py                # 阶段 1 启动看门狗 (15分钟) + Google Drive 自动挂载
│   ├── runner.py                   # 阶段 2 执行器 (文件队列消费 + stdio 心跳 + 5分钟看门狗)
│   └── minimax_engine.py           # MiniMax-H3 / MiniMax-H3-Image 显存加载与推理
├── src/
│   ├── app/                        # 【Web 交互层】Next.js App Router (UI 与 API Routes)
│   │   ├── api/                    # 纯净 API 接口层 (亦可直接对外暴露为 MCP Tools)
│   │   │   ├── brain/              # 脚本与模型 API (Gemini 3.8 动态列表/生成/质检)
│   │   │   ├── storyboard/         # 九宫格处理 (切片/单格替换/审核通过)
│   │   │   ├── colab/              # Colab 专属 Session 会话控制与批量提交
│   │   │   ├── audio/              # 配音与语音转写 (CosyVoice/Whisper)
│   │   │   └── compose/            # 最终混音渲染与多格式导出
│   │   └── (dashboard)/            # 现代化前端界面 (新建/脚本审片/九宫格审核台/Colab实时监控/作品瀑布流)
│   ├── lib/
│   │   ├── db/                     # 【持久化层】Drizzle ORM + SQLite
│   │   │   ├── schema.ts           # 核心表结构定义 (包含强只读锁定状态机)
│   │   │   └── index.ts
│   │   └── modules/                # 【核心业务逻辑层】6 大功能子系统
│   │       ├── brain/              # 模块 1：创意与判官大脑
│   │       ├── storyboard/         # 模块 2：九宫格几何切片与外部提示词导出
│   │       ├── colab-rpc/          # 模块 3：基于 Append 文件队列与 stdio 心跳的容错客户端
│   │       ├── audio/              # 模块 4：商业合规配音与时间戳对齐引擎
│   │       ├── composer/           # 模块 5：FFmpeg NVENC 硬件压制与字幕混音引擎
│   │       └── state-machine/      # 模块 6：任务全生命周期调度与只读锁
├── assets/
│   └── fonts/                      # 100% 商业安全字体库 (思源黑体、阿里普惠体)
├── docs/                           # 架构与开发规范文档库
└── temp/from_src/                  # 原项目备份代码库
```

---

## 二、 文件持久化队列与断线重连机制 (`modules/colab-rpc/`)

为了解决 `colab exec` 在执行数分钟长任务时因本地 WiFi 抖动、网络重连导致管道断开的痛点，系统确立**“基于文件的 Append-Only 持久化任务日志队列”**：

```
[本地 Node.js 客户端]                                 [云端 Colab L4/A100 实例]
        │                                                         │
        │ 1. 任务推送 (append 模式写入临时文件)                    │
        ├────────────────────────────────────────────────────────►│  追加写入: /content/inbox.jsonl
        │                                                         │         │
        │                                                         │         ▼
        │                                                         │  [runner.py 逐行消费游标]
        │                                                         │         │ 正在推理生成...
        │                                                         │         ▼
        │                                                         │  视频写入 Google Drive
        │                                                         │  结果写入: /content/outbox.jsonl
        │                                                         │         │
        │ 2. 重连后自动补录 / 正常流式读取                        │         ▼
        │◄────────────────────────────────────────────────────────┤  从 /content/outbox.jsonl 回传回执
        │                                                         │
```

### 1. 队列文件规范（轻量高效，位于 Colab 实例磁盘 `/content/`）
* **任务收件箱**：`/content/inbox.jsonl`
  * 每当下发新分镜生成任务，本地向该文件以 `append` 形式追加一行完整的 JSON 指令（带唯一的 `task_id`）；
  * 即使此时 `colab exec` 中断，任务内容已落入 Colab 磁盘，绝不丢失。
* **结果发件箱**：`/content/outbox.jsonl`
  * Colab 渲染完成一个分镜后，将生成的视频路径及耗时信息追加一行到 `outbox.jsonl`；
  * 同时通过 `stdout` 进行常规输出；
* **断线重连补录机制 (Resilient Reconnect)**：
  * 若中间网络断连，本地重连后首先调用 `sync_outbox`，读取上次已知游标之后的所有 `outbox.jsonl` 记录；
  * 本地 SQLite 状态机平滑完成补录，**无需重复渲染，零重复计费，零丢单**。

### 2. 超时与心跳参数（本地 `.env` 完全掌控）
```ini
# --- colab exec 执行与心跳参数 ---
COLAB_SESSION_NAME="clipforge_helloworld1234"

# colab exec 单次交互/命令最大超时时间（秒），默认 600 秒（10分钟）
COLAB_EXEC_TIMEOUT_SECONDS=600

# 本地向 Colab 探测心跳的周期（秒），默认 15 秒
COLAB_HEARTBEAT_INTERVAL_SECONDS=15
```

### 3. 本地主动 Ping-Pong 轮询心跳协议
本地由独立计时器每隔 15 秒向子进程 `stdin` 发送心跳帧，Colab 立即通过 `stdout` 响应：

* **本地 -> Colab (Ping 帧)**：
  ```json
  { "jsonrpc": "2.0", "id": "hb_1001", "method": "heartbeat.ping", "params": { "timestamp": 1710500000 } }
  ```
* **Colab -> 本地 (Pong 回包)**：
  ```json
  {
    "jsonrpc": "2.0",
    "id": "hb_1001",
    "result": {
      "pong": true,
      "state": "IDLE",                 // 当前状态："IDLE" (空闲) | "BUSY" (正在推理)
      "current_task_id": null,         // 当前任务 ID (若有)
      "last_processed_line": 4,        // inbox.jsonl 已处理到的行号
      "gpu_memory_used_mb": 14208,     // 当前显存占用 (MB)
      "gpu_memory_total_mb": 22937,    // 显存总量 (MB)
      "idle_seconds_left": 285         // 看门狗归零关机剩余秒数 (BUSY 时为 -1)
    }
  }
  ```

---

## 三、 6 大核心模块职责与接口契约

### 模块 1：创意与判官大脑 (`src/lib/modules/brain/`)
* **职责**：
  1. 动态获取 Google AI Studio 的可用模型列表（优先默认推荐 `gemini-3.8-flash`）；
  2. 接收商品实拍图，提取核心卖点与痛点；
  3. 生成结构化 JSON 分镜初稿；
  4. 执行五判官（节奏/口语/创意/结构/画面）对抗质检与等长重写；
  5. 广告法违禁极限词静态扫描与替换。

### 模块 2：九宫格分镜与切片引擎 (`src/lib/modules/storyboard/`)
* **职责**：
  1. 针对 Google Flow / Midjourney / FLUX 导出高度优化的 3×3 九宫格生成 Prompt；
  2. 接收用户上传或云端回传的 9:16 大图，使用 `sharp` 等分裁切为 9 张独立 9:16 关键帧；
  3. 支持关键帧审查工作台的“单格替换”逻辑；
  4. 触发“人工审核确认通过”，解锁向云端下发任务的权限。

### 模块 3：Colab 文件队列与断线重连客户端 (`src/lib/modules/colab-rpc/`)
* **职责**：
  1. 封装向 Colab `/content/inbox.jsonl` 的追加任务写入逻辑；
  2. 维护已接收结果的行号游标，断线重连时自动从 `/content/outbox.jsonl` 追溯补偿未确认的结果；
  3. 启动并维护 `heartbeat.ping` 周期探测定时器，更新系统心跳健康表；
  4. 接收 Google Drive 文件落盘路径，回传本地更新 SQLite。

### 模块 4：商业配音与时间戳对齐引擎 (`src/lib/modules/audio/`)
* **职责**：
  1. 对接 CosyVoice 2 官方商业 API（或本地 T4 伴生推理端点），生成无杂音解说音频；
  2. 调用 Faster-Whisper 抽取单字毫秒级起止时间戳，计算卡拉OK高亮数据结构；
  3. 组装 **Voice Grounding** 滤镜：90Hz 高通 + 9500Hz 低通 + 3:1 动态压缩 + 混入合成低频布朗房间底噪。

### 模块 5：FFmpeg NVENC 硬件压制与字幕合成引擎 (`src/lib/modules/composer/`)
* **职责**：
  1. 流规范化滤镜链构建（统一 `yuv420p,setsar=1,fps=30,settb=AVTB`）；
  2. 启用 Tesla T4 专用的 `h264_nvenc` 进行硬件加速渲染；
  3. 绑定物理路径中的思源黑体（`SourceHanSansCN-Bold.otf`），利用 `drawtext` 烧录卡拉OK逐字字幕与价格标签；
  4. 视频前 3 秒右上角固定打上“**本视频由 AI 辅助生成**”合规角标；
  5. 全片 EBU R128 响度标准化。

### 模块 6：任务全生命周期调度与只读锁 (`src/lib/modules/state-machine/`)
* **职责**：
  1. 基于 Drizzle + SQLite 实现状态跃迁与悲观锁机制；
  2. 状态严格流转：
     `draft` → `grid_reviewing` → **`grid_approved`** → `cloud_queued` → **`🔒cloud_running (前端加锁置灰)`** → `cloud_done` → `completed`；
  3. 门禁检查：未经过人工 `grid_approved` 的任务绝不下发云端；已在 `cloud_running` 的任务拒绝任何修改。
