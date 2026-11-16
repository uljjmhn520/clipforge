import { db } from "@/lib/db";
import { projects, scripts, cloudTasks, compositions, Shot } from "@/lib/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { colabClient } from "../colab-rpc/client";
import { slice3x3GridImage } from "../storyboard/slicer";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

export class TaskManager {
  constructor() {
    // 监听云端完成通知，全自动触发 colab download 与本地挂载
    colabClient.on("task_completed", async (payload: { task_id?: string; drive_file?: string }) => {
      if (payload && payload.task_id) {
        await this.onCloudTaskCompleted(payload.task_id, payload.drive_file || "");
      }
    });
  }
  /**
   * 1. 创建项目草稿
   */
  public async createProject(data: {
    name: string;
    productName: string;
    productCategory?: string;
    productDescription: string;
    productPrice?: string;
    productImages?: string[];
  }) {
    const [project] = await db.insert(projects).values({
      name: data.name,
      productName: data.productName,
      productCategory: data.productCategory,
      productDescription: data.productDescription,
      productPrice: data.productPrice,
      productImages: data.productImages || [],
      status: "draft",
    }).returning();

    return project;
  }

  /**
   * 2. 更新脚本与分镜 (判官质检通过后)
   */
  public async updateProjectScript(projectId: string, scriptData: {
    title: string;
    shots: Shot[];
    judgeReport?: any;
    externalPrompt?: string;
  }) {
    // 检查锁状态：若已经在云端运行，禁止修改
    await this.assertNotLocked(projectId);

    const [script] = await db.insert(scripts).values({
      projectId,
      title: scriptData.title,
      shots: scriptData.shots,
      judgeReport: scriptData.judgeReport,
      externalPrompt: scriptData.externalPrompt,
    }).returning();

    await db.update(projects).set({
      status: "grid_reviewing",
      updatedAt: new Date(),
    }).where(eq(projects.id, projectId));

    return script;
  }

  /**
   * 3. ⚠️ 强人工审核闸门：用户确认九宫格关键帧通过！
   * 只有人工点击此操作，任务才被允许进入云端队列
   */
  public async approveGrid(projectId: string) {
    await this.assertNotLocked(projectId);

    await db.update(projects).set({
      status: "grid_approved",
      updatedAt: new Date(),
    }).where(eq(projects.id, projectId));

    console.log(`[STATE-MACHINE] 项目 ${projectId} 九宫格已人工审核通过！解锁云端视频生成权限。`);
  }

