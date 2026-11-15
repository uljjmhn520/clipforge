# 系统架构与软硬件分工设计 (v2.5 文件队列与断线重连定案版)

本文档根据用户实际业务流与算力控制诉求进行深度强化，确立了基于 Colab 实例临时文件 (`/content/inbox.jsonl` 与 `outbox.jsonl`) 的 Append-Only 断线容错队列、两阶段全周期看门狗安全体系、基于 stdio 的 JSON-RPC Ping-Pong 心跳机制、`colab exec` 本地可控超时配置、专属持久化 Session 绑定、动态 Gemini 模型枚举、L4 默认算力选型、Google Drive 沉淀以及强锁定的状态机机制。

---

## 一、 核心开发语言与技术栈定案

* **应用全栈**：**Node.js 20+ / TypeScript**
  * **框架选型**：Next.js 14/15（App Router），全栈架构统一管理 WebUI 与后台 API。
  * **ORM & 存储**：Drizzle ORM + SQLite (`better-sqlite3`)，轻量嵌入式无服务化持久化。
  * **图像处理**：`sharp`（用于高分辨率 9 宫格图像的毫秒级几何切片与 EXIF 清洗）。
  * **音视频引擎**：`fluent-ffmpeg` + 系统级 FFmpeg（开启 Tesla T4 的 `h264_nvenc` 硬件加速）。
* **算力与大模型协同**：
  * **大脑**：Google AI Studio（**动态拉取最新模型**，默认推荐 **Gemini 3.8 Flash**，支持用户在设置中下拉切换）。
  * **TTS 配音**：**灵活双轨**（默认优先接入硅基流动/百炼的商业 CosyVoice 2 API；预留本地 T4 Docker 伴生容器端口）。
  * **生图与视频**：**Google Colab** 部署 MiniMax-H3 / MiniMax-H3-Image 节点（默认使用 **NVIDIA L4** 算力档位）。

---

## 二、 关键定制业务机制定案

### 1. 基于文件的 Append-Only 持久化任务队列（彻底解决长任务断线丢单）
针对 `colab exec` 长时间任务可能遭遇本地网络抖动导致管道断开的痛点，系统确立文件日志队列机制：

* **任务写入**：本地通过命令向 Colab 实例本地文件 `/content/inbox.jsonl` 以 `append` 追加形式写入任务 JSON；
* **异步消费**：Colab 后台守护进程按行游标顺序消费任务，生成视频直接写入 Google Drive；
* **结果沉淀**：完成结果写入 `/content/outbox.jsonl`；
* **断线无缝重连**：
  * 即使 `colab exec` 突然断开，云端任务依旧在按文件顺序静默渲染；
  * 本地重连后，首先对比已知游标与 `/content/outbox.jsonl`，瞬间补录断线期间完成的所有分镜结果；
  * **零丢单、零重复渲染、零重复计费**。

### 2. Colab stdio 管道、本地可控超时与 Ping-Pong 心跳协议
* **本地超时时长可配**：
  * `colab exec` 进程默认带本地配置的 `--timeout` 参数（例如 `COLAB_EXEC_TIMEOUT_SECONDS=600`，由本地 `.env` 决定），防止被系统底层无故中断。
* **本地主动 Ping-Pong 心跳**：
  * 本地每隔 `COLAB_HEARTBEAT_INTERVAL_SECONDS`（默认 15 秒）向 Colab 发送 `heartbeat.ping`；
  * Colab 立即回复 `pong` 并回传：当前 BUSY/IDLE 状态、显存负载、以及剩余看门狗关机秒数；
  * **管道保活 (Keep-Alive)**：持续微量 I/O 双向通信，防止管道被系统空闲回收断开。

### 3. 两阶段全周期安全看门狗（两道安全网，参数本地可配）
* **阶段 1：启动初始化保护看门狗 (Bootstrapping Watchdog)**：
  * 脚本启动第 1 秒立即激活；
  * 超时阈值默认 **15 分钟**（由本地 `COLAB_BOOT_TIMEOUT_MINUTES=15` 控制）；
  * 若 15 分钟内未发出 `[READY]` 握手，判定卡死，**立即强行释放停机**。
* **阶段 2：运行期忙闲轮询看门狗 (Runtime Idle Watchdog)**：
  * 服务加载完成发出 `[SERVER_READY]` 后接管；
  * 超时阈值默认 **5 分钟**（由本地 `COLAB_IDLE_TIMEOUT_MINUTES=5` 控制）；
  * **忙时冻结**：正在生成视频处于 `BUSY` 时，计时彻底冻结，哪怕单镜渲染 15 分钟也绝不掐断；
  * **闲时倒计时**：队列清空处于 `IDLE` 时，开始 5 分钟倒计时；
  * **Web 端预警与续命**：空闲达第 4 分钟跳出提醒，可手动点【续命 15 分钟】。

### 4. 专属于本项目的固定 Colab Session 绑定规范
* 项目初始化时，本地配置锁定专属标识：`COLAB_SESSION_NAME="clipforge_helloworld1234"`（长约 20 字符）；
* 启动与连接指令直接绑定该会话（例如 `colab new -s clipforge_helloworld1234` 或针对该会话重连）；
* 杜绝多任务混杂，且断线后支持直接回到已装好依赖的原会话，避免反复下载数十 GB 权重。

### 5. GPU 档位选择与 Google Drive 持久化
* **GPU 档位**：开机配置**默认设为 NVIDIA L4**（24GB 显存，算力消耗点仅为 A100 的三分之一到一半左右），并保留 A100 可选。
* **Drive 沉淀**：启动首行自动挂载 `drive.mount('/content/drive')`，所有成片原片优先落盘至 `/content/drive/MyDrive/ClipForge/outputs/`，永久保留云端备份，再流式同步至本地 T4。

### 6. 细粒度任务状态机与防篡改锁定
任务严格遵循如下状态迁移，**一旦进入云端生成即刻加锁，禁止任何前端修改**：

```mermaid
stateDiagram-v2
    [*] --> Draft: 创建任务
    Draft --> ScriptReview: Gemini 生成分镜
    ScriptReview --> GridPending: 判官审查通过
    
    state "九宫格审核阶段" as GridStage {
        GridPending --> GridReviewing: 上传/生成九宫格并切片
        GridReviewing --> GridReviewing: 单格人工替换
        GridReviewing --> GridApproved: 人工点击「确认通过」
    }
    
    GridApproved --> CloudQueued: 等待 Colab 开机 (离线排队)
    CloudQueued --> CloudRunning: Colab 专属 Session 就绪，写入 inbox.jsonl
    
    state "云端生成锁定期 (只读锁定)" as CloudLock {
        note right of CloudRunning: 🔒 界面禁止修改台词、禁止换图
        CloudRunning --> CloudDone: 视频存入 Drive，写入 outbox.jsonl
    }
    
    CloudDone --> LocalComposing: 回传本地 T4 混音压制
    LocalComposing --> Completed: 最终成片就绪
```
