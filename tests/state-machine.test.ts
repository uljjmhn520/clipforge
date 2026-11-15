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
  });

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
});
