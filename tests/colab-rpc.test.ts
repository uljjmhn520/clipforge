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

  it("4. 处理 task.completed 事件通知", async () => {
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
});
