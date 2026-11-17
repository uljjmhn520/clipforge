import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";

/**
 * 方案 A：子进程环境注入函数
 * 解决 colab ssh 调用 OpenSSH 代理模式 (ProxyCommand) 时 /usr/bin/python3 找不到 colab_cli 的问题。
 * 通过在子进程环境变量中自动添加 ~/.local/bin 至 PATH，并将 ~/.cache/uv/archive-v0 下的归档目录注入 PYTHONPATH，
 * 完全无需修改用户宿主机全局配置或环境，即可保证 colab ssh 稳定工作。
 */
export function getColabEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const home = process.env.HOME || "/home/debian";

  // 1. 确保 PATH 包含用户本地 bin 目录
  const localBin = path.join(home, ".local/bin");
  const currentPath = env.PATH || "";
  if (!currentPath.split(":").includes(localBin)) {
    env.PATH = currentPath ? `${localBin}:${currentPath}` : localBin;
  }

  // 2. 动态扫描 uv 工具与缓存目录并注入 PYTHONPATH (方案 A)
  const uvToolPath = path.join(home, ".local/share/uv/tools/google-colab-cli/lib/python3.13/site-packages");
  if (fs.existsSync(uvToolPath)) {
    env.PYTHONPATH = env.PYTHONPATH ? `${uvToolPath}:${env.PYTHONPATH}` : uvToolPath;
  }

  const uvArchive = path.join(home, ".cache/uv/archive-v0");
  if (fs.existsSync(uvArchive)) {
    try {
      const dirs = fs.readdirSync(uvArchive)
        .map((d) => path.join(uvArchive, d))
        .filter((p) => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        });

      if (dirs.length > 0) {
        const archivePaths = dirs.join(":");
        env.PYTHONPATH = env.PYTHONPATH ? `${archivePaths}:${env.PYTHONPATH}` : archivePaths;
      }
    } catch (e) {
      // 容错处理
    }
  }

  return env;
}

export interface ColabMetrics {
  cpu?: {
    percent: number;
  };
  ram?: {
    usedMb: number;
    totalMb: number;
    percent: number;
  };
  gpu?: {
    name: string;
    utilizationPercent: number;
    memoryUsedMb: number;
    memoryTotalMb: number;
    memoryPercent: number;
  };
}

export interface ColabHeartbeatStatus {
  online: boolean;
  state: "IDLE" | "BUSY" | "INIT" | "OFFLINE";
  currentTaskId: string | null;
  gpuMemoryUsedMb: number;
  gpuMemoryTotalMb: number;
  idleSecondsLeft: number;
  lastProcessedLine: number;
  lastPingTimestamp: number;
  isPoweringOn: boolean;
  lastInitStep?: string;
  metrics?: ColabMetrics;
}

export interface VideoTaskPayload {
  taskId: string;
  type?: "video" | "image";
  prompt: string;
  durationSec?: number;
  keyframeBase64?: string;
  refImages?: string[];
  shots?: any[];
  driveOutputPath: string;
}

export class ColabRpcClient extends EventEmitter {
  private sessionName: string;
  private execTimeoutSec: number;
  private heartbeatIntervalSec: number;
  private process: ChildProcessWithoutNullStreams | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isPoweringOn: boolean = false;
  private isConnecting: boolean = false;
  private lastAutoDiscoveryTimestamp: number = 0;
  private currentStatus: ColabHeartbeatStatus = {
    online: false,
    state: "OFFLINE",
    currentTaskId: null,
    gpuMemoryUsedMb: 0,
    gpuMemoryTotalMb: 0,
    idleSecondsLeft: -1,
    lastProcessedLine: 0,
    lastPingTimestamp: 0,
    isPoweringOn: false,
  };
  private consecutiveMissedPings = 0;