  /**
   * 3.5 提交 MiniMax-H3-Image 九宫格大图生成任务至云端队列
   */
  public async submitGridImageToCloudQueue(projectId: string, sessionName?: string) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project) throw new Error("项目不存在");

    const script = await db.query.scripts.findFirst({
      where: eq(scripts.projectId, projectId),
    });

    if (!script) throw new Error("项目未包含分镜剧本数据");

    const session = sessionName || process.env.COLAB_SESSION_NAME || "clipforge_helloworld1234";
    const driveOutputPath = `${process.env.COLAB_DRIVE_OUTPUT_DIR || "/content/drive/MyDrive/ClipForge/outputs"}/${projectId}_grid_full.png`;

    const prompt = script.externalPrompt || `${project.productName} 3x3 grid commercial keyframes, photorealistic, 9:16 vertical`;

    const [task] = await db.insert(cloudTasks).values({
      projectId,
      shotId: 0, // shotId 0 标记为九宫格大图任务
      sessionName: session,
      state: "submitted_to_inbox",
      isLocked: false,
      driveOutputPath,
    }).returning();

    // 更新项目状态为 grid_reviewing (生成中/等待审核)
    await db.update(projects).set({
      status: "grid_reviewing",
      updatedAt: new Date(),
    }).where(eq(projects.id, projectId));

    try {
      await colabClient.pushTaskToInbox({
        taskId: task.id,
        type: "image",
        prompt,
        driveOutputPath,
      });
      console.log(`[STATE-MACHINE] 九宫格生图任务 ${task.id} 已推入云端 inbox`);
    } catch (err: any) {
      console.warn(`[STATE-MACHINE] Colab 离线或写入异常，九宫格生图任务在本地排队: ${err.message}`);
      await db.update(cloudTasks).set({ state: "waiting_for_cloud" }).where(eq(cloudTasks.id, task.id));
    }

    return task;
  }

  /**
   * 4. 提交至 Colab 视频生成队列 (加锁置灰)
   */
  public async submitToCloudQueue(projectId: string, sessionName?: string) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project) throw new Error("项目不存在");
    if (
      project.status !== "grid_approved" &&
      project.status !== "cloud_running" &&
      project.status !== "completed"
    ) {
      throw new Error("门禁拦截：九宫格关键帧尚未通过人工审核，禁止提交云端任务！");
    }

    const script = await db.query.scripts.findFirst({
      where: eq(scripts.projectId, projectId),
    });

    if (!script || !script.shots) throw new Error("项目未包含有效分镜数据");

    const session = sessionName || process.env.COLAB_SESSION_NAME || "clipforge_helloworld1234";

    // 🔒 状态跃迁至 cloud_running，前端加锁置灰！
    await db.update(projects).set({
      status: "cloud_running",
      updatedAt: new Date(),
    }).where(eq(projects.id, projectId));

    // 检查项目已有的分镜视频任务 (过滤掉 shotId === 0 的九宫格生图任务)
    const existingVideoTasks = await db.query.cloudTasks.findMany({
      where: and(eq(cloudTasks.projectId, projectId), gt(cloudTasks.shotId, 0)),
    });

    for (const shot of script.shots) {
      const existingTask = existingVideoTasks.find((t) => t.shotId === shot.id);
      const driveOutputPath = `${process.env.COLAB_DRIVE_OUTPUT_DIR || "/content/outputs"}/${projectId}_shot_${shot.id}.mp4`;

      let taskToPush = existingTask;

      if (!existingTask) {
        const [newTask] = await db.insert(cloudTasks).values({
          projectId,
          shotId: shot.id,
          sessionName: session,
          state: "submitted_to_inbox",
          isLocked: true,
          driveOutputPath,
        }).returning();
        taskToPush = newTask;
      }

      // 获取关键帧切片 (Base64 形式打包下发)
      let keyframeBase64: string | undefined = undefined;
      const candidatePaths = [
        shot.keyframePath,
        join(process.cwd(), "public", "uploads", projectId, "slices", `shot_0${shot.id}.png`),
        join(process.cwd(), "public", "uploads", projectId, "slices", `shot_${shot.id}.png`),
      ].filter(Boolean) as string[];

      for (const p of candidatePaths) {
        if (existsSync(p)) {
          try {
            keyframeBase64 = readFileSync(p).toString("base64");
            break;
          } catch (_) {}
        }
      }

      if (taskToPush) {
        try {
          await colabClient.pushTaskToInbox({
            taskId: taskToPush.id,
            type: "video",
            prompt: shot.description,
            durationSec: shot.durationSec,
            keyframeBase64,
            driveOutputPath: taskToPush.driveOutputPath || driveOutputPath,
          });
          await db.update(cloudTasks).set({ state: "submitted_to_inbox" }).where(eq(cloudTasks.id, taskToPush.id));
        } catch (err: any) {
          console.warn(`[STATE-MACHINE] Colab 离线或写入 inbox 异常，任务在本地排队: ${err.message}`);
          await db.update(cloudTasks).set({ state: "waiting_for_cloud" }).where(eq(cloudTasks.id, taskToPush.id));
        }
      }
    }
  }

  /**
   * 5. 云端任务完成回调与自动下载
   */
  public async onCloudTaskCompleted(taskId: string, driveFile: string) {
    await db.update(cloudTasks).set({
      state: "done_in_drive",
      isLocked: false,
      driveOutputPath: driveFile,
      updatedAt: new Date(),
    }).where(eq(cloudTasks.id, taskId));

    console.log(`[STATE-MACHINE] 云端任务 ${taskId} 已完成并在 Drive 落盘: ${driveFile}`);

    // 自动调用 colab download 同步至本地挂载
    try {
      const taskRecord = await db.query.cloudTasks.findFirst({
        where: eq(cloudTasks.id, taskId),
      });

      if (taskRecord && driveFile) {
        // A. 若为九宫格大图任务 (shotId === 0)，下载后自动切片并更新状态
        if (taskRecord.shotId === 0) {
          const localDestDir = join(process.cwd(), "public", "uploads", taskRecord.projectId);
          const localGridPath = await colabClient.downloadFile(driveFile, localDestDir);

          const slicesOutputDir = join(localDestDir, "slices");
          const slices = await slice3x3GridImage(localGridPath, slicesOutputDir);

          const scriptRecord = await db.query.scripts.findFirst({
            where: eq(scripts.projectId, taskRecord.projectId),
          });

          if (scriptRecord && scriptRecord.shots) {
            const updatedShots = scriptRecord.shots.map((shot) => {
              const matched = slices.find((s) => s.index === shot.id);
              return {
                ...shot,
                keyframePath: matched ? matched.filePath : shot.keyframePath,
              };
            });

            await db.update(scripts).set({
              gridImagePath: localGridPath,
              shots: updatedShots,
            }).where(eq(scripts.id, scriptRecord.id));
          }

          await db.update(projects).set({
            status: "grid_reviewing",
            updatedAt: new Date(),
          }).where(eq(projects.id, taskRecord.projectId));

          console.log(`[STATE-MACHINE] MiniMax-H3-Image 九宫格已自动下载并切分 9 张关键帧，等待人工审核！`);
          return;
        }

        // B. 若为分镜短视频任务 (shotId > 0)
        const localDestDir = join(process.cwd(), "public", "outputs", taskRecord.projectId, "clips");
        const localVideoPath = await colabClient.downloadFile(driveFile, localDestDir);

        // 回填至对应的 script.shots
        const scriptRecord = await db.query.scripts.findFirst({
          where: eq(scripts.projectId, taskRecord.projectId),
        });

        if (scriptRecord && scriptRecord.shots) {
          const updatedShots = scriptRecord.shots.map((shot) => {
            if (shot.id === taskRecord.shotId) {
              return {
                ...shot,
                videoPath: localVideoPath,
                status: "done" as const,
              };
            }
            return shot;
          });

          await db.update(scripts).set({
            shots: updatedShots,
          }).where(eq(scripts.id, scriptRecord.id));

          console.log(`[STATE-MACHINE] 分镜 ${taskRecord.shotId} 视频已成功下载并挂载至本地: ${localVideoPath}`);
        }
      }
    } catch (downloadErr) {
      console.warn(`[STATE-MACHINE] 自动下载分镜产物异常:`, downloadErr);
    }
  }

  /**
   * 6. 完成最终成片记录
   */
  public async completeProject(projectId: string, outputPath: string, durationSec: number, fileSizeMb: string) {
    await db.insert(compositions).values({
      projectId,
      outputPath,
      durationSec,
      fileSizeMb,
    });

    await db.update(projects).set({
      status: "completed",
      updatedAt: new Date(),
    }).where(eq(projects.id, projectId));

    console.log(`[STATE-MACHINE] 项目 ${projectId} 已全部交付成片: ${outputPath}`);
  }

  private async assertNotLocked(projectId: string) {
    const runningTask = await db.query.cloudTasks.findFirst({
      where: eq(cloudTasks.projectId, projectId),
    });

    if (runningTask && runningTask.isLocked && runningTask.state === "generating") {
      throw new Error("操作被拒绝：该项目分镜当前正在云端全力渲染中，处于只读锁定保护状态！");
    }
  }
}

export const taskManager = new TaskManager();
