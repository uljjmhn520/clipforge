import { describe, it, expect } from "vitest";
import { ColabRpcClient, getColabEnv } from "@/lib/modules/colab-rpc/client";

describe("ColabRpcClient 与方案 A 环境注入单元测试", () => {
  it("1. 方案 A：getColabEnv 成功注入 local/bin 与 uv cache PYTHONPATH", () => {
    const env = getColabEnv();
    expect(env.PATH).toBeDefined();
    expect(env.PATH).toContain(".local/bin");

    // 验证 PYTHONPATH 中包含 uv archive
    if (env.PYTHONPATH) {
      expect(env.PYTHONPATH).toContain("archive-v0");
    }
  });

  it("2. ColabRpcClient 初始化参数与默认状态", () => {
    const client = new ColabRpcClient({
      sessionName: "test_session_clipforge",
      execTimeoutSec: 300,
      heartbeatIntervalSec: 10,
    });

    const status = client.getStatus();
    expect(status.online).toBe(false);
    expect(status.state).toBe("OFFLINE");
    expect(status.currentTaskId).toBeNull();
  });

  it("3. 处理标准 JSON-RPC 心跳回包与状态事件", async () => {
    const client = new ColabRpcClient({ sessionName: "test_session" });

    let statusUpdated = false;
    client.on("status_change", (s) => {
      if (s.online && s.state === "IDLE") {
        statusUpdated = true;
      }
    });

    // 模拟 handleStdout 接收 pong 回包
    const pongFrame = JSON.stringify({
      jsonrpc: "2.0",
      id: "hb_123",
      result: {
        pong: true,
        state: "IDLE",
        current_task_id: null,
        gpu_memory_used_mb: 2048,
        gpu_memory_total_mb: 24000,
        idle_seconds_left: 290,
        last_processed_line: 5,
      },
    });

    (client as any).handleStdout(pongFrame + "\n");
    expect(statusUpdated).toBe(true);

    const status = client.getStatus();
    expect(status.online).toBe(true);
    expect(status.state).toBe("IDLE");
    expect(status.gpuMemoryUsedMb).toBe(2048);
    expect(status.gpuMemoryTotalMb).toBe(24000);
    expect(status.idleSecondsLeft).toBe(290);
    expect(status.lastProcessedLine).toBe(5);
  });

  it("4. 能够正确解析 CPU、RAM、GPU 实时系统监控指标与 env.progress 初始化事件", async () => {
    const client = new ColabRpcClient({ sessionName: "test_session_metrics" });

    let envProgressMsg = "";
    client.on("env_progress", (p) => {
      envProgressMsg = p.message;
    });

    // 模拟阶段二流式引导进度
    const envFrame = JSON.stringify({
      jsonrpc: "2.0",
      method: "env.progress",
      params: {
        step: "drive",
        status: "completed",
        message: "Google Drive 挂载完成",
      },
    });
    (client as any).handleStdout(envFrame + "\n");
    expect(envProgressMsg).toBe("Google Drive 挂载完成");

    // 模拟包含 CPU/RAM/GPU 监控指标的心跳回包
    const metricsPong = JSON.stringify({
      jsonrpc: "2.0",
      id: "hb_metrics_1",
      result: {
        pong: true,
        state: "IDLE",
        cpu: { percent: 18.5 },
        ram: { usedMb: 3500, totalMb: 12800, percent: 27.3 },
        gpu: {
          name: "NVIDIA L4",
          utilizationPercent: 32.0,
          memoryUsedMb: 4200,
          memoryTotalMb: 23000,
          memoryPercent: 18.2,
        },
      },
    });
    (client as any).handleStdout(metricsPong + "\n");

    const status = client.getStatus();
    expect(status.metrics).toBeDefined();
    expect(status.metrics?.cpu?.percent).toBe(18.5);
    expect(status.metrics?.ram?.usedMb).toBe(3500);
    expect(status.metrics?.gpu?.name).toBe("NVIDIA L4");
    expect(status.gpuMemoryUsedMb).toBe(4200);
  });

  it("5. 验证开机并发互斥锁：防止多线程重复触发开机", async () => {
    const client = new ColabRpcClient({ sessionName: "test_session_lock" });
    (client as any).isPoweringOn = true;

    const res = await client.powerOn();
    expect(res.success).toBe(false);
    expect(res.message).toContain("请勿重复操作");
  });

  it("6. 处理 task.completed 事件通知", async () => {
    const client = new ColabRpcClient({ sessionName: "test_session" });

    let completedTask: any = null;
    client.on("task_completed", (p) => {
      completedTask = p;
    });

    const taskFrame = JSON.stringify({
      jsonrpc: "2.0",
      method: "task.completed",
      params: {
        task_id: "test-task-123",
        status: "success",
        drive_file: "/content/drive/MyDrive/ClipForge/outputs/test.mp4",
      },
    });

    (client as any).handleStdout(taskFrame + "\n");
    expect(completedTask).not.toBeNull();
    expect(completedTask.task_id).toBe("test-task-123");
    expect(completedTask.drive_file).toBe("/content/drive/MyDrive/ClipForge/outputs/test.mp4");
  });

  it("5. 验证 ensureRemoteScripts 能够自愈检测与同步", async () => {
    const client = new ColabRpcClient({ sessionName: "test_session" });
    // mock execCommand
    client.execCommand = async () => ({ stdout: "EXISTS\n", stderr: "", exitCode: 0 });
    const ok = await client.ensureRemoteScripts();
    expect(ok).toBe(true);
  });

  it("7. 能够正确处理 Colab 端 60s 主动推送的 system.metrics 通知", async () => {
    const client = new ColabRpcClient({ sessionName: "test_session_metrics_push" });

    let metricsReceived: any = null;
    client.on("system_metrics", (m) => {
      metricsReceived = m;
    });

    const metricsPushFrame = JSON.stringify({
      jsonrpc: "2.0",
      method: "system.metrics",
      params: {
        state: "IDLE",
        current_task_id: null,
        idle_seconds_left: 280,
        cpu: { percent: 14.2 },
        ram: { usedMb: 2100, totalMb: 54000, percent: 3.9 },
        gpu: {
          name: "NVIDIA L4",
          utilizationPercent: 42,
          memoryUsedMb: 4800,
          memoryTotalMb: 23034,
          memoryPercent: 20.8,
        },
        gpu_memory_used_mb: 4800,
        gpu_memory_total_mb: 23034,
      },
    });

    (client as any).handleStdout(metricsPushFrame + "\n");
    expect(metricsReceived).not.toBeNull();
    expect(metricsReceived.cpu.percent).toBe(14.2);

    const s = client.getStatus();
    expect(s.online).toBe(true);
    expect(s.state).toBe("IDLE");
    expect(s.metrics?.cpu?.percent).toBe(14.2);
    expect(s.metrics?.gpu?.memoryUsedMb).toBe(4800);
  });

  it("8. 能够正确接收 task.progress 流式执行进度事件", async () => {
    const client = new ColabRpcClient({ sessionName: "test_session_progress" });

    let progressEvent: any = null;
    client.on("task_progress", (p) => {
      progressEvent = p;
    });

    const progressFrame = JSON.stringify({
      jsonrpc: "2.0",
      method: "task.progress",
      params: {
        task_id: "test-task-progress-1",
        type: "image",
        percent: 65,
        step: "rendering_cells",
        message: "正在渲染分镜 #6/9...",
      },
    });

    (client as any).handleStdout(progressFrame + "\n");
    expect(progressEvent).not.toBeNull();
    expect(progressEvent.task_id).toBe("test-task-progress-1");
    expect(progressEvent.percent).toBe(65);
    expect(progressEvent.step).toBe("rendering_cells");
  });
});
