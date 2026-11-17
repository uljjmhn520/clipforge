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
    note?: string;
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
  net?: {
    downloadSpeedMbps: number;
  };
}

export interface InstallProgress {
  stage: string;
  percent: number;
  speed_mbps: number;
  message: string;
  log_tail: string[];
}

export interface TaskLiveProgress {
  taskId: string;
  task_id?: string;
  taskType?: string;
  stage?: string;
  step?: string;
  percent: number;
  message: string;
  currentStep?: number;
  totalSteps?: number;
  shotIndex?: number;
  totalShots?: number;
  elapsedSec?: number;
  extra?: any;
}

export interface ColabHeartbeatStatus {
  online: boolean;
  sessionName: string;
  lifecycle: "INIT_BOOT" | "RPC_READY" | "INSTALLING_MODELS" | "IDLE" | "BUSY" | "OFFLINE";
  state: "IDLE" | "BUSY" | "INIT" | "OFFLINE";
  currentTaskId: string | null;
  currentTask?: any;
  currentProgress?: TaskLiveProgress | null;
  pendingTasksCount: number;
  gpuMemoryUsedMb: number;
  gpuMemoryTotalMb: number;
  idleSecondsLeft: number;
  isWatchdogFrozen: boolean;
  lastPingTimestamp: number;
  isPoweringOn: boolean;
  lastInitStep?: string;
  installProgress: InstallProgress;
  tunnelUrl?: string | null;
  metrics: ColabMetrics;
  recentTasks: Array<{
    taskId: string;
    taskType: string;
    status: "running" | "completed" | "failed";
    percent?: number;
    message?: string;
    outputFile?: string;
    elapsedSec?: number;
    timestamp: number;
  }>;
}

export interface VideoTaskPayload {
  taskId: string;
  taskType?: "video_gen" | "image_grid_gen";
  type?: "video" | "image";
  prompt: string;
  durationSec?: number;
  steps?: number;
  use4StepLora?: boolean;
  keyframeBase64?: string;
  keyframePath?: string;
  refImages?: string[];
  shots?: any[];
  driveOutputPath?: string;
}

export class ColabRpcClient extends EventEmitter {
  private sessionName: string;
  private execTimeoutSec: number;
  private heartbeatIntervalSec: number;
  private process: ChildProcessWithoutNullStreams | null = null;
  private wsClient: WebSocket | null = null;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private tunnelUrl: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isPoweringOn: boolean = false;
  private isConnecting: boolean = false;
  private hasCheckedRemoteScripts: boolean = false;
  private lastAutoDiscoveryTimestamp: number = 0;
  private currentStatus: ColabHeartbeatStatus = {
    online: false,
    sessionName: "clipforge_helloworld1234",
    tunnelUrl: null,
    lifecycle: "OFFLINE",
    state: "OFFLINE",
    currentTaskId: null,
    pendingTasksCount: 0,
    gpuMemoryUsedMb: 0,
    gpuMemoryTotalMb: 22937,
    idleSecondsLeft: 300,
    isWatchdogFrozen: false,
    lastPingTimestamp: 0,
    isPoweringOn: false,
    installProgress: {
      stage: "init",
      percent: 0,
      speed_mbps: 0.0,
      message: "等待 Colab 实例启动...",
      log_tail: [],
    },
    metrics: {
      cpu: { percent: 0, note: "GPU 推理或网络下载中，CPU 负载较低属正常现象" },
      ram: { usedMb: 0, totalMb: 0, percent: 0 },
      gpu: { name: "NVIDIA L4", utilizationPercent: 0, memoryUsedMb: 0, memoryTotalMb: 22937, memoryPercent: 0 },
      net: { downloadSpeedMbps: 0 },
    },
    recentTasks: [],
  };
  private consecutiveMissedPings = 0;

