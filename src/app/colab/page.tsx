"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  Activity,
  Cpu,
  HardDrive,
  Zap,
  Clock,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  Play,
  Square,
  RotateCw,
  Download,
  Layers,
  Wifi,
  Film,
  Image as ImageIcon,
  ArrowLeft,
  ExternalLink,
  ShieldCheck,
  Eye,
  RefreshCw,
  FolderOpen,
  Info,
} from "lucide-react";

interface InstallProgress {
  stage: string;
  percent: number;
  speed_mbps: number;
  message: string;
  log_tail: string[];
}

interface ColabStatus {
  online: boolean;
  sessionName: string;
  lifecycle: "INIT_BOOT" | "RPC_READY" | "INSTALLING_MODELS" | "IDLE" | "BUSY" | "OFFLINE";
  state: "IDLE" | "BUSY" | "INIT" | "OFFLINE";
  currentTaskId: string | null;
  currentTask?: any;
  pendingTasksCount: number;
  localPendingTasksCount?: number;
  gpuMemoryUsedMb: number;
  gpuMemoryTotalMb: number;
  idleSecondsLeft: number;
  isWatchdogFrozen: boolean;
  isPoweringOn: boolean;
  installProgress: InstallProgress;
  metrics: {
    cpu?: { percent: number; note?: string };
    ram?: { usedMb: number; totalMb: number; percent: number };
    gpu?: { name: string; utilizationPercent: number; memoryUsedMb: number; memoryTotalMb: number; memoryPercent: number };
    net?: { downloadSpeedMbps: number };
  };
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

export default function ColabMonitorPage() {
  const [status, setStatus] = useState<ColabStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPoweringOn, setIsPoweringOn] = useState(false);
  const [showLogs, setShowLogs] = useState(true);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/colab/status");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        if (data.isPoweringOn !== undefined) {
          setIsPoweringOn(data.isPoweringOn);
        }
      }
    } catch (err) {
      console.error("拉取 Colab 状态异常:", err);
    } finally {
      setLoading(false);
    }
  };

  // 高频 1.5 秒短轮询
  useEffect(() => {
    fetchStatus();
    const timer = setInterval(fetchStatus, 1500);
    return () => clearInterval(timer);
  }, []);

  const handleAction = async (action: string, payload: any = {}) => {
    setActionMessage("正在发送指令...");
    try {
      const res = await fetch("/api/colab/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = await res.json();
      if (data.message) {
        setActionMessage(data.message);
      } else if (data.error) {
        setActionMessage(`错误: ${data.error}`);
      }
      setTimeout(fetchStatus, 500);
    } catch (err: any) {
      setActionMessage(`请求失败: ${err.message}`);
    } finally {
      setTimeout(() => setActionMessage(null), 5000);
    }
  };

  const formatSeconds = (sec: number) => {
    if (sec < 0) return "--:--";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const getLifecycleBadge = () => {
    if (!status?.online) {
      return (
        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-zinc-500" />
          离线 (OFFLINE)
        </span>
      );
    }
    if (status.lifecycle === "INSTALLING_MODELS") {
      return (
        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30 flex items-center gap-1.5 animate-pulse">
          <RotateCw className="w-3.5 h-3.5 animate-spin" />
          正在多线程拉取依赖与模型 (40GB+)
        </span>
      );
    }
    if (status.state === "BUSY" || status.lifecycle === "BUSY") {
      return (
        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 text-cyan-400" />
          正在执行扩散渲染 (BUSY)
        </span>
      );
    }
    return (
      <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
        节点完全就绪 (IDLE 监听中)
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* 顶部导航 */}
      <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur sticky top-0 z-50 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs font-semibold text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded-lg border border-zinc-700 transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            返回主创作工作台
          </Link>
          <div className="h-5 w-[1px] bg-zinc-800" />
          <div>
            <h1 className="font-bold text-base flex items-center gap-2">
              Colab 云端渲染算力控制中心
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                {status?.sessionName || "clipforge_helloworld1234"}
              </span>
            </h1>
            <p className="text-xs text-zinc-400">
              三层架构：秒级双向通道 · 目录文件队列 · 实时硬件异构监控 · 双阶安全看门狗
            </p>
          </div>
        </div>

        {/* 右侧状态与操作 */}
        <div className="flex items-center gap-3">
          {getLifecycleBadge()}

          {!status?.online ? (
            <button
              onClick={() => handleAction("power_on", { gpu: "L4" })}
              disabled={isPoweringOn}
              className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-black flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {isPoweringOn ? "正在开机并握手..." : "一键启动 L4 云端节点"}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleAction("keep_alive", { minutes: 15 })}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 flex items-center gap-1.5"
                title="重置并延长 15 分钟看门狗空闲时间"
              >
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                续命 +15 分钟
              </button>
              <button
                onClick={() => {
                  if (confirm("确定要释放停机 Colab 实例吗？未完成任务将保留在本地队列。")) {
                    handleAction("terminate");
                  }
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center gap-1.5"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                安全关机
              </button>
            </div>
          )}

          <button
            onClick={fetchStatus}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
            title="手动刷新"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* 提示信息横幅 */}
      {actionMessage && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/20 px-6 py-2 text-xs text-emerald-300 flex items-center justify-between">
          <span>{actionMessage}</span>
          <button onClick={() => setActionMessage(null)} className="text-emerald-400 font-bold">
            ✕
          </button>
        </div>
      )}

      {/* 看门狗安全保护条 */}
      <div className="bg-zinc-900 border-b border-zinc-800/80 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-zinc-200">两阶段全周期安全看门狗</span>
              {status?.isWatchdogFrozen ? (
                <span className="text-[10px] bg-cyan-500/20 text-cyan-300 px-2 py-0.5 rounded font-medium">
                  🔒 渲染/安装中：倒计时冻结
                </span>
              ) : (
                <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded font-medium">
                  ⏱️ 空闲倒计时中
                </span>
              )}
            </div>
            <p className="text-[11px] text-zinc-400">
              云端实例连续空闲超过 5 分钟将自动安全关机，杜绝忘关机导致算力点扣除；任务执行期间绝对冻结。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-xs text-zinc-400 font-medium">自动关机剩余时间</div>
            <div className="text-lg font-mono font-bold text-amber-400">
              {status?.isWatchdogFrozen ? "FROZEN" : formatSeconds(status?.idleSecondsLeft ?? 300)}
            </div>
          </div>
        </div>
      </div>

      {/* 主体看板布局 */}
      <main className="flex-1 p-6 space-y-6 max-w-7xl mx-auto w-full">
        {/* 1. 硬件实时异构仪表盘 */}
        <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* CPU 卡片 */}
          <div className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-400 flex items-center gap-1.5">
                <Cpu className="w-4 h-4 text-emerald-400" />
                CPU 核心负载
              </span>
              <span className="text-lg font-bold font-mono text-zinc-100">
                {status?.metrics.cpu?.percent ?? 0}%
              </span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-2 mb-3 overflow-hidden">
              <div
                className="bg-emerald-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, status?.metrics.cpu?.percent ?? 0)}%` }}
              />
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed bg-zinc-950/60 p-2 rounded-lg border border-zinc-800/80">
              <span className="text-emerald-400 font-semibold">ℹ️ 异构解析：</span>
              MiniMax 扩散与去噪完全在 GPU 运行，CPU 仅作 I/O 调度，负载偏低 (5%~15%) 为健康状态。
            </p>
          </div>

          {/* GPU 卡片 */}
          <div className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-400 flex items-center gap-1.5">
                <Zap className="w-4 h-4 text-cyan-400" />
                {status?.metrics.gpu?.name || "NVIDIA L4"}
              </span>
              <span className="text-lg font-bold font-mono text-cyan-400">
                {status?.metrics.gpu?.utilizationPercent ?? 0}%
              </span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-2 mb-3 overflow-hidden">
              <div
                className="bg-cyan-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, status?.metrics.gpu?.utilizationPercent ?? 0)}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-zinc-400">
              <span>CUDA 算力核心</span>
              <span>{status?.state === "BUSY" ? "🔥 全负荷扩散中" : "🟢 待命中"}</span>
            </div>
          </div>

          {/* 显存 VRAM 卡片 */}
          <div className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-400 flex items-center gap-1.5">
                <HardDrive className="w-4 h-4 text-indigo-400" />
                显存占用 (VRAM)
              </span>
              <span className="text-lg font-bold font-mono text-indigo-300">
                {(status?.gpuMemoryUsedMb ? status.gpuMemoryUsedMb / 1024 : 0).toFixed(1)} /{" "}
                {(status?.gpuMemoryTotalMb ? status.gpuMemoryTotalMb / 1024 : 22.4).toFixed(1)} GB
              </span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-2 mb-3 overflow-hidden">
              <div
                className="bg-indigo-500 h-2 rounded-full transition-all duration-500"
                style={{
                  width: `${
                    status?.gpuMemoryTotalMb
                      ? (status.gpuMemoryUsedMb / status.gpuMemoryTotalMb) * 100
                      : 0
                  }%`,
                }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-zinc-400">
              <span>模型显存驻留</span>
              <span>
                {status?.gpuMemoryUsedMb && status.gpuMemoryUsedMb > 1000
                  ? "MiniMax 权重加载完毕"
                  : "待加载"}
              </span>
            </div>
          </div>

          {/* 网络与下载速度卡片 */}
          <div className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-zinc-400 flex items-center gap-1.5">
                <Wifi className="w-4 h-4 text-amber-400" />
                网络瞬时下行速率
              </span>
              <span className="text-lg font-bold font-mono text-amber-400">
                {status?.installProgress.speed_mbps ?? 0} Mbps
              </span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-2 mb-3 overflow-hidden">
              <div
                className="bg-amber-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, (status?.installProgress.speed_mbps ?? 0) / 2)}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-zinc-400">
              <span>多线程 aria2 加速</span>
              <span>{status?.installProgress.speed_mbps ? "极速拉取中" : "空闲"}</span>
            </div>
          </div>
        </section>

        {/* 2. 启动与安装全流程树 (Pipeline Progress) */}
        <section className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <Layers className="w-4 h-4 text-emerald-400" />
                Colab 四阶段执行生命周期流
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                开机即建立双向通信，随后受控后台多线程安装 ComfyUI 与模型，全程透明汇报
              </p>
            </div>
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="text-xs text-zinc-400 hover:text-white flex items-center gap-1 bg-zinc-800 px-2.5 py-1.5 rounded-lg border border-zinc-700"
            >
              <Terminal className="w-3.5 h-3.5" />
              {showLogs ? "收起云端实时日志" : "查看云端实时日志"}
            </button>
          </div>

          {/* 流程进度指示器 */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-2">
            {/* 阶段 1 */}
            <div
              className={`p-3.5 rounded-xl border transition ${
                status?.online
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-zinc-950/60 border-zinc-800 text-zinc-500"
              }`}
            >
              <div className="flex items-center justify-between text-xs font-bold mb-1">
                <span>1. 通信依赖准备</span>
                {status?.online ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Clock className="w-4 h-4" />}
              </div>
              <p className="text-[11px] opacity-80">极速安装 psutil (&lt;5秒)</p>
            </div>

            {/* 阶段 2 */}
            <div
              className={`p-3.5 rounded-xl border transition ${
                status?.online
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-zinc-950/60 border-zinc-800 text-zinc-500"
              }`}
            >
              <div className="flex items-center justify-between text-xs font-bold mb-1">
                <span>2. 建立双向通信</span>
                {status?.online ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Clock className="w-4 h-4" />}
              </div>
              <p className="text-[11px] opacity-80">OpenSSH stdio 握手成功</p>
            </div>

            {/* 阶段 3 */}
            <div
              className={`p-3.5 rounded-xl border transition ${
                status?.installProgress.percent === 100
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : status?.lifecycle === "INSTALLING_MODELS"
                  ? "bg-amber-500/10 border-amber-500/30 text-amber-300 animate-pulse"
                  : "bg-zinc-950/60 border-zinc-800 text-zinc-500"
              }`}
            >
              <div className="flex items-center justify-between text-xs font-bold mb-1">
                <span>3. 安装 ComfyUI 与模型</span>
                {status?.installProgress.percent === 100 ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <span className="font-mono text-xs">{status?.installProgress.percent ?? 0}%</span>
                )}
              </div>
              <p className="text-[11px] opacity-80">MiniMax-H3/Image 40GB+ 权重</p>
            </div>

            {/* 阶段 4 */}
            <div
              className={`p-3.5 rounded-xl border transition ${
                status?.state === "BUSY"
                  ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-300"
                  : status?.installProgress.percent === 100
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-zinc-950/60 border-zinc-800 text-zinc-500"
              }`}
            >
              <div className="flex items-center justify-between text-xs font-bold mb-1">
                <span>4. 目录任务队列消费</span>
                {status?.state === "BUSY" ? (
                  <Zap className="w-4 h-4 text-cyan-400 animate-bounce" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                )}
              </div>
              <p className="text-[11px] opacity-80">/content/tasks/pending 扫描</p>
            </div>
          </div>

          {/* 安装进度条 */}
          {status?.lifecycle === "INSTALLING_MODELS" && (
            <div className="space-y-1.5 pt-2">
              <div className="flex justify-between text-xs text-zinc-300 font-medium">
                <span>当前进度: {status.installProgress.message}</span>
                <span className="font-mono text-amber-400">{status.installProgress.percent}%</span>
              </div>
              <div className="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden">
                <div
                  className="bg-gradient-to-r from-amber-500 to-emerald-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${status.installProgress.percent}%` }}
                />
              </div>
            </div>
          )}

          {/* 实时终端日志流 */}
          {showLogs && (
            <div className="bg-black/80 rounded-xl border border-zinc-800 p-4 font-mono text-xs text-zinc-300 space-y-1 max-h-48 overflow-y-auto">
              <div className="text-zinc-400 pb-1 border-b border-zinc-800/80 flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-emerald-400" />
                  云端 runner.py 实时输出日志流
                </span>
                <span>行数: {status?.installProgress.log_tail?.length ?? 0}</span>
              </div>
              {status?.installProgress.log_tail && status.installProgress.log_tail.length > 0 ? (
                status.installProgress.log_tail.map((l, i) => (
                  <div key={i} className="leading-relaxed hover:text-white transition">
                    <span className="text-zinc-600 select-none mr-2">›</span>
                    {l}
                  </div>
                ))
              ) : (
                <div className="text-zinc-400 italic py-2">等待云端日志推入...</div>
              )}
            </div>
          )}
        </section>

        {/* 3. 任务流水线看板 (当前执行、等待队列与已完成) */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* 左侧：正在执行与等待队列 */}
          <div className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-6 space-y-4">
            <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-cyan-400" />
              任务目录队列 (/content/tasks/pending/)
            </h2>

            {/* 当前执行卡片 */}
            {status?.currentTask ? (
              <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-cyan-300 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                    正在渲染: {status.currentTask.taskId}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-mono">
                    {status.currentTask.taskType === "image_grid_gen" ? "文生图 3x3 九宫格" : "图生视频 4步 DMAD"}
                  </span>
                </div>
                <p className="text-xs text-zinc-300 line-clamp-2">
                  提示词: {status.currentTask.params?.prompt || "无描述"}
                </p>
                <div className="text-[11px] text-zinc-400 pt-1">
                  时长: {status.currentTask.params?.durationSec || 4}s | 步数:{" "}
                  {status.currentTask.params?.steps || 4} 步 (DMAD 加速)
                </div>
              </div>
            ) : (
              <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-6 text-center text-zinc-400 text-xs">
                当前暂无正在执行的任务，Colab 处于监听空闲状态
              </div>
            )}

            {/* 本地队列与云端等待队列数量 */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800 flex flex-col justify-between">
                <span className="text-zinc-400">本地待消费队列</span>
                <span className="font-mono font-bold text-amber-400 text-sm mt-1">
                  {status?.localPendingTasksCount ?? 0} 个
                </span>
                <span className="text-[10px] text-zinc-400">离线时安全暂存，开机后自动消费</span>
              </div>
              <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800 flex flex-col justify-between">
                <span className="text-zinc-400">云端接收待渲染</span>
                <span className="font-mono font-bold text-cyan-400 text-sm mt-1">
                  {status?.pendingTasksCount ?? 0} 个
                </span>
                <span className="text-[10px] text-zinc-400">/content/tasks/pending/</span>
              </div>
            </div>
          </div>

          {/* 右侧：最近任务记录与成片落盘 */}
          <div className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-6 space-y-4">
            <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <Film className="w-4 h-4 text-emerald-400" />
              最近任务状态与产物落盘
            </h2>

            <div className="space-y-2.5 max-h-[300px] overflow-y-auto pr-1">
              {status?.recentTasks && status.recentTasks.length > 0 ? (
                status.recentTasks.map((t, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80 flex items-center justify-between text-xs"
                  >
                    <div className="space-y-0.5">
                      <div className="font-semibold text-zinc-200 flex items-center gap-1.5">
                        {t.status === "completed" ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        ) : t.status === "running" ? (
                          <RotateCw className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                        ) : (
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                        )}
                        {t.taskId}
                      </div>
                      <div className="text-[11px] text-zinc-400">{t.message}</div>
                    </div>
                    {t.outputFile && (
                      <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                        {t.elapsedSec ? `${t.elapsedSec}s` : "已落盘"}
                      </span>
                    )}
                  </div>
                ))
              ) : (
                <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-6 text-center text-zinc-400 text-xs">
                  暂无历史任务执行记录
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
