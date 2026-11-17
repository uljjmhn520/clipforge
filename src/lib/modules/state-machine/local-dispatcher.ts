import * as fs from "fs";
import * as path from "path";
import { colabClient, VideoTaskPayload } from "../colab-rpc/client";
import { db } from "@/lib/db";
import { cloudTasks } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export interface LocalTaskPayload extends VideoTaskPayload {
  projectId: string;
  shotId: number; // 0: minimax-h3-image 九宫格生图; >0: minimax-h3 图生视频
  taskType?: "video_gen" | "image_grid_gen";
  type?: "video" | "image";
  createdAt: number;
  retryCount?: number;
  sessionName?: string;
}

export class LocalTaskDispatcher {
  private baseDir: string;
  private pendingDir: string;
  private dispatchedDir: string;
  private failedDir: string;
  private pollIntervalTimer: NodeJS.Timeout | null = null;
  private isDispatching: boolean = false;

  constructor() {
    this.baseDir = path.join(process.cwd(), "data", "local_tasks");
    this.pendingDir = path.join(this.baseDir, "pending");
    this.dispatchedDir = path.join(this.baseDir, "dispatched");
    this.failedDir = path.join(this.baseDir, "failed");

    this.ensureDirs();
    this.initEventListeners();
    this.startPeriodicConsumer();
  }

