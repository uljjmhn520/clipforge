import { db } from "@/lib/db";
import { projects, scripts, cloudTasks, compositions, Shot } from "@/lib/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { colabClient } from "../colab-rpc/client";
import { localTaskDispatcher } from "./local-dispatcher";
import { slice3x3GridImage } from "../storyboard/slicer";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { normalizeWebPath } from "@/lib/utils/path-helpers";

export class TaskManager {
  constructor() {
    // 监听云端完成通知，全自动触发 colab download 与本地挂载 (兼容 camelCase 与 snake_case)
    colabClient.on("task_completed", async (payload: any) => {
      const taskId = payload?.taskId || payload?.task_id;
      const driveFile = payload?.outputFile || payload?.drive_file || payload?.driveFile || "";
      if (taskId) {
        await this.onCloudTaskCompleted(taskId, driveFile);
      }
    });

    // 监听云端任务流式执行进度通知
    colabClient.on("task_progress", (payload: { task_id?: string; type?: string; percent?: number; step?: string; message?: string }) => {
      if (payload && payload.task_id) {
        console.log(`[STATE-MACHINE] 任务 ${payload.task_id} 进度: ${payload.percent}% (${payload.step}) - ${payload.message}`);
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
  public async submitGridImageToCloudQueue(projectId: string, sessionName?: string, referenceImages?: string[]) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project) throw new Error("项目不存在");

    const script = await db.query.scripts.findFirst({
      where: eq(scripts.projectId, projectId),
    });

    if (!script) throw new Error("项目未包含分镜剧本数据");

    // 门禁拦截：检查参考图
    const effectiveRefImages = (referenceImages && referenceImages.length > 0)
      ? referenceImages
      : (script.referenceImages && Array.isArray(script.referenceImages) ? script.referenceImages : []);

    if (effectiveRefImages.length === 0) {
      throw new Error("门禁拦截：尚未添加任何商品参考图！MiniMax-H3-Image 生成九宫格必须提供参考图。");
    }

    // 若上传了参考图，持久化记录到 scripts
    if (referenceImages && referenceImages.length > 0) {
      await db.update(scripts).set({
        referenceImages,
      }).where(eq(scripts.id, script.id));
    }

    const session = sessionName || process.env.COLAB_SESSION_NAME || "clipforge_helloworld1234";
    const driveOutputPath = `${process.env.COLAB_DRIVE_OUTPUT_DIR || "/content/drive/MyDrive/ClipForge/outputs"}/${projectId}_grid_full.png`;

    const prompt = script.externalPrompt || `${project.productName} 3x3 grid commercial keyframes, photorealistic, 9:16 vertical`;

    const [task] = await db.insert(cloudTasks).values({
      projectId,
      shotId: 0, // shotId 0 标记为九宫格大图任务
      sessionName: session,
      state: "waiting_for_cloud",
      isLocked: false,
      driveOutputPath,
    }).returning();

    // 更新项目状态为 grid_generating (云端生图中 / 本地等待调度)
    await db.update(projects).set({
      status: "grid_generating",
      updatedAt: new Date(),
    }).where(eq(projects.id, projectId));

    // 核心改造：统一通过本地目录队列管理，离线时安全暂存，开机后自动消费上传
    await localTaskDispatcher.enqueueTask({
      taskId: task.id,
      projectId,
      shotId: 0,
      taskType: "image_grid_gen",
      type: "image",
      prompt,
      refImages: effectiveRefImages,
      shots: script.shots || [],
      driveOutputPath,
      createdAt: Date.now(),
      sessionName: session,
    });

    return task;
  }

  /**
   * 4. 提交至 Colab 视频生成队列 (支持全量提交或单分镜增量重渲)
   * 离线友好：若 Colab 尚未开机，生成本地任务并存入本地队列，开机后自动消费上传
   * @param targetShotId 若传入则仅将该单分镜推入云端队列，其他已完成分镜绝对保留
   */
  public async submitToCloudQueue(projectId: string, sessionName?: string, targetShotId?: number) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project) throw new Error("项目不存在");
    if (
      project.status !== "grid_approved" &&
      project.status !== "cloud_running" &&
      project.status !== "clips_ready" &&
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

    const shotsToProcess = targetShotId
      ? script.shots.filter((s) => s.id === targetShotId)
      : script.shots;

    for (const shot of shotsToProcess) {
      const existingTask = existingVideoTasks.find((t) => t.shotId === shot.id);
      const driveOutputPath = `${process.env.COLAB_DRIVE_OUTPUT_DIR || "/content/outputs"}/${projectId}_shot_${shot.id}.mp4`;

      let taskToPush = existingTask;

      if (!existingTask) {
        const [newTask] = await db.insert(cloudTasks).values({
          projectId,
          shotId: shot.id,
          sessionName: session,
          state: "waiting_for_cloud",
          isLocked: true,
          driveOutputPath,
        }).returning();
        taskToPush = newTask;
      } else {
        await db.update(cloudTasks).set({
          state: "waiting_for_cloud",
          updatedAt: new Date(),
        }).where(eq(cloudTasks.id, existingTask.id));
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
        // 核心改造：统一写入本地目录队列
        await localTaskDispatcher.enqueueTask({
          taskId: taskToPush.id,
          projectId,
          shotId: shot.id,
          taskType: "video_gen",
          type: "video",
          prompt: shot.description,
          durationSec: shot.durationSec,
          keyframeBase64,
          driveOutputPath: taskToPush.driveOutputPath || driveOutputPath,
          createdAt: Date.now(),
          sessionName: session,
        });
      }
    }
  }

  /**
   * 4.5 重新生成/入队任务 (针对等待 MiniMax-H3/Image 执行任务的情况)
   * 支持用户在任务排队或异常时手动重新生成任务并放回本地队列消费
   */
  public async resubmitProjectTasks(projectId: string): Promise<{ mode: "image" | "video"; message: string }> {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    });

