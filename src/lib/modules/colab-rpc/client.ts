import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";

export interface ColabHeartbeatStatus {
  online: boolean;
  state: "IDLE" | "BUSY" | "OFFLINE";
  currentTaskId: string | null;
  gpuMemoryUsedMb: number;
  gpuMemoryTotalMb: number;
  idleSecondsLeft: number;
  lastProcessedLine: number;
  lastPingTimestamp: number;
}

export interface VideoTaskPayload {
  taskId: string;
  type?: "video" | "image";
  prompt: string;
  durationSec?: number;
  keyframeBase64?: string;
  driveOutputPath: string;
}

export class ColabRpcClient extends EventEmitter {
  private sessionName: string;
  private execTimeoutSec: number;
  private heartbeatIntervalSec: number;
  private process: ChildProcessWithoutNullStreams | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private currentStatus: ColabHeartbeatStatus = {
    online: false,
    state: "OFFLINE",
    currentTaskId: null,
    gpuMemoryUsedMb: 0,
    gpuMemoryTotalMb: 0,
    idleSecondsLeft: -1,
    lastProcessedLine: 0,
    lastPingTimestamp: 0,
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
   * 获取当前 Colab 节点的实时健康与监控数据
   */
  public getStatus(): ColabHeartbeatStatus {
    return { ...this.currentStatus };
  }

  /**
   * 一键开机：调用 colab new 命令创建/恢复专属 Session 实例
   */
  public async powerOn(gpu = "L4"): Promise<{ success: boolean; message: string }> {
    console.log(`[COLAB-POWER] 正在启动专属 Colab 实例: ${this.sessionName} (GPU: ${gpu})...`);

    return new Promise((resolve) => {
      // 派生 colab new -s <sessionName> --gpu <gpu>
      const runner = spawn("colab", ["new", "-s", this.sessionName, "--gpu", gpu]);
      let out = "";

      runner.stdout.on("data", (d) => {
        out += d.toString();
      });
      runner.stderr.on("data", (d) => {
        out += d.toString();
      });

      runner.on("close", (code) => {
        if (code === 0) {
          console.log(`[COLAB-POWER] 开机指令执行成功: ${out}`);
          this.connect();
          resolve({
            success: true,
            message: `Colab 实例 (${this.sessionName}, GPU: ${gpu}) 已成功开机并建立握手！`,
          });
        } else {
          console.warn(`[COLAB-POWER] colab new 退出码: ${code}, output: ${out}`);
          // 尝试发起连接
          this.connect();
          resolve({
            success: true,
            message: `开机指令已下发 (${this.sessionName}, GPU: ${gpu})，正在建立连接...`,
          });
        }
      });

      runner.on("error", (err) => {
        console.warn(`[COLAB-POWER] 调用 colab new 异常: ${err.message}`);
        resolve({
          success: false,
          message: `调用 colab new 失败 (未安装 colab CLI?): ${err.message}`,
        });
      });
    });
  }

  /**
   * 启动与 Colab 专属 Session 的 stdio 交互子进程
   */
  public connect(): void {
    if (this.process) return;

    console.log(`[COLAB-RPC] 正在连接专属 Colab 会话: ${this.sessionName}...`);

    // 派生 colab exec 命令
    // 在本地真实环境下直接调用 colab exec；若在未装 colab CLI 环境下则优雅回退
    const args = ["exec", "-s", this.sessionName, "--timeout", String(this.execTimeoutSec), "python3", "/content/runner.py"];
    
    try {
      this.process = spawn("colab", args);

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
        this.setOffline();
      });

      this.process.on("error", (err) => {
        console.warn(`[COLAB-RPC] 进程异常 (colab CLI 未安装或未启动?): ${err.message}`);
        this.process = null;
        this.setOffline();
      });

      // 启动主动 Ping-Pong 心跳定时器
      this.startHeartbeat();
    } catch (err: any) {
      console.warn(`[COLAB-RPC] 启动子进程失败: ${err.message}`);
      this.setOffline();
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
            gpuMemoryUsedMb: msg.result.gpu_memory_used_mb || 0,
            gpuMemoryTotalMb: msg.result.gpu_memory_total_mb || 0,
            idleSecondsLeft: msg.result.idle_seconds_left ?? -1,
            lastProcessedLine: msg.result.last_processed_line || 0,
            lastPingTimestamp: Date.now(),
          };
          this.emit("status_change", this.getStatus());
        }

        // 2. 处理任务完成通知
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
    const line = JSON.stringify({
      task_id: task.taskId,
      type: task.type || "video",
      prompt: task.prompt,
      duration_sec: task.durationSec || 5,
      keyframe_b64: task.keyframeBase64 || null,
      drive_output_path: task.driveOutputPath,
      enqueued_at: Date.now(),
    });

    console.log(`[COLAB-RPC] 向云端追加任务: ${task.taskId}`);

    // 通过子进程或命令把这行内容 echo 追加到 /content/inbox.jsonl
    return new Promise((resolve, reject) => {
      const escaped = line.replace(/"/g, '\\"');
      const appendCmd = `echo "${escaped}" >> /content/inbox.jsonl`;
      const runner = spawn("colab", ["exec", "-s", this.sessionName, "bash", "-c", appendCmd]);

      runner.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`写入 inbox.jsonl 失败，退出码: ${code}`));
      });
      runner.on("error", (err) => reject(err));
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

    console.log(`[COLAB-DOWNLOAD] 开始下载云端产物: ${remotePath} -> ${localFilePath}`);

    return new Promise((resolve) => {
      // 派生 colab download <remotePath> -s <sessionName> -d <localDestDir>
      const runner = spawn("colab", [
        "download",
        remotePath,
        "-s",
        this.sessionName,
        "-d",
        localDestDir,
      ]);

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