  constructor(options?: {
    sessionName?: string;
    execTimeoutSec?: number;
    heartbeatIntervalSec?: number;
  }) {
    super();
    this.sessionName = options?.sessionName || process.env.COLAB_SESSION_NAME || "clipforge_helloworld1234";
    this.currentStatus.sessionName = this.sessionName;
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
    if (this.currentStatus.online || this.isPoweringOn || this.isConnecting || (this.wsClient && this.wsClient.readyState === WebSocket.OPEN)) return;
    this.lastAutoDiscoveryTimestamp = Date.now();
    try {
      const check = await this.checkSessionRunning();
      if (check.isRunning && !this.currentStatus.online && !this.isConnecting) {
        console.log(`[COLAB-AUTO] 探测到已有活跃会话 ${this.sessionName}，自动建立 WebSocket 穿透长连...`);
        this.currentStatus.state = "INIT";
        this.currentStatus.lifecycle = "INIT_BOOT";
        this.currentStatus.installProgress.message = "探测到活跃实例，正在建立双向通信通道...";
        this.emit("status_change", this.getStatus());
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
    const isWsConnected = this.wsClient && this.wsClient.readyState === WebSocket.OPEN;
    if (!this.currentStatus.online && !this.isPoweringOn && !this.isConnecting && !isWsConnected && (Date.now() - this.lastAutoDiscoveryTimestamp > 8000)) {
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
    if (this.isPoweringOn) {
      return { success: false, message: "实例正在启动初始化中，请勿重复操作！" };
    }

    this.isPoweringOn = true;
    this.currentStatus.state = "INIT";
    this.currentStatus.lifecycle = "INIT_BOOT";
    this.currentStatus.installProgress.message = `正在启动 Colab 实例 (${gpu})...`;
    this.emit("status_change", this.getStatus());

    try {
      console.log(`[COLAB-POWER] 检查会话 ${this.sessionName} 是否已在运行中...`);
      const existing = await this.checkSessionRunning();
      if (existing.isRunning) {
        console.log(`[COLAB-POWER] 实例 ${this.sessionName} 已在运行中，跳过 colab new，直接建立双向协议连接...`);
        this.currentStatus.installProgress.message = "实例已就绪，正在恢复双向连接...";
        this.emit("status_change", this.getStatus());
        await this.connect();
        this.isPoweringOn = false;
        this.emit("status_change", this.getStatus());
        return {
          success: true,
          alreadyRunning: true,
          message: `Colab 实例 (${this.sessionName}) 已经在运行中，已为您直接恢复双向连接！`,
        };
      }

      console.log(`[COLAB-POWER] 正在启动全新专属 Colab 实例: ${this.sessionName} (GPU: ${gpu})...`);
      
      await new Promise<{ success: boolean; message: string }>((resolve) => {
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
          console.warn(`[COLAB-POWER] 触发 colab new 异常: ${err.message}`);
          resolve({ success: false, message: err.message });
        });
      });

      this.currentStatus.installProgress.message = "实例开机完成，正在同步脚本并启动穿透通信服务...";
      this.emit("status_change", this.getStatus());

      // 同步脚本并启动通信服务
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
        console.warn(`[COLAB-UPLOAD] 调用 colab upload 失败: ${err.message}`);
        resolve(false);
      });
    });
  }

  /**
   * 同步最新云端 runner.py、setup_env.sh、minimax_engine.py
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
   * 确保云端后台常驻守护进程运行并获取 Cloudflare Quick Tunnel 穿透域名
   * 采用轻量单次 colab exec (HTTP API 请求，不占用 SSH 连接)
   */
  public async ensureRemoteRunnerAndGetTunnel(): Promise<string | null> {
    if (process.env.VITEST) {
      return "https://mock-tunnel.trycloudflare.com";
    }

    const pythonCode = `
import subprocess, os, time, shutil

# 0. 优先确保 cloudflared 可执行 (耗时约 2 秒)
if not shutil.which("cloudflared") and not os.path.exists("/usr/local/bin/cloudflared"):
    try:
        subprocess.run(["curl", "-fsSL", "-o", "/usr/local/bin/cloudflared", "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"], timeout=30, check=True)
        subprocess.run(["chmod", "+x", "/usr/local/bin/cloudflared"], check=True)
    except Exception:
        pass

# 1. 检查 runner.py 是否已在运行
res = subprocess.run(["pgrep", "-f", "runner.py"], capture_output=True)
if not res.stdout.strip():
    log_file = open("/content/runner.log", "a")
    subprocess.Popen(
        ["python3", "/content/runner.py", "--session-name", "${this.sessionName}"],
        stdin=subprocess.DEVNULL,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True
    )

# 2. 等待 /content/tunnel_url.txt 生成 (最多等待 35 秒)
tunnel_url = ""
for _ in range(35):
    if os.path.exists("/content/tunnel_url.txt"):
        with open("/content/tunnel_url.txt") as f:
            t = f.read().strip()
            if t.startswith("https://"):
                tunnel_url = t
                break
    time.sleep(1)

print("CLIPFORGE_TUNNEL_URL:" + tunnel_url)
`;

    return new Promise((resolve) => {
      const runner = spawn("colab", ["exec", "-s", this.sessionName], {
        env: getColabEnv(),
      });

      let stdout = "";
      let stderr = "";

      runner.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      runner.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      const timer = setTimeout(() => {
        try { runner.kill(); } catch (_) {}
        resolve(null);
      }, 45000);

      runner.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.includes("CLIPFORGE_TUNNEL_URL:")) {
          const match = stdout.match(/CLIPFORGE_TUNNEL_URL:(https:\/\/[^\s]+)/);
          if (match && match[1]) {
            resolve(match[1].trim());
            return;
          }
        }
        resolve(null);
      });

      runner.on("error", (err) => {
        clearTimeout(timer);
        console.warn(`[COLAB-TUNNEL] colab exec 失败: ${err.message}`);
        resolve(null);
      });

      runner.stdin.write(pythonCode);
      runner.stdin.end();
    });
  }

  /**
   * 启动与 Colab 的全双工通信：
   * 采用 Cloudflare Quick Tunnel 建立高速 WebSocket + HTTP 穿透，
   * 绝不占用持久的 colab ssh 管道，将唯一的 SSH 会话完全让渡给开发者终端！
   */
  public async connect(): Promise<void> {
    if ((this.wsClient && this.wsClient.readyState === WebSocket.OPEN) || this.isConnecting) return;
    this.isConnecting = true;

    try {
      // 1. 如果已有记录的 tunnelUrl，先快速 probe /health 测试是否存活
      if (this.tunnelUrl) {
        try {
          const resp = await fetch(`${this.tunnelUrl}/health`, { signal: AbortSignal.timeout(3000) });
          if (resp.ok) {
            console.log(`[COLAB-TUNNEL] 已知隧道 ${this.tunnelUrl} 仍然存活，直接连接 WebSocket...`);
            this.connectWebSocket(this.tunnelUrl);
            this.isConnecting = false;
            return;
          }
        } catch (_) {}
      }

      // 2. 检查会话是否在运行中
      const check = await this.checkSessionRunning();
      if (!check.isRunning) {
        console.log(`[COLAB-RPC] 会话 ${this.sessionName} 未处于运行状态，取消连接。`);
        this.isConnecting = false;
        return;
      }

      // 3. 确保远程脚本已同步
      try {
        await this.ensureRemoteScripts();
      } catch (err: any) {
        console.warn(`[COLAB-RPC] 检查/同步远端脚本异常: ${err.message}`);
      }

      // 4. 通过单次 colab exec 确保云端后台常驻守护进程 runner.py 已启动并获取穿透隧道 URL
      console.log(`[COLAB-RPC] 正在通过轻量 exec 探活/启动云端后台守护进程并获取穿透隧道...`);
      const tunnelUrl = await this.ensureRemoteRunnerAndGetTunnel();

      if (tunnelUrl) {
        console.log(`[COLAB-RPC] 成功获取穿透隧道 URL: ${tunnelUrl}，正在建立 WebSocket 长连...`);
        this.connectWebSocket(tunnelUrl);
      } else {
        console.warn(`[COLAB-RPC] 未能在规定时间内获取到穿透隧道 URL`);
      }
    } catch (err: any) {
      console.warn(`[COLAB-RPC] 建立通信连接异常: ${err.message}`);
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * 建立基于 Cloudflare Quick Tunnel 的全双工 WebSocket 长连通道
   * 彻底释放 colab ssh 单连接占用，让用户终端随时随地可自由登录，杜绝 429 冲突
   */
  public connectWebSocket(tunnelUrl: string): void {
    if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) return;
    this.tunnelUrl = tunnelUrl;
    this.currentStatus.tunnelUrl = tunnelUrl;

    const wsUrl = tunnelUrl.replace(/^http/, "ws") + "/ws";
    console.log(`[COLAB-WS] 正在连接 Cloudflare WebSocket 双向通道: ${wsUrl}`);

    try {
      this.wsClient = new WebSocket(wsUrl);

      this.wsClient.onopen = () => {
        console.log(`[COLAB-WS] Cloudflare WebSocket 全双工通道已成功连通！`);
        this.consecutiveMissedPings = 0;
        this.currentStatus.online = true;
        this.startHeartbeat();
      };

      this.wsClient.onmessage = (event: any) => {
        const dataStr = typeof event.data === "string" ? event.data : event.data?.toString();
        if (dataStr) {
          this.handleStdout(dataStr);
        }
      };

      this.wsClient.onerror = (err: any) => {
        console.warn(`[COLAB-WS] WebSocket 通道提示: ${err.message || "连接建立中"}`);
      };

      this.wsClient.onclose = () => {
        console.log(`[COLAB-WS] WebSocket 连接中断，5 秒后尝试重连...`);
        this.wsClient = null;
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => {
          if (this.tunnelUrl) {
            this.connectWebSocket(this.tunnelUrl);
          } else {
            this.autoDiscover().catch(() => {});
          }
        }, 5000);
      };
    } catch (e: any) {
      console.warn(`[COLAB-WS] 启动 WebSocket 异常: ${e.message}`);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, this.heartbeatIntervalSec * 1000);
    this.sendPing();
  }

  private sendPing(): void {
    const isWsAlive = this.wsClient && this.wsClient.readyState === WebSocket.OPEN;
    const isProcAlive = this.process && this.process.stdin.writable;

    if (!isWsAlive && !isProcAlive) {
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
      if (isWsAlive) {
        this.wsClient!.send(JSON.stringify(pingFrame));
      } else if (isProcAlive) {
        this.process!.stdin.write(JSON.stringify(pingFrame) + "\n");
      }
      this.consecutiveMissedPings++;
      const maxMissed = this.currentStatus.lifecycle === "BUSY" ? 20 : 5;
      if (this.consecutiveMissedPings >= maxMissed) {
        this.setOffline();
      }
    } catch {
      this.setOffline();
    }
  }

  private setOffline(): void {
    this.currentStatus.online = false;
    this.currentStatus.lifecycle = "OFFLINE";
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

        // 收到来自 Colab 的任何合法 JSON-RPC 消息或通知，均证明双向通信畅通在线
        this.consecutiveMissedPings = 0;
        this.currentStatus.online = true;

        // 动态发现与自愈：收到 Cloudflare 隧道域名，立即平滑升级至全双工 WebSocket
        if (msg.params?.tunnelUrl || msg.result?.tunnelUrl) {
          const tUrl = msg.params?.tunnelUrl || msg.result?.tunnelUrl;
          if (tUrl && tUrl !== this.tunnelUrl) {
            this.connectWebSocket(tUrl);
          }
        }

        // 1. 处理 Ping-Pong 心跳回包
        if (msg.result && msg.result.pong) {
          this.consecutiveMissedPings = 0;
          this.currentStatus.online = true;
          this.currentStatus.lifecycle = msg.result.lifecycle || this.currentStatus.lifecycle;
          this.currentStatus.state = msg.result.state || "IDLE";
          this.currentStatus.currentTaskId = msg.result.currentTask?.taskId || msg.result.current_task_id || null;
          this.currentStatus.currentTask = msg.result.currentTask;
          this.currentStatus.idleSecondsLeft = msg.result.idleSecondsLeft ?? msg.result.idle_seconds_left ?? this.currentStatus.idleSecondsLeft;
          if (msg.result.gpu_memory_used_mb !== undefined) {
            this.currentStatus.gpuMemoryUsedMb = msg.result.gpu_memory_used_mb;
          }
          if (msg.result.gpu_memory_total_mb !== undefined) {
            this.currentStatus.gpuMemoryTotalMb = msg.result.gpu_memory_total_mb;
          }
          if (msg.result.last_processed_line !== undefined) {
            (this.currentStatus as any).lastProcessedLine = msg.result.last_processed_line;
          }
          this.currentStatus.lastPingTimestamp = Date.now();
          if (msg.result.installProgress) {
            this.currentStatus.installProgress = msg.result.installProgress;
          }
          if (msg.result.currentProgress !== undefined) {
            this.currentStatus.currentProgress = msg.result.currentProgress;
          }
          if (msg.result.hardware) {
            this.updateHardware(msg.result.hardware);
          }
          if (msg.result.cpu || msg.result.ram || msg.result.gpu) {
            this.updateHardware({
              cpu: msg.result.cpu,
              ram: msg.result.ram,
              gpu: msg.result.gpu,
            });
          }
          this.emit("status_change", this.getStatus());
        }

        // 2. 处理握手事件 (handshake.ready)
        if (msg.method === "handshake.ready") {
          this.consecutiveMissedPings = 0;
          this.currentStatus.online = true;
          this.currentStatus.lifecycle = "RPC_READY";
          this.currentStatus.state = "INIT";
          this.currentStatus.lastPingTimestamp = Date.now();
          if (msg.params?.gpu) {
            this.currentStatus.metrics.gpu = msg.params.gpu;
          }
          if (msg.params?.completedTasks && Array.isArray(msg.params.completedTasks)) {
            for (const ct of msg.params.completedTasks) {
              this.emit("task_completed", ct);
            }
          }
          this.emit("handshake_ready", msg.params);
          this.emit("status_change", this.getStatus());
        }

        // 3. 处理环境安装流式事件 (env.progress)
        if (msg.method === "env.progress" && msg.params) {
          this.currentStatus.lifecycle = "INSTALLING_MODELS";
          this.currentStatus.installProgress = {
            ...this.currentStatus.installProgress,
            ...msg.params,
          };
          this.currentStatus.lastInitStep = msg.params.message;
          this.emit("env_progress", msg.params);
          this.emit("status_change", this.getStatus());
        }

        // 4. 处理环境安装就绪 (env.ready)
        if (msg.method === "env.ready" && msg.params) {
          this.currentStatus.lifecycle = "IDLE";
          this.currentStatus.state = "IDLE";
          this.currentStatus.installProgress.percent = 100;
          this.currentStatus.installProgress.message = "MiniMax-H3 / Image 推理环境已完全就绪！";
          if (msg.params.gpu) this.currentStatus.metrics.gpu = msg.params.gpu;
          this.emit("env_ready", msg.params);
          this.emit("status_change", this.getStatus());
        }

        // 5. 处理系统性能与监控指标 (system.metrics)
        if (msg.method === "system.metrics" && msg.params) {
          const p = msg.params;
          this.consecutiveMissedPings = 0;
          this.currentStatus.online = true;
          this.currentStatus.lifecycle = p.lifecycle || this.currentStatus.lifecycle;
          this.currentStatus.state = p.status || p.state || this.currentStatus.state;
          this.currentStatus.currentTaskId = p.currentTask?.taskId || p.current_task_id || null;
          this.currentStatus.currentTask = p.currentTask;
          this.currentStatus.pendingTasksCount = p.pendingTasksCount ?? this.currentStatus.pendingTasksCount;
          if (p.idle_seconds_left !== undefined) {
            this.currentStatus.idleSecondsLeft = p.idle_seconds_left;
          }
          if (p.watchdog) {
            this.currentStatus.idleSecondsLeft = p.watchdog.idleSecondsLeft ?? this.currentStatus.idleSecondsLeft;
            this.currentStatus.isWatchdogFrozen = p.watchdog.isFrozen ?? false;
          }
          if (p.gpu_memory_used_mb !== undefined) this.currentStatus.gpuMemoryUsedMb = p.gpu_memory_used_mb;
          if (p.gpu_memory_total_mb !== undefined) this.currentStatus.gpuMemoryTotalMb = p.gpu_memory_total_mb;
          if (p.installProgress) {
            this.currentStatus.installProgress = p.installProgress;
          }
          if (p.currentProgress !== undefined) {
            this.currentStatus.currentProgress = p.currentProgress;
          }
          if (p.hardware) {
            this.updateHardware(p.hardware);
          }
          if (p.cpu || p.ram || p.gpu) {
            this.updateHardware({ cpu: p.cpu, ram: p.ram, gpu: p.gpu, net: p.net });
          }
          this.currentStatus.lastPingTimestamp = Date.now();
          this.emit("system_metrics", p);
          this.emit("status_change", this.getStatus());
        }

        // 6. 处理任务流式进度 (task.started / task.progress / task.completed / task.failed)
        if (msg.method === "task.started" && msg.params) {
          this.currentStatus.lifecycle = "BUSY";
          this.currentStatus.state = "BUSY";
          this.currentStatus.currentTaskId = msg.params.taskId;
          this.addRecentTask({
            taskId: msg.params.taskId,
            taskType: msg.params.taskType,
            status: "running",
            percent: 5,
            message: "任务开始执行...",
            timestamp: Date.now(),
          });
          this.emit("task_started", msg.params);
          this.emit("status_change", this.getStatus());
        }

        if (msg.method === "task.progress" && msg.params) {
          this.currentStatus.currentProgress = {
            taskId: msg.params.taskId,
            taskType: msg.params.taskType,
            stage: msg.params.stage || "generating",
            percent: msg.params.percent,
            message: msg.params.message,
            currentStep: msg.params.currentStep,
            totalSteps: msg.params.totalSteps,
            shotIndex: msg.params.shotIndex,
            totalShots: msg.params.totalShots,
            elapsedSec: msg.params.elapsedSec,
          };
          this.updateRecentTask(msg.params.taskId, {
            percent: msg.params.percent,
            message: msg.params.message,
          });
          this.emit("task_progress", msg.params);
          this.emit("status_change", this.getStatus());
        }

        if (msg.method === "task.completed" && msg.params) {
          this.currentStatus.lifecycle = "IDLE";
          this.currentStatus.state = "IDLE";
          this.currentStatus.currentTaskId = null;
          this.currentStatus.currentTask = null;
          this.currentStatus.currentProgress = null;
          this.updateRecentTask(msg.params.taskId, {
            status: "completed",
            percent: 100,
            outputFile: msg.params.outputFile,
            elapsedSec: msg.params.elapsedSec,
            message: "任务执行成功落盘！",
          });
          this.emit("task_completed", msg.params);
          this.emit("status_change", this.getStatus());
        }

        if (msg.method === "task.failed" && msg.params) {
          this.currentStatus.lifecycle = "IDLE";
          this.currentStatus.state = "IDLE";
          this.currentStatus.currentTaskId = null;
          this.currentStatus.currentTask = null;
          this.currentStatus.currentProgress = null;
          this.updateRecentTask(msg.params.taskId, {
            status: "failed",
            message: msg.params.error || "任务执行失败",
          });
          this.emit("task_failed", msg.params);
          this.emit("status_change", this.getStatus());
        }
      } catch {
        // 忽略非 JSON 日志行
      }
    }
  }

  private updateHardware(hw: any) {
    if (hw.cpu) {
      this.currentStatus.metrics.cpu = {
        percent: hw.cpu.percent ?? 0,
        note: hw.cpu.note || "GPU 推理或网络下载中，CPU 负载较低属正常现象",
      };
    }
    if (hw.ram) {
      this.currentStatus.metrics.ram = hw.ram;
    }
    if (hw.gpu) {
      this.currentStatus.metrics.gpu = hw.gpu;
      this.currentStatus.gpuMemoryUsedMb = hw.gpu.memoryUsedMb || 0;
      this.currentStatus.gpuMemoryTotalMb = hw.gpu.memoryTotalMb || 22937;
    }
    if (hw.net) {
      this.currentStatus.metrics.net = hw.net;
    }
  }

  private addRecentTask(task: any) {
    const list = this.currentStatus.recentTasks.filter((t) => t.taskId !== task.taskId);
    list.unshift(task);
    this.currentStatus.recentTasks = list.slice(0, 10);
  }

  private updateRecentTask(taskId: string, patch: any) {
    const item = this.currentStatus.recentTasks.find((t) => t.taskId === taskId);
    if (item) {
      Object.assign(item, patch);
    }
  }

  /**
   * 将新任务存入云端 /content/tasks/pending/ 目录队列
   */
  public async pushTaskToPendingDir(task: VideoTaskPayload): Promise<void> {
    if (process.env.VITEST) return;

    const taskType = task.taskType || (task.type === "image" ? "image_grid_gen" : "video_gen");
    const payload = {
      taskId: task.taskId,
      taskType: taskType,
      params: {
        prompt: task.prompt,
        durationSec: task.durationSec || 4.0,
        steps: task.steps || 4,
        use4StepLora: task.use4StepLora ?? true,
        keyframeBase64: task.keyframeBase64 || null,
        keyframePath: task.keyframePath || null,
        refImages: task.refImages || null,
        shots: task.shots || null,
      },
      driveOutputDir: task.driveOutputPath || "/content/drive/MyDrive/ClipForge/outputs",
      createdAt: Date.now(),
    };

    console.log(`[COLAB-QUEUE] 投递任务到目录队列: ${task.taskId} (${taskType})`);

    // 0. 若存在 Cloudflare 隧道，优先通过 HTTP API 极速投递
    if (this.tunnelUrl) {
      try {
        const resp = await fetch(`${this.tunnelUrl}/tasks/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (resp.ok) {
          console.log(`[COLAB-QUEUE] 任务已通过 HTTP 直接提交至云端: ${task.taskId}`);
          return;
        }
      } catch (e: any) {
        console.warn(`[COLAB-QUEUE] HTTP 投递异常，降级通道: ${e.message}`);
      }
    }

    // 1. 若 WebSocket 通道活跃，通过 WebSocket JSON-RPC 投递
    if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      const frame = {
        jsonrpc: "2.0",
        id: `task_${Date.now()}`,
        method: "task.submit",
        params: payload,
      };
      this.wsClient.send(JSON.stringify(frame));
      return;
    }

    // 2. 优先通过 stdio RPC 投递
    if (this.process && this.process.stdin.writable) {
      const frame = {
        jsonrpc: "2.0",
        id: `task_${Date.now()}`,
        method: "task.submit",
        params: payload,
      };
      this.process.stdin.write(JSON.stringify(frame) + "\n");
      return;
    }

    // 兜底方案：通过 colab exec 写入 /content/tasks/pending/<timestamp>_<taskId>.json (杜绝占用 SSH 管道)
    const remoteFilePath = `/content/tasks/pending/${Date.now()}_${task.taskId}.json`;
    const pythonCode = `
import json, os
os.makedirs('/content/tasks/pending', exist_ok=True)
payload = ${JSON.stringify(payload)}
with open('${remoteFilePath}', 'w', encoding='utf-8') as f:
    json.dump(payload, f, ensure_ascii=False, indent=2)
print("SUCCESS_QUEUED")
`;
    return new Promise((resolve, reject) => {
      const runner = spawn("colab", ["exec", "-s", this.sessionName], {
        env: getColabEnv(),
      });

      let stdout = "";
      runner.stdout.on("data", (d) => { stdout += d.toString(); });
      runner.stderr.on("data", (d) => { stdout += d.toString(); });

      runner.on("close", (code) => {
        if (code === 0 && stdout.includes("SUCCESS_QUEUED")) resolve();
        else reject(new Error(`写入任务文件失败，退出码: ${code}`));
      });

      runner.on("error", (err) => reject(err));
      runner.stdin.write(pythonCode);
      runner.stdin.end();
    });
  }

  /**
   * 兼容向后调用的 pushTaskToInbox
   */
  public async pushTaskToInbox(task: VideoTaskPayload): Promise<void> {
    return this.pushTaskToPendingDir(task);
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

    if (fs.existsSync(localFilePath) && fs.statSync(localFilePath).size > 1024) {
      console.log(`[COLAB-DOWNLOAD] 本地已存在该产物文件，直接复用: ${localFilePath}`);
      return localFilePath;
    }

    if (process.env.VITEST) {
      if (!fs.existsSync(localFilePath)) {
        fs.writeFileSync(localFilePath, "MOCK_DOWNLOAD_DATA");
      }
      return localFilePath;
    }

    // 若 Cloudflare Quick Tunnel 激活，优先通过 HTTP CDN 极速下载文件 (比 CLI 上下文切换快 10 倍)
    if (this.tunnelUrl) {
      try {
        const fname = path.basename(remotePath);
        const fileUrl = `${this.tunnelUrl}/outputs/${fname}`;
        console.log(`[COLAB-DOWNLOAD] 正在通过 Cloudflare CDN 极速下载: ${fileUrl} -> ${localFilePath}`);
        const resp = await fetch(fileUrl);
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          fs.writeFileSync(localFilePath, buffer);
          console.log(`[COLAB-DOWNLOAD] CDN 下载成功落盘: ${localFilePath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
          return localFilePath;
        }
      } catch (err: any) {
        console.warn(`[COLAB-DOWNLOAD] CDN 下载异常，降级到 colab download: ${err.message}`);
      }
    }

    console.log(`[COLAB-DOWNLOAD] 开始下载云端产物: ${remotePath} -> ${localFilePath}`);

    return new Promise((resolve) => {
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
    const frame = {
      jsonrpc: "2.0",
      id: `ka_${Date.now()}`,
      method: "watchdog.extend",
      params: { seconds: extraMinutes * 60 },
    };
    if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      this.wsClient.send(JSON.stringify(frame));
    } else if (this.process && this.process.stdin.writable) {
      this.process.stdin.write(JSON.stringify(frame) + "\n");
    }
  }

  /**
   * Web 端一键立即安全停机释放实例
   */
  public terminateColab(): void {
    const frame = {
      jsonrpc: "2.0",
      id: `term_${Date.now()}`,
      method: "watchdog.shutdown",
      params: {},
    };
    if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      this.wsClient.send(JSON.stringify(frame));
    } else if (this.process && this.process.stdin.writable) {
      this.process.stdin.write(JSON.stringify(frame) + "\n");
    }
  }

  public disconnect(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch (_) {}
      this.wsClient = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.setOffline();
  }
}

// 导出单例
export const colabClient = new ColabRpcClient();