    if (!project) throw new Error("项目不存在");

    // 清理该项目在本地 pending 目录中的旧任务
    localTaskDispatcher.cleanPendingTasksForProject(projectId);

    // 1. 若处于生图阶段 (grid_generating 或 尚未审核九宫格)
    if (project.status === "grid_generating" || project.status === "grid_reviewing") {
      // 重置该项目的 shotId === 0 的 cloudTasks
      await db.update(cloudTasks).set({
        state: "waiting_for_cloud",
        updatedAt: new Date(),
      }).where(and(eq(cloudTasks.projectId, projectId), eq(cloudTasks.shotId, 0)));

      await this.submitGridImageToCloudQueue(projectId);
      return {
        mode: "image",
        message: "MiniMax-H3-Image 九宫格生图任务已重新生成，已推入本地队列等待消费分发！",
      };
    }

    // 2. 若处于视频生成阶段 (cloud_running / cloud_queued / grid_approved / clips_ready)
    if (
      project.status === "cloud_running" ||
      project.status === "cloud_queued" ||
      project.status === "grid_approved" ||
      project.status === "clips_ready"
    ) {
      await db.update(cloudTasks).set({
        state: "waiting_for_cloud",
        updatedAt: new Date(),
      }).where(and(eq(cloudTasks.projectId, projectId), gt(cloudTasks.shotId, 0)));

      await this.submitToCloudQueue(projectId);
      return {
        mode: "video",
        message: "MiniMax-H3 图生视频任务已重新生成，已推入本地队列等待消费分发！",
      };
    }

    throw new Error(`当前项目状态 (${project.status}) 不属于等待 MiniMax 生成任务的阶段`);
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
              const kf = matched ? (normalizeWebPath(matched.filePath) || matched.filePath) : (normalizeWebPath(shot.keyframePath) || shot.keyframePath);
              return {
                ...shot,
                keyframePath: kf || undefined,
              };
            });

            await db.update(scripts).set({
              gridImagePath: normalizeWebPath(localGridPath) || localGridPath,
              shots: updatedShots,
            }).where(eq(scripts.id, scriptRecord.id));
          }

          // ⚠️ 防状态覆盖：仅在项目仍处于 grid_generating 时跃迁为 grid_reviewing
          const curProject = await db.query.projects.findFirst({
            where: eq(projects.id, taskRecord.projectId),
          });
          if (curProject && curProject.status === "grid_generating") {
            await db.update(projects).set({
              status: "grid_reviewing",
              updatedAt: new Date(),
            }).where(eq(projects.id, taskRecord.projectId));
          }

          console.log(`[STATE-MACHINE] MiniMax-H3-Image 九宫格已自动下载并切分 9 张关键帧，等待人工审核！`);
          return;
        }

        // B. 若为分镜短视频任务 (shotId > 0)
        const localDestDir = join(process.cwd(), "public", "outputs", taskRecord.projectId, "clips");
        const localVideoPath = await colabClient.downloadFile(driveFile, localDestDir);
        const webVideoPath = normalizeWebPath(localVideoPath) || localVideoPath;

        // 回填至对应的 script.shots
        const scriptRecord = await db.query.scripts.findFirst({
          where: eq(scripts.projectId, taskRecord.projectId),
        });

        if (scriptRecord && scriptRecord.shots) {
          const updatedShots = scriptRecord.shots.map((shot) => {
            if (shot.id === taskRecord.shotId) {
              return {
                ...shot,
                videoPath: webVideoPath,
                status: "done" as const,
              };
            }
            return shot;
          });

          await db.update(scripts).set({
            shots: updatedShots,
          }).where(eq(scripts.id, scriptRecord.id));

          console.log(`[STATE-MACHINE] 分镜 ${taskRecord.shotId} 视频已成功下载并挂载至本地: ${localVideoPath}`);

          // 检查是否全部分镜视频皆已就绪
          const allShotsDone = updatedShots.length > 0 && updatedShots.every((s) => s.status === "done" && s.videoPath);
          if (allShotsDone) {
            await db.update(projects).set({
              status: "clips_ready",
              updatedAt: new Date(),
            }).where(eq(projects.id, taskRecord.projectId));
            console.log(`[STATE-MACHINE] 🎉 项目 ${taskRecord.projectId} 的 ${updatedShots.length} 个分镜视频已全部就绪！状态跃迁为 clips_ready。`);
          }
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
