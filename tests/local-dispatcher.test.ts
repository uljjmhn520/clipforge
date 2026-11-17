import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { localTaskDispatcher } from "@/lib/modules/state-machine/local-dispatcher";
import { taskManager } from "@/lib/modules/state-machine/task-manager";
import { colabClient } from "@/lib/modules/colab-rpc/client";
import { db } from "@/lib/db";
import { projects, cloudTasks } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";

describe("本地目录任务队列消费与重生成任务机制测试", () => {
  let testProjectId = "";
  const pendingDir = path.join(process.cwd(), "data", "local_tasks", "pending");
  const dispatchedDir = path.join(process.cwd(), "data", "local_tasks", "dispatched");

  beforeAll(async () => {
    // 创建初始测试项目
    const p = await taskManager.createProject({
      name: "本地队列测试商品",
      productName: "便携筋膜枪",
      productDescription: "深层肌群放松，6档调节",
      productPrice: "¥129",
      productImages: ["data:image/png;base64,mock"],
    });
    testProjectId = p.id;
  });

  afterAll(() => {
    // 清理测试项目在本地的 pending 任务
    localTaskDispatcher.cleanPendingTasksForProject(testProjectId);
  });

  it("1. 离线状态下提交生图任务，应安全存入本地 pending 目录，状态为 waiting_for_cloud", async () => {
    // 模拟云端离线状态
    (colabClient as any).currentStatus.online = false;
    (colabClient as any).currentStatus.lifecycle = "OFFLINE";

    // 录入脚本分镜
    await taskManager.updateProjectScript(testProjectId, {
      title: "筋膜枪广告",
      shots: [
        {
          id: 1,
          type: "hook",
          description: "久坐白领肩颈酸痛",
          voiceover: "每天坐8小时，脖子僵硬难受？",
          durationSec: 4,
          status: "pending",
        },
      ],
      externalPrompt: "fascia gun commercial 3x3 grid",
    });

    // 触发 MiniMax-H3-Image 生图任务
    const task = await taskManager.submitGridImageToCloudQueue(
      testProjectId,
      "test_session",
      ["data:image/png;base64,ref1"]
    );

    expect(task).toBeDefined();
    expect(task.shotId).toBe(0);

    // 验证数据库状态
    const dbTask = await db.query.cloudTasks.findFirst({
      where: eq(cloudTasks.id, task.id),
    });
    expect(dbTask?.state).toBe("waiting_for_cloud");

    // 验证本地 pending 目录中存在任务文件
    const pendingTasks = localTaskDispatcher.getPendingTasks();
    const matched = pendingTasks.find((t) => t.task.taskId === task.id);
    expect(matched).toBeDefined();
    expect(matched?.task.type).toBe("image");
    expect(matched?.task.projectId).toBe(testProjectId);
  });

  it("2. 云端离线时触发消费，本地 pending 任务保持静默，严禁上传", async () => {
    (colabClient as any).currentStatus.online = false;
    const res = await localTaskDispatcher.triggerDispatch();
    expect(res.dispatchedCount).toBe(0);
    expect(res.pendingCount).toBeGreaterThan(0);
  });

  it("3. 云端上线并握手就绪后，本地 pending 任务应被自动消费并移动至 dispatched/", async () => {
    // 模拟云端在线就绪
    (colabClient as any).currentStatus.online = true;
    (colabClient as any).currentStatus.lifecycle = "IDLE";

    // 模拟 pushTaskToInbox 投递成功 (通过 mock 或直接走内存)
    const spyPush = vi.spyOn(colabClient, "pushTaskToInbox").mockResolvedValue();

    const pendingBefore = localTaskDispatcher.getPendingTasks().filter((t) => t.task.projectId === testProjectId);
    expect(pendingBefore.length).toBeGreaterThan(0);

    const res = await localTaskDispatcher.triggerDispatch();
    expect(res.dispatchedCount).toBeGreaterThanOrEqual(1);

    // 验证本地 pending 文件已被原子性移走
    const pendingAfter = localTaskDispatcher.getPendingTasks().filter((t) => t.task.projectId === testProjectId);
    expect(pendingAfter.length).toBe(0);

    // 验证数据库状态已跃迁为 submitted_to_inbox
    const dbTask = await db.query.cloudTasks.findFirst({
      where: eq(cloudTasks.id, pendingBefore[0].task.taskId),
    });
    expect(dbTask?.state).toBe("submitted_to_inbox");

    spyPush.mockRestore();
  });

  it("4. 针对等待中的任务，调用 resubmitProjectTasks 可重新生成任务入队", async () => {
    // 当前项目处于 grid_generating 阶段
    const res = await taskManager.resubmitProjectTasks(testProjectId);
    expect(res.mode).toBe("image");
    expect(res.message).toContain("重新生成");

    // 验证本地 pending 队列再次生成了该项目的任务
    const pending = localTaskDispatcher.getPendingTasks().filter((t) => t.task.projectId === testProjectId);
    expect(pending.length).toBe(1);
    expect(pending[0].task.type).toBe("image");
  });
});
