import { describe, it, expect, beforeAll } from "vitest";
import { taskManager } from "@/lib/modules/state-machine/task-manager";
import { db } from "@/lib/db";
import { projects, scripts, cloudTasks, compositions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

describe("状态机调度与只读加锁门禁测试", () => {
  let testProjectId = "";

  beforeAll(async () => {
    // 创建初始测试项目
    const p = await taskManager.createProject({
      name: "冷萃咖啡带货测试",
      productName: "浓缩冷萃咖啡液",
      productDescription: "0脂低卡，3秒即溶，媲美星巴克",
      productPrice: "¥39.9",
    });
    testProjectId = p.id;
  });

  it("1. 初始状态为 draft", async () => {
    const p = await db.query.projects.findFirst({
      where: eq(projects.id, testProjectId),
    });
    expect(p?.status).toBe("draft");
  });

  it("2. 更新脚本后状态跃迁至 grid_reviewing", async () => {
    await taskManager.updateProjectScript(testProjectId, {
      title: "打工人的续命咖啡",
      shots: [
        {
          id: 1,
          type: "hook",
          description: "主播皱眉看着星巴克小票",
          voiceover: "就这玩意儿，把我的星巴克钱包给救了！",
          durationSec: 5,
          status: "pending",
        },
      ],
    });

    const p = await db.query.projects.findFirst({
      where: eq(projects.id, testProjectId),
    });
    expect(p?.status).toBe("grid_reviewing");
  });

  it("3. ⚠️ 强门禁：未经人工审核通过，直接提交云端必须抛出异常拦截", async () => {
    await expect(taskManager.submitToCloudQueue(testProjectId)).rejects.toThrow(
      "门禁拦截：九宫格关键帧尚未通过人工审核"
    );
  });

  it("4. 人工点击审核通过后，状态跃迁至 grid_approved 并解锁云端提交", async () => {
    await taskManager.approveGrid(testProjectId);
    const p = await db.query.projects.findFirst({
      where: eq(projects.id, testProjectId),
    });
    expect(p?.status).toBe("grid_approved");

    // 此时提交云端任务应顺畅通过 (即使 Colab 离线也会进入排队，不抛异常)
    await taskManager.submitToCloudQueue(testProjectId);

    const updatedP = await db.query.projects.findFirst({
      where: eq(projects.id, testProjectId),
    });
    expect(updatedP?.status).toBe("cloud_running");
  }, 15000);

  it("5. 任务在云端渲染期间，再次尝试修改脚本必须被只读锁拦截", async () => {
    // 手动模拟设置当前任务正在生成中 (generating)
    await db.update(cloudTasks).set({
      state: "generating",
      isLocked: true,
    }).where(eq(cloudTasks.projectId, testProjectId));

    await expect(
      taskManager.updateProjectScript(testProjectId, {
        title: "恶意并发修改",
        shots: [],
      })
    ).rejects.toThrow("只读锁定保护状态");
  });

  it("6. 云端任务完成与成片终态闭环", async () => {
    const task = await db.query.cloudTasks.findFirst({
      where: eq(cloudTasks.projectId, testProjectId),
    });
    expect(task).toBeDefined();

    if (task) {
      await taskManager.onCloudTaskCompleted(task.id, "/content/drive/MyDrive/outputs/test.mp4");
      const updatedTask = await db.query.cloudTasks.findFirst({
        where: eq(cloudTasks.id, task.id),
      });
      expect(updatedTask?.state).toBe("done_in_drive");
      expect(updatedTask?.isLocked).toBe(false);
    }

    await taskManager.completeProject(testProjectId, "/data/outputs/final.mp4", 30, "15.4");
    const finalP = await db.query.projects.findFirst({
      where: eq(projects.id, testProjectId),
    });
    expect(finalP?.status).toBe("completed");
  });

  it("7. MiniMax-H3-Image 九宫格生图强门禁拦截与参考图检验", async () => {
    // 创建一个新项目
    const gridProject = await taskManager.createProject({
      name: "参考图门禁测试",
      productName: "测试商品",
    });

    await taskManager.updateProjectScript(gridProject.id, {
      title: "九宫格参考图测试脚本",
      shots: [{ id: 1, type: "hook", description: "test", voiceover: "test", durationSec: 5, status: "pending" }],
    });

    // 1. 无参考图提交：必须被强门禁拦截
    await expect(
      taskManager.submitGridImageToCloudQueue(gridProject.id, undefined, [])
    ).rejects.toThrow("门禁拦截：尚未添加任何商品参考图");

    // 2. 携带有效参考图：通过门禁并更新为 grid_generating
    const task = await taskManager.submitGridImageToCloudQueue(gridProject.id, undefined, [
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    ]);
    expect(task).toBeDefined();
    expect(task.shotId).toBe(0);

    const updatedP = await db.query.projects.findFirst({
      where: eq(projects.id, gridProject.id),
    });
    expect(updatedP?.status).toBe("grid_generating");
  });

  it("8. 分镜视频全部完成后状态跃迁至 clips_ready，且防旧九宫格回调状态覆盖", async () => {
    // 创建一个包含 2 个分镜的项目
    const p = await taskManager.createProject({
      name: "clips_ready 状态跃迁测试",
      productName: "测试商品2",
    });

    await taskManager.updateProjectScript(p.id, {
      title: "多镜头测试",
      shots: [
        { id: 1, type: "hook", description: "shot 1", voiceover: "v1", durationSec: 5, status: "pending" },
        { id: 2, type: "cta", description: "shot 2", voiceover: "v2", durationSec: 5, status: "pending" },
      ],
    });

    // 审核通过并提交云端
    await taskManager.approveGrid(p.id);
    await taskManager.submitToCloudQueue(p.id);

    const cloudP = await db.query.projects.findFirst({ where: eq(projects.id, p.id) });
    expect(cloudP?.status).toBe("cloud_running");

    // 模拟云端下发两个镜头任务
    const tasks = await db.query.cloudTasks.findMany({ where: eq(cloudTasks.projectId, p.id) });
    expect(tasks.length).toBe(2);

    // 完成镜头 1
    await taskManager.onCloudTaskCompleted(tasks[0].id, "/content/outputs/test_shot_1.mp4");
    let midP = await db.query.projects.findFirst({ where: eq(projects.id, p.id) });
    expect(midP?.status).toBe("cloud_running"); // 尚未全部完成，保持 cloud_running

    // 完成镜头 2 (全部完成)
    await taskManager.onCloudTaskCompleted(tasks[1].id, "/content/outputs/test_shot_2.mp4");
    let readyP = await db.query.projects.findFirst({ where: eq(projects.id, p.id) });
    expect(readyP?.status).toBe("clips_ready"); // 全部完成，跃迁为 clips_ready

    // 验证防状态覆盖：此时若有 shotId === 0 的九宫格任务回报完成，绝不会将 clips_ready 误退回 grid_reviewing
    const [dummyGridTask] = await db.insert(cloudTasks).values({
      projectId: p.id,
      shotId: 0,
      sessionName: "test",
      state: "submitted_to_inbox",
      isLocked: false,
    }).returning();

    await taskManager.onCloudTaskCompleted(dummyGridTask.id, "/content/outputs/grid_late.png");
    const safeP = await db.query.projects.findFirst({ where: eq(projects.id, p.id) });
    expect(safeP?.status).toBe("clips_ready"); // 依然安全保持为 clips_ready，未被覆盖！
  }, 25000);
});