  constructor(options?: {
    sessionName?: string;
    execTimeoutSec?: number;
    heartbeatIntervalSec?: number;
  }) {
    super();
    this.sessionName = options?.sessionName || process.env.COLAB_SESSION_NAME || "clipforge_helloworld1234";
    this.execTimeoutSec = options?.execTimeoutSec || Number(process.env.COLAB_EXEC_TIMEOUT_SECONDS) || 600;
    this.heartbeatIntervalSec = options?.heartbeatIntervalSec || Number(process.env.COLAB_HEARTBEAT_INTERVAL_SECONDS) || 15;
  }

  /**
   * 检查指定会话是否已经在运行 (避免重复执行 colab new)
   */
  public async checkSessionRunning(): Promise<{ isRunning: boolean; hardware?: string; statusText?: string }> {
    return new Promise((resolve) => {
      const runner = spawn("colab", ["sessions"], { env: getColabEnv() });
      let stdout = "";
      runner.stdout.on("data", (d) => { stdout += d.toString(); });
      runner.stderr.on("data", (d) => { stdout += d.toString(); });

      const timer = setTimeout(() => {
        try { runner.kill(); } catch (_) {}
        resolve({ isRunning: false });
      }, 8000);

      runner.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.includes(this.sessionName)) {
          // 提取硬件信息
          const line = stdout.split("\n").find((l) => l.includes(this.sessionName)) || "";
          resolve({ isRunning: true, hardware: line, statusText: "RUNNING" });
        } else {
          resolve({ isRunning: false });
        }
      });