  private ensureDirs() {
    [this.baseDir, this.pendingDir, this.dispatchedDir, this.failedDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  private initEventListeners() {
    // 监听云端就绪事件，一旦 Colab 开机并握手完成，立即触发本地排队任务消费
    colabClient.on("handshake_ready", () => {
      console.log("[LOCAL-DISPATCHER] 收到 Colab 握手就绪信号，立即触发本地任务消费分发...");
      this.triggerDispatch();
    });

    colabClient.on("env_ready", () => {
      console.log("[LOCAL-DISPATCHER] 收到 Colab 模型环境就绪信号，触发本地任务消费分发...");
      this.triggerDispatch();
    });

    colabClient.on("status_change", (status) => {
      if (status && status.online) {
        this.triggerDispatch();
      }
    });
  }

  private startPeriodicConsumer() {
    // 每 3 秒定期巡检本地 pending 目录，若有任务且云端就绪则自动消费
    if (!this.pollIntervalTimer) {
      this.pollIntervalTimer = setInterval(() => {
        this.triggerDispatch().catch(() => {});
      }, 3000);
      // 避免阻止进程优雅退出
      if (this.pollIntervalTimer.unref) {
        this.pollIntervalTimer.unref();
      }
    }
  }

  /**
   * 将任务安全持久化保存至本地 pending 目录队列
   */
  public async enqueueTask(payload: LocalTaskPayload): Promise<string> {
    this.ensureDirs();
    const filename = `${Date.now()}_${payload.taskId}.json`;
    const filePath = path.join(this.pendingDir, filename);

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
    console.log(`[LOCAL-DISPATCHER] 任务已写入本地队列: ${filename} (类型: ${payload.type}, 项目: ${payload.projectId})`);

    // 尝试立刻消费（如果云端恰好在线且就绪）
    setTimeout(() => {
      this.triggerDispatch().catch(() => {});
    }, 100);

    return filePath;
  }

  /**
   * 获取本地 pending 队列中的任务数量
   */
  public getPendingTasksCount(): number {
    try {
      this.ensureDirs();
      return fs.readdirSync(this.pendingDir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  /**
   * 获取本地 pending 任务列表 (按时间戳顺序排列)
   */
  public getPendingTasks(): Array<{ file: string; task: LocalTaskPayload }> {
    try {
      this.ensureDirs();
      const files = fs.readdirSync(this.pendingDir).filter((f) => f.endsWith(".json")).sort();
      const results: Array<{ file: string; task: LocalTaskPayload }> = [];

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(this.pendingDir, file), "utf-8");
          const task = JSON.parse(content) as LocalTaskPayload;
          results.push({ file, task });
        } catch {
          // 容错处理损坏的文件
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  /**
   * 消费并分发本地 pending 任务至云端
   * 门禁准则：只有在 Colab 已开机且双向通信正常时，才上传至云端
   */
  public async triggerDispatch(): Promise<{ dispatchedCount: number; pendingCount: number }> {
    if (this.isDispatching) {
      return { dispatchedCount: 0, pendingCount: this.getPendingTasksCount() };
    }

    const pending = this.getPendingTasks();
    if (pending.length === 0) {
      return { dispatchedCount: 0, pendingCount: 0 };
    }

    // 核心准则检查：Colab 是否开机且双向通信正常
    const status = colabClient.getStatus();
    const isColabReady = status.online && status.lifecycle !== "OFFLINE" && status.lifecycle !== "INIT_BOOT";

    if (!isColabReady) {
      // 云端未开机或处于初始离线状态，严禁上传，静默保留在本地队列
      return { dispatchedCount: 0, pendingCount: pending.length };
    }

    this.isDispatching = true;
    let dispatchedCount = 0;

    try {
      for (const item of pending) {
        const { file, task } = item;
        const sourcePath = path.join(this.pendingDir, file);
        const targetDispatchedPath = path.join(this.dispatchedDir, file);
        const targetFailedPath = path.join(this.failedDir, file);

        try {
          console.log(`[LOCAL-DISPATCHER] Colab 在线且通信正常，开始将本地任务 ${task.taskId} 推送至云端...`);

          // 上传至云端 Colab 的 /content/tasks/pending/ 或通过 stdio RPC 投递
          await colabClient.pushTaskToInbox(task);

          // 上传成功，将本地任务文件原子性移至 dispatched/ 目录
          if (fs.existsSync(sourcePath)) {
            fs.renameSync(sourcePath, targetDispatchedPath);
          }

          // 更新数据库 cloudTasks 状态为 submitted_to_inbox
          await db
            .update(cloudTasks)
            .set({
              state: "submitted_to_inbox",
              updatedAt: new Date(),
            })
            .where(eq(cloudTasks.id, task.taskId));

          dispatchedCount++;
          console.log(`[LOCAL-DISPATCHER] 任务 ${task.taskId} 已成功分发至云端并归档！`);
        } catch (err: any) {
          console.warn(`[LOCAL-DISPATCHER] 推送任务 ${task.taskId} 失败: ${err.message}`);
          task.retryCount = (task.retryCount || 0) + 1;

          // 若重试超过 3 次，移至 failed 目录
          if (task.retryCount >= 3) {
            if (fs.existsSync(sourcePath)) {
              fs.renameSync(sourcePath, targetFailedPath);
            }
            await db
              .update(cloudTasks)
              .set({
                state: "failed",
                error: `本地分发至云端失败: ${err.message}`,
                updatedAt: new Date(),
              })
              .where(eq(cloudTasks.id, task.taskId));
          } else {
            // 更新 retryCount 并保留在 pending 目录等待下次重试
            fs.writeFileSync(sourcePath, JSON.stringify(task, null, 2), "utf-8");
          }
        }
      }
    } finally {
      this.isDispatching = false;
    }

    return { dispatchedCount, pendingCount: this.getPendingTasksCount() };
  }

  /**
   * 清除指定项目的本地 pending 任务（用于重新生成任务前重置）
   */
  public cleanPendingTasksForProject(projectId: string): number {
    this.ensureDirs();
    let cleaned = 0;
    try {
      const files = fs.readdirSync(this.pendingDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const filePath = path.join(this.pendingDir, file);
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const task = JSON.parse(content);
          if (task.projectId === projectId) {
            fs.unlinkSync(filePath);
            cleaned++;
          }
        } catch {}
      }
    } catch {}
    return cleaned;
  }
}

export const localTaskDispatcher = new LocalTaskDispatcher();