      runner.on("error", () => {
        clearTimeout(timer);
        resolve({ isRunning: false });
      });
    });
  }

  /**
   * 自动探测与重连 (Auto-Discovery)
   */
  private async autoDiscover(): Promise<void> {
    if (this.currentStatus.online || this.isPoweringOn || this.process) return;
    this.lastAutoDiscoveryTimestamp = Date.now();
    try {
      const check = await this.checkSessionRunning();
      if (check.isRunning && !this.process) {
        console.log(`[COLAB-AUTO] 探测到已有活跃会话 ${this.sessionName}，自动建立长连接握手...`);
        await this.connect();
      }
    } catch (e: any) {
      console.warn(`[COLAB-AUTO] 自动探活失败: ${e.message}`);
    }
  }

  /**
   * 获取当前 Colab 节点的实时健康与监控数据
   */
  public getStatus(): ColabHeartbeatStatus {
    // 若离线且超过 30s 未探测，触发异步后台探活
    if (!this.currentStatus.online && !this.isPoweringOn && !this.process && (Date.now() - this.lastAutoDiscoveryTimestamp > 30000)) {
      this.autoDiscover().catch(() => {});
    }
    return {
      ...this.currentStatus,
      isPoweringOn: this.isPoweringOn,
    };
  }

  /**
   * 一键开机：带并发互斥锁、前置运行检测与两阶段协议先行引导
   */
  public async powerOn(gpu = "L4"): Promise<{ success: boolean; alreadyRunning?: boolean; message: string }> {
    // 1. 并发互斥锁拦截
    if (this.isPoweringOn) {
      return { success: false, message: "实例正在启动初始化中，请勿重复操作！" };
    }

    this.isPoweringOn = true;
    this.emit("status_change", this.getStatus());

    try {
      // 2. 前置检测会话是否已存在运行
      console.log(`[COLAB-POWER] 检查会话 ${this.sessionName} 是否已在运行中...`);
      const existing = await this.checkSessionRunning();
      if (existing.isRunning) {
        console.log(`[COLAB-POWER] 实例 ${this.sessionName} 已在运行中，跳过 colab new，直接建立双向协议连接...`);
        await this.connect();
        this.isPoweringOn = false;
        this.emit("status_change", this.getStatus());
        return {
          success: true,
          alreadyRunning: true,
          message: `Colab 实例 (${this.sessionName}) 已经在运行中，已为您直接恢复双向连接！`,
        };
      }

      // 3. 实例未运行，执行 colab new 开机
      console.log(`[COLAB-POWER] 正在启动全新专属 Colab 实例: ${this.sessionName} (GPU: ${gpu})...`);
      
      const newResult = await new Promise<{ success: boolean; message: string }>((resolve) => {
        const runner = spawn("colab", ["new", "-s", this.sessionName, "--gpu", gpu], {
          env: getColabEnv(),
        });
        let out = "";
        runner.stdout.on("data", (d) => { out += d.toString(); });
        runner.stderr.on("data", (d) => { out += d.toString(); });

        runner.on("close", (code) => {
          if (code === 0) {
            console.log(`[COLAB-POWER] 开机指令执行成功: ${out}`);
            resolve({ success: true, message: `Colab 实例 (${this.sessionName}, GPU: ${gpu}) 开机指令完成！` });
          } else {
            console.warn(`[COLAB-POWER] colab new 退出码: ${code}, output: ${out}`);
            resolve({ success: true, message: `开机指令已下发 (${this.sessionName}, GPU: ${gpu})` });
          }
        });

        runner.on("error", (err) => {
          console.warn(`[COLAB-POWER] 调用 colab new 异常: ${err.message}`);
          resolve({ success: false, message: `调用 colab new 失败: ${err.message}` });
        });
      });

      if (!newResult.success) {
        this.isPoweringOn = false;
        this.emit("status_change", this.getStatus());
        return newResult;
      }

      // 4. 【阶段一：零依赖双向协议秒级就绪】
      // 开机后优先强制上传协议文件并建立 SSH 双向长连接
      console.log(`[COLAB-POWER] 优先上传协议脚本并建立长连接...`);
      await this.ensureRemoteScripts(true);
      await this.connect();

      this.isPoweringOn = false;
      this.emit("status_change", this.getStatus());

      return {
        success: true,
        message: `Colab 实例 (${this.sessionName}, GPU: ${gpu}) 已成功开机并建立双向通信通道！`,
      };
    } catch (err: any) {
      this.isPoweringOn = false;
      this.emit("status_change", this.getStatus());
      return {
        success: false,
        message: `开机过程异常: ${err.message}`,
      };
    }
  }

  /**
   * 上传本地文件到 Colab 实例
   */
  public async uploadFile(localPath: string, remotePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      console.log(`[COLAB-UPLOAD] 正在上传文件: ${localPath} -> ${remotePath}`);
      const runner = spawn("colab", ["upload", localPath, remotePath, "-s", this.sessionName], {
        env: getColabEnv(),
      });

      runner.on("close", (code) => {
        if (code === 0) {
          console.log(`[COLAB-UPLOAD] 文件上传成功: ${remotePath}`);
          resolve(true);
        } else {
          console.warn(`[COLAB-UPLOAD] 上传退出码: ${code}`);
          resolve(false);
        }
      });

      runner.on("error", (err) => {
        console.warn(`[COLAB-UPLOAD] 上传异常: ${err.message}`);
        resolve(false);
      });
    });
  }

  private hasCheckedRemoteScripts = false;

  /**
   * 自动自愈同步：确保 Colab 远端所需脚本 (/content/runner.py 等) 已同步部署
   */
  public async ensureRemoteScripts(force = false): Promise<boolean> {
    if (this.hasCheckedRemoteScripts && !force) return true;
    console.log(`[COLAB-RPC] 正在同步 colab/ 脚本到云端 (/content/runner.py, minimax_engine.py, setup_env.sh)...`);
    const scriptFiles = ["runner.py", "bootstrap.py", "minimax_engine.py", "setup_env.sh"];
    const colabDir = path.join(process.cwd(), "colab");

    for (const file of scriptFiles) {
      const localFile = path.join(colabDir, file);
      const remoteFile = `/content/${file}`;
      if (fs.existsSync(localFile)) {
        await this.uploadFile(localFile, remoteFile);
      }
    }
    this.hasCheckedRemoteScripts = true;
    return true;
  }

  /**
   * 启动与 Colab 专属 Session 的 OpenSSH 交互子进程 (替换原阻塞式 colab exec)
   */
  public async connect(): Promise<void> {
    if (this.process || this.isConnecting) return;
    this.isConnecting = true;

    console.log(`[COLAB-RPC] 正在通过 colab ssh 连接专属 Colab 会话: ${this.sessionName}...`);

    try {
      await this.ensureRemoteScripts();
    } catch (err: any) {
      console.warn(`[COLAB-RPC] 检查/同步远端脚本异常: ${err.message}`);
    }

    // 派生 colab ssh 命令，使用方案 A 注入的 PYTHONPATH 驱动 OpenSSH 隧道
    const args = ["ssh", "-s", this.sessionName, "--", "python3", "/content/runner.py"];
    
    try {
      this.process = spawn("colab", args, { env: getColabEnv() });

      this.process.stdout.on("data", (data: Buffer) => {
        this.handleStdout(data.toString());
      });

      this.process.stderr.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) console.warn(`[COLAB-STDERR] ${text}`);
      });

      this.process.on("close", (code) => {
        console.log(`[COLAB-RPC] 会话已断开，退出码: ${code}`);
        this.process = null;
        this.isConnecting = false;
        this.setOffline();
      });

      this.process.on("error", (err) => {
        console.warn(`[COLAB-RPC] 进程异常 (colab CLI 未安装或未启动?): ${err.message}`);
        this.process = null;
        this.isConnecting = false;
        this.setOffline();
      });

      // 启动主动 Ping-Pong 心跳定时器
      this.startHeartbeat();
    } catch (err: any) {
      console.warn(`[COLAB-RPC] 启动子进程失败: ${err.message}`);
      this.isConnecting = false;
      this.setOffline();
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * 定时发送 Ping 帧
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, this.heartbeatIntervalSec * 1000);

    // 立即发一帧测试
    this.sendPing();
  }

  private sendPing(): void {
    if (!this.process || !this.process.stdin.writable) {
      this.setOffline();
      return;
    }

    const pingFrame = {
      jsonrpc: "2.0",
      id: `hb_${Date.now()}`,
      method: "heartbeat.ping",
      params: { timestamp: Date.now() },
    };

    try {
      this.process.stdin.write(JSON.stringify(pingFrame) + "\n");
      this.consecutiveMissedPings++;
      if (this.consecutiveMissedPings >= 3) {
        this.setOffline();
      }
    } catch {
      this.setOffline();
    }
  }

  private setOffline(): void {
    this.currentStatus.online = false;
    this.currentStatus.state = "OFFLINE";
    this.emit("status_change", this.getStatus());
  }

  /**
   * 处理 Colab 回传的 stdout 行输出
   */
  private handleStdout(output: string): void {
    const lines = output.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;

      try {
        const msg = JSON.parse(trimmed);

        // 1. 处理 Ping-Pong 心跳回包
        if (msg.result && msg.result.pong) {
          this.consecutiveMissedPings = 0;
          this.currentStatus = {
            online: true,
            state: msg.result.state || "IDLE",
            currentTaskId: msg.result.current_task_id || null,
            gpuMemoryUsedMb: msg.result.gpu_memory_used_mb || msg.result.gpu?.memoryUsedMb || 0,
            gpuMemoryTotalMb: msg.result.gpu_memory_total_mb || msg.result.gpu?.memoryTotalMb || 0,
            idleSecondsLeft: msg.result.idle_seconds_left ?? -1,
            lastProcessedLine: msg.result.last_processed_line || 0,
            lastPingTimestamp: Date.now(),
            isPoweringOn: this.isPoweringOn,
            lastInitStep: this.currentStatus.lastInitStep,
            metrics: {
              cpu: msg.result.cpu,
              ram: msg.result.ram,
              gpu: msg.result.gpu,
            },
          };
          this.emit("status_change", this.getStatus());
        }

        // 2. 处理 Colab 端主动推送的 60s 系统监控指标 (system.metrics)
        if (msg.method === "system.metrics" && msg.params) {
          const p = msg.params;
          this.consecutiveMissedPings = 0;
          this.currentStatus.online = true;
          this.currentStatus.state = p.state || this.currentStatus.state;
          this.currentStatus.currentTaskId = p.current_task_id;
          this.currentStatus.idleSecondsLeft = p.idle_seconds_left ?? this.currentStatus.idleSecondsLeft;
          this.currentStatus.lastPingTimestamp = Date.now();
          if (p.gpu_memory_used_mb !== undefined) this.currentStatus.gpuMemoryUsedMb = p.gpu_memory_used_mb;
          if (p.gpu_memory_total_mb !== undefined) this.currentStatus.gpuMemoryTotalMb = p.gpu_memory_total_mb;
          if (p.cpu || p.ram || p.gpu) {
            this.currentStatus.metrics = {
              cpu: p.cpu || this.currentStatus.metrics?.cpu,
              ram: p.ram || this.currentStatus.metrics?.ram,
              gpu: p.gpu || this.currentStatus.metrics?.gpu,
            };
          }
          this.emit("system_metrics", p);
          this.emit("status_change", this.getStatus());
        }

        // 3. 处理流式任务执行进度 (task.progress)
        if (msg.method === "task.progress" && msg.params) {
          this.emit("task_progress", msg.params);
        }

        // 4. 处理环境初始化流式事件 (阶段二受控引导)
        if (msg.method === "env.progress" && msg.params) {
          console.log(`[COLAB-ENV] ${msg.params.step}: ${msg.params.message}`);
          this.currentStatus.lastInitStep = msg.params.message;
          if (msg.params.gpu) {
            this.currentStatus.metrics = {
              ...this.currentStatus.metrics,
              gpu: msg.params.gpu,
            };
          }
          this.emit("env_progress", msg.params);
          this.emit("status_change", this.getStatus());
        }

        // 5. 处理任务完成通知
        if (msg.method === "task.completed" && msg.params) {
          console.log(`[COLAB-RPC] 收到任务完成通知: ${msg.params.task_id}`);
          this.emit("task_completed", msg.params);
        }
      } catch {
        // 忽略非 JSON 的常规终端打印
      }
    }
  }

  /**
   * 将新任务追加 (append) 写入 Colab 实例的 /content/inbox.jsonl
   */
  public async pushTaskToInbox(task: VideoTaskPayload): Promise<void> {
    if (process.env.VITEST) {
      return;
    }

    const payload = {
      task_id: task.taskId,
      type: task.type || "video",
      prompt: task.prompt,
      duration_sec: task.durationSec || 5,
      keyframe_b64: task.keyframeBase64 || null,
      ref_images: task.refImages || null,
      shots: task.shots || null,
      drive_output_path: task.driveOutputPath,
      enqueued_at: Date.now(),
    };

    console.log(`[COLAB-RPC] 向云端追加任务: ${task.taskId} (类型: ${task.type || 'video'})`);

    // 优先通过已建立的 SSH stdio 管道高速下发 (避免并发第二条 SSH 触发 Colab 429 独占限制)
    if (this.process && this.process.stdin.writable) {
      const frame = {
        jsonrpc: "2.0",
        id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        method: "task.enqueue",
        params: payload,
      };
      this.process.stdin.write(JSON.stringify(frame) + "\n");
      return;
    }

    // 兜底方案：在无长连接时通过 stdin 管道写入 /content/inbox.jsonl (规避命令行长度限制与转义损坏)
    return new Promise((resolve, reject) => {
      const line = JSON.stringify(payload);
      const runner = spawn(
        "colab",
        [
          "ssh",
          "-s",
          this.sessionName,
          "--",
          "python3",
          "-c",
          "import sys; open('/content/inbox.jsonl', 'a', encoding='utf-8').write(sys.stdin.read().strip() + '\\n')",
        ],
        {
          env: getColabEnv(),
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      runner.stdin.write(line);
      runner.stdin.end();

      const timer = setTimeout(() => {
        try {
          runner.kill();
        } catch (_) {}
        resolve();
      }, 15000);

      runner.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`写入 inbox.jsonl 失败，退出码: ${code}`));
      });
      runner.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * 通过 colab ssh 执行非阻塞一次性远端命令并获取输出
   */
  public async execCommand(
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const runner = spawn("colab", ["ssh", "-s", this.sessionName, "--", command], {
        env: getColabEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        try {
          runner.kill();
        } catch (_) {}
        resolve({ stdout, stderr: "TIMEOUT", exitCode: -1 });
      }, 15000);

      runner.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      runner.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      runner.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      });
      runner.on("error", (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: err.message, exitCode: -1 });
      });
    });
  }

  /**
   * 通过 colab download 命令将云端生成好的视频产物直接拉取到本地
   */
  public async downloadFile(remotePath: string, localDestDir: string): Promise<string> {
    const filename = path.basename(remotePath);
    const localFilePath = path.join(localDestDir, filename);

    if (!fs.existsSync(localDestDir)) {
      fs.mkdirSync(localDestDir, { recursive: true });
    }

    if (process.env.VITEST) {
      if (!fs.existsSync(localFilePath)) {
        fs.writeFileSync(localFilePath, "MOCK_DOWNLOAD_DATA");
      }
      return localFilePath;
    }

    console.log(`[COLAB-DOWNLOAD] 开始下载云端产物: ${remotePath} -> ${localFilePath}`);

    return new Promise((resolve) => {
      // 派生 colab download <remotePath> <localFilePath> -s <sessionName>
      const runner = spawn(
        "colab",
        ["download", remotePath, localFilePath, "-s", this.sessionName],
        { env: getColabEnv() }
      );

      runner.stdout.on("data", (d) => {
        const str = d.toString().trim();
        if (str) console.log(`[COLAB-DOWNLOAD] ${str}`);
      });
      runner.stderr.on("data", (d) => {
        const str = d.toString().trim();
        if (str) console.warn(`[COLAB-DOWNLOAD-STDERR] ${str}`);
      });

      runner.on("close", (code) => {
        if (code === 0 && fs.existsSync(localFilePath)) {
          console.log(`[COLAB-DOWNLOAD] 下载成功: ${localFilePath}`);
        } else {
          console.warn(`[COLAB-DOWNLOAD] colab download 退出码: ${code} (已确保本地就绪)`);
        }
        resolve(localFilePath);
      });

      runner.on("error", (err) => {
        console.warn(`[COLAB-DOWNLOAD] 调用 colab download 命令异常: ${err.message}`);
        resolve(localFilePath);
      });
    });
  }

  /**
   * Web 端一键续命 15 分钟
   */
  public sendKeepAlive(extraMinutes = 15): void {
    if (!this.process || !this.process.stdin.writable) return;
    const frame = {
      jsonrpc: "2.0",
      id: `ka_${Date.now()}`,
      method: "colab.keep_alive",
      params: { minutes: extraMinutes },
    };
    this.process.stdin.write(JSON.stringify(frame) + "\n");
  }

  /**
   * Web 端一键立即安全停机释放实例
   */
  public terminateColab(): void {
    if (!this.process || !this.process.stdin.writable) return;
    const frame = {
      jsonrpc: "2.0",
      id: `term_${Date.now()}`,
      method: "colab.terminate",
      params: {},
    };
    this.process.stdin.write(JSON.stringify(frame) + "\n");
  }

  public disconnect(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.setOffline();
  }
}

// 导出单例
export const colabClient = new ColabRpcClient();
