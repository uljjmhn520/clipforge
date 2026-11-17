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
  Maximize2,
  X,
  Sparkles,
  Send,
  Video,
} from "lucide-react";

interface InstallProgress {
  stage: string;
  percent: number;
  speed_mbps: number;
  message: string;
  log_tail: string[];
}

interface TaskLiveProgress {
  taskId: string;
  taskType: "image_grid_gen" | "video_render" | "video_shot_gen" | string;
  stage: string;
  percent: number;
  message: string;
  currentStep?: number;
  totalSteps?: number;
  shotIndex?: number;
  totalShots?: number;
  elapsedSec?: number;
}

interface ActiveProjectShot {
  id: number;
  type: string;
  description: string;
  voiceover: string;
  durationSec: number;
  status: "pending" | "approved" | "rendering" | "done";
  keyframeUrl?: string | null;
  videoUrl?: string | null;
}

interface CompletedMediaItem {
  name: string;
  url: string;
  type: "image" | "video";
  sizeMb: number;
}

interface ActiveProject {
  id: string;
  name: string;
  productName?: string;
  status: string;
  shots: ActiveProjectShot[];
  completedMedia: CompletedMediaItem[];
  gridFullUrl?: string | null;
}

interface ColabStatus {
  online: boolean;
  sessionName: string;
  lifecycle: "INIT_BOOT" | "RPC_READY" | "INSTALLING_MODELS" | "IDLE" | "BUSY" | "OFFLINE";
  state: "IDLE" | "BUSY" | "INIT" | "OFFLINE";
  currentTaskId: string | null;
  currentTask?: any;
  currentProgress?: TaskLiveProgress | null;
  activeProject?: ActiveProject | null;
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
  const [showLogs, setShowLogs] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [previewMedia, setPreviewMedia] = useState<{ url: string; type: "image" | "video"; title: string } | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "keyframes" | "videos">("keyframes");

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

  // 1.5秒短轮询探针
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

  const formatMediaUrl = (url?: string | null): string => {
    if (!url) return "";
    if (url.includes("/public/outputs/")) return "/outputs/" + url.split("/public/outputs/")[1];
    if (url.includes("/public/uploads/")) return "/uploads/" + url.split("/public/uploads/")[1];
    if (url.includes("/outputs/")) return "/outputs/" + url.split("/outputs/")[1];
    if (url.includes("/uploads/")) return "/uploads/" + url.split("/uploads/")[1];
    return url;
  };

  const getLifecycleBadge = () => {
    if (isPoweringOn || status?.isPoweringOn) {
      return (
        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30 flex items-center gap-1.5 animate-pulse">
          <RotateCw className="w-3.5 h-3.5 animate-spin" />
          正在开机并部署穿透双向服务...
        </span>
      );
    }
    if (!status?.online) {
      if (status?.lifecycle === "INIT_BOOT" || status?.state === "INIT") {
        return (
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1.5 animate-pulse">
            <RotateCw className="w-3.5 h-3.5 animate-spin" />
            {status?.installProgress?.message || "实例已就绪，正在连接 WebSocket..."}
          </span>
        );
      }
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
        <span className="px-3 py-1 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1.5 animate-pulse">
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

  const isTaskActive =
    status?.state === "BUSY" ||
    Boolean(status?.currentTaskId) ||
    Boolean(status?.currentTask) ||
    Boolean(
      status?.currentProgress &&
        status.currentProgress.percent > 0 &&
        status.currentProgress.stage !== "idle"
    );

  const projectShots = status?.activeProject?.shots || [];
  const readyKeyframesCount = projectShots.filter((s) => Boolean(s.keyframeUrl)).length;
  const readyVideosCount = projectShots.filter((s) => Boolean(s.videoUrl)).length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      {/* 顶部导航 */}
      <header className="border-b border-zinc-800 bg-zinc-900/90 backdrop-blur sticky top-0 z-50 px-6 py-3.5 flex items-center justify-between shadow-md">
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
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-cyan-300 border border-zinc-700">
                {status?.sessionName || "clipforge_helloworld1234"}
              </span>
            </h1>
            <p className="text-xs text-zinc-400">
              单镜头生图/生视频细粒度进度 · 3x3 九宫格分镜母图 · 异步离线消费队列 · 双阶看门狗
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
                onClick={() => handleAction("dispatch_local")}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-900/40 hover:bg-cyan-800/60 text-cyan-200 border border-cyan-700/50 flex items-center gap-1.5"
                title="手动扫描本地任务并派发到云端"
              >
                <Send className="w-3.5 h-3.5 text-cyan-400" />
                派发本地队列
              </button>
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
      <div className="bg-zinc-900 border-b border-zinc-800/80 px-6 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <ShieldCheck className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-zinc-200">两阶段全周期安全看门狗</span>
              {status?.isWatchdogFrozen ? (
                <span className="text-[10px] bg-cyan-500/20 text-cyan-300 px-2 py-0.5 rounded font-medium">
                  🔒 渲染/生成中：倒计时绝对冻结
                </span>
              ) : (
                <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded font-medium">
                  ⏱️ 空闲倒计时中
                </span>
              )}
            </div>
            <p className="text-[11px] text-zinc-400">
              云端连续空闲超 5 分钟自动安全释放，杜绝忘关机导致算力点扣除。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[10px] text-zinc-400 font-medium">自动关机剩余时间</div>
            <div className="text-base font-mono font-bold text-amber-400">
              {status?.isWatchdogFrozen ? "FROZEN" : formatSeconds(status?.idleSecondsLeft ?? 300)}
            </div>
          </div>
        </div>
      </div>

      {/* 主体看板布局 */}
      <main className="flex-1 p-6 space-y-6 max-w-7xl mx-auto w-full">
        {/* 0. 核心重点：当前实时细粒度任务渲染进度卡片 (Live Generation Progress) */}
        {isTaskActive && (
          <section className="bg-gradient-to-r from-cyan-950/40 via-zinc-900 to-indigo-950/30 rounded-2xl border border-cyan-500/40 p-5 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-500 via-indigo-500 to-emerald-500 animate-pulse" />
            
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-cyan-500/20 text-cyan-300">
                    <Sparkles className="w-4 h-4 animate-spin" />
                  </span>
                  <h2 className="text-base font-bold text-cyan-200">
                    {status?.currentProgress?.taskType === "image_grid_gen" ||
                    status?.currentTask?.taskType === "image_grid_gen"
                      ? "文生图 3x3 九宫格生成中 (MiniMax-H3-Image 极速加速)"
                      : "图生视频 4步渲染中 (MiniMax-H3 Video DMAD)"}
                  </h2>
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    Task ID: {status?.currentProgress?.taskId || status?.currentTask?.taskId || status?.currentTaskId || "运行中"}
                  </span>
                </div>
                <p className="text-xs text-zinc-300 mt-1">
                  {status?.currentProgress?.message || status?.currentTask?.params?.prompt || "正在进行 ComfyUI 扩散去噪渲染..."}
                </p>
              </div>

              {/* 右侧阶段指示与步数 */}
              <div className="flex items-center gap-4 text-xs font-mono">
                {status?.currentProgress?.shotIndex && status?.currentProgress?.totalShots && (
                  <div className="px-3 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 text-center">
                    <div className="text-[10px] text-zinc-400">分镜进度</div>
                    <div className="font-bold text-amber-300">
                      镜头 {status.currentProgress.shotIndex} / {status.currentProgress.totalShots}
                    </div>
                  </div>
                )}
                {status?.currentProgress?.currentStep !== undefined && status?.currentProgress?.totalSteps && (
                  <div className="px-3 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 text-center">
                    <div className="text-[10px] text-zinc-400">扩散去噪步数</div>
                    <div className="font-bold text-cyan-300">
                      Step {status.currentProgress.currentStep} / {status.currentProgress.totalSteps}
                    </div>
                  </div>
                )}
                <div className="px-3 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 text-center">
                  <div className="text-[10px] text-zinc-400">已耗时</div>
                  <div className="font-bold text-emerald-300">
                    {status?.currentProgress?.elapsedSec ?? 0}s
                  </div>
                </div>
              </div>
            </div>

            {/* 大进度条 */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs font-medium text-zinc-300">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                  当前阶段:{" "}
                  <strong className="text-cyan-300">
                    {status?.currentProgress?.stage || "diffusion_denoising"}
                  </strong>
                </span>
                <span className="text-cyan-300 font-mono font-bold text-sm">
                  {status?.currentProgress?.percent ?? 5}%
                </span>
              </div>
              <div className="w-full bg-zinc-800 rounded-full h-3 overflow-hidden p-0.5 border border-cyan-500/30">
                <div
                  className="bg-gradient-to-r from-cyan-500 via-blue-500 to-emerald-400 h-2 rounded-full transition-all duration-300 shadow-lg shadow-cyan-500/50"
                  style={{ width: `${Math.max(5, Math.min(100, status?.currentProgress?.percent ?? 5))}%` }}
                />
              </div>
            </div>
          </section>
        )}

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
              <span className="text-emerald-400 font-semibold">ℹ️ 负载解析：</span>
              MiniMax 扩散与去噪在 GPU 运行，CPU 仅作 I/O 调度，负载偏低 (5%~15%) 属健康状态。
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
              <span className="text-cyan-300 font-medium">{status?.state === "BUSY" ? "🔥 全负荷扩散中" : "🟢 待命中"}</span>
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
              <span className="text-indigo-300">
                {status?.gpuMemoryUsedMb && status.gpuMemoryUsedMb > 1000
                  ? "MiniMax 权重加载就绪"
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
              <span>aria2 多线程管道</span>
              <span className="text-amber-300">{status?.installProgress.speed_mbps ? "极速拉取中" : "空闲"}</span>
            </div>
          </div>
        </section>

        {/* 2. 核心可视化分镜展示区：每张图与每个视频的生成进度 */}
        <section className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-6 space-y-6 shadow-xl">
          {/* 头部标题与切换 Tab */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-zinc-800">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                  <Film className="w-5 h-5 text-cyan-400" />
                  当前工程镜头生成看板：
                  <span className="text-cyan-300 font-semibold">
                    {status?.activeProject?.name || "冷萃浓缩咖啡液带货视频"}
                  </span>
                </h2>
              </div>
              <div className="flex items-center gap-4 text-xs text-zinc-400 mt-1">
                <span>镜头总数: <strong>{projectShots.length || 9}</strong> 镜</span>
                <span>•</span>
                <span className="text-emerald-400">关键帧已就绪: <strong>{readyKeyframesCount}</strong> / {projectShots.length || 9}</span>
                <span>•</span>
                <span className="text-indigo-400">分镜视频已就绪: <strong>{readyVideosCount}</strong> / {projectShots.length || 9}</span>
              </div>
            </div>

            {/* Tab 切换 */}
            <div className="flex items-center gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
              <button
                onClick={() => setActiveTab("keyframes")}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                  activeTab === "keyframes"
                    ? "bg-zinc-800 text-cyan-300 border border-zinc-700 shadow"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <ImageIcon className="w-3.5 h-3.5" />
                3x3 九宫格关键帧生图 ({readyKeyframesCount}/{projectShots.length || 9})
              </button>
              <button
                onClick={() => setActiveTab("videos")}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                  activeTab === "videos"
                    ? "bg-zinc-800 text-indigo-300 border border-zinc-700 shadow"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Video className="w-3.5 h-3.5" />
                分镜图生视频生成 ({readyVideosCount}/{projectShots.length || 9})
              </button>
            </div>
          </div>

          {/* TAB 1: 3x3 九宫格生图看板 */}
          {activeTab === "keyframes" && (
            <div className="space-y-5">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <p>
                  MiniMax-H3-Image 采用单次 6 步扩散极速生成 3x3 全景母图并毫秒级几何切片，彻底消除多次排队延迟。
                </p>
                {status?.activeProject?.gridFullUrl && (
                  <button
                    onClick={() =>
                      setPreviewMedia({
                        url: status.activeProject!.gridFullUrl!,
                        type: "image",
                        title: "3x3 九宫格高分母图 (原图预览)",
                      })
                    }
                    className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 bg-cyan-950/40 border border-cyan-800/50 px-3 py-1.5 rounded-lg transition"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    查看 3x3 九宫格母图原图
                  </button>
                )}
              </div>

              {/* 3x3 矩阵网格 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {(projectShots.length > 0
                  ? projectShots
                  : [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
                      id: i,
                      type: "demo",
                      description: `分镜画面描述 ${i}`,
                      voiceover: `配音文案 ${i}`,
                      durationSec: 3.5,
                      status: "pending" as const,
                      keyframeUrl: null,
                    }))
                ).map((shot: any) => {
                  const isRendering =
                    status?.state === "BUSY" &&
                    status?.currentProgress?.taskType === "image_grid_gen";
                  const hasImage = Boolean(shot.keyframeUrl);

                  return (
                    <div
                      key={shot.id}
                      className={`group relative rounded-xl border p-3 flex flex-col justify-between transition-all duration-200 overflow-hidden ${
                        hasImage
                          ? "bg-zinc-950/70 border-zinc-800 hover:border-cyan-500/50"
                          : isRendering
                          ? "bg-cyan-950/20 border-cyan-500/50 animate-pulse"
                          : "bg-zinc-950/40 border-zinc-800/80"
                      }`}
                    >
                      {/* 镜头编号与类型 */}
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-bold font-mono text-zinc-300 flex items-center gap-1">
                          <span className="w-5 h-5 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[10px] text-cyan-300">
                            #{shot.id}
                          </span>
                          <span className="capitalize text-zinc-400">{shot.type || "分镜"}</span>
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-zinc-400 font-mono">
                            {shot.durationSec || 3.5}s
                          </span>
                          {hasImage ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                              <CheckCircle2 className="w-2.5 h-2.5" />
                              就绪
                            </span>
                          ) : isRendering ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 animate-pulse">
                              渲染中
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                              待生成
                            </span>
                          )}
                        </div>
                      </div>

                      {/* 图片预览区域 (9:16 缩略图) */}
                      <div className="relative aspect-[9/16] max-h-56 w-full rounded-lg bg-zinc-900 border border-zinc-800 overflow-hidden flex items-center justify-center mb-2.5">
                        {hasImage ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={formatMediaUrl(shot.keyframeUrl)}
                              alt={`Shot ${shot.id}`}
                              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105 cursor-pointer"
                              onClick={() =>
                                setPreviewMedia({
                                  url: formatMediaUrl(shot.keyframeUrl),
                                  type: "image",
                                  title: `镜头 #${shot.id} 关键帧切片原图`,
                                })
                              }
                            />
                            <button
                              onClick={() =>
                                setPreviewMedia({
                                  url: formatMediaUrl(shot.keyframeUrl),
                                  type: "image",
                                  title: `镜头 #${shot.id} 关键帧切片原图`,
                                })
                              }
                              className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-black/60 text-white hover:bg-black/80 backdrop-blur transition"
                              title="点击放大查看"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                          </>
                        ) : (
                          <div className="text-center p-3 text-zinc-500 flex flex-col items-center">
                            {isRendering ? (
                              <>
                                <RotateCw className="w-6 h-6 text-cyan-400 animate-spin mb-1" />
                                <span className="text-[11px] text-cyan-300">GPU 扩散去噪中...</span>
                              </>
                            ) : (
                              <>
                                <ImageIcon className="w-6 h-6 text-zinc-600 mb-1" />
                                <span className="text-[11px]">等待生成九宫格</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>

                      {/* 描述与文案 */}
                      <div className="space-y-1">
                        <p className="text-[11px] text-zinc-300 line-clamp-2 leading-relaxed">
                          {shot.description || "视觉画面正在规划中"}
                        </p>
                        {shot.voiceover && (
                          <p className="text-[10px] text-zinc-400 line-clamp-1 italic">
                            🗣️ {shot.voiceover}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2: 分镜图生视频看板 */}
          {activeTab === "videos" && (
            <div className="space-y-5">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <p>
                  MiniMax-H3 图生视频 (DMAD 4 步加速)，以切片关键帧为首帧进行动态连续去噪，生成带动态光影的 9:16 成片片段。
                </p>
              </div>

              {/* 视频分镜流水线列表 */}
              <div className="space-y-4">
                {projectShots.map((shot: any) => {
                  const isCurrentShotRendering =
                    status?.state === "BUSY" &&
                    (status?.currentProgress?.taskType === "video_render" ||
                      status?.currentProgress?.taskType === "video_shot_gen") &&
                    (status?.currentProgress?.shotIndex === shot.id ||
                      status?.currentTaskId?.includes(`shot_${shot.id}`));
                  const hasVideo = Boolean(shot.videoUrl);

                  return (
                    <div
                      key={shot.id}
                      className={`p-4 rounded-xl border transition-all ${
                        hasVideo
                          ? "bg-zinc-950/70 border-zinc-800"
                          : isCurrentShotRendering
                          ? "bg-indigo-950/30 border-indigo-500/50 shadow-lg shadow-indigo-500/10"
                          : "bg-zinc-950/40 border-zinc-800/80"
                      }`}
                    >
                      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        {/* 左侧信息 */}
                        <div className="flex items-start gap-3 flex-1">
                          {/* 关键帧缩略图 */}
                          <div className="w-16 h-28 rounded-lg bg-zinc-900 border border-zinc-800 overflow-hidden flex-shrink-0 relative">
                            {shot.keyframeUrl ? (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img
                                src={shot.keyframeUrl}
                                alt={`Shot ${shot.id}`}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-600">
                                无首帧
                              </div>
                            )}
                            <div className="absolute top-1 left-1 bg-black/60 rounded px-1 text-[9px] font-mono text-white">
                              #{shot.id}
                            </div>
                          </div>

                          <div className="space-y-1.5 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-zinc-200">
                                镜头 #{shot.id} · {shot.type || "分镜片段"}
                              </span>
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">
                                预估时长: {shot.durationSec || 3.5}s
                              </span>
                              {hasVideo ? (
                                <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-1 font-semibold">
                                  <CheckCircle2 className="w-3 h-3" />
                                  视频已合成落盘
                                </span>
                              ) : isCurrentShotRendering ? (
                                <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 animate-pulse flex items-center gap-1 font-semibold">
                                  <RotateCw className="w-3 h-3 animate-spin" />
                                  DMAD 4 步扩散渲染中...
                                </span>
                              ) : (
                                <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-500">
                                  排队等待中
                                </span>
                              )}
                            </div>

                            <p className="text-xs text-zinc-300 leading-relaxed">
                              {shot.description}
                            </p>
                            {shot.voiceover && (
                              <p className="text-[11px] text-zinc-400 italic">
                                🎙️ 配音: {shot.voiceover}
                              </p>
                            )}

                            {/* 如果当前分镜正在渲染，显示动态渲染步数 */}
                            {isCurrentShotRendering && (
                              <div className="pt-2 max-w-md space-y-1">
                                <div className="flex justify-between text-[11px] text-indigo-300 font-mono">
                                  <span>Step {status?.currentProgress?.currentStep ?? 1} / 4 (去噪进度)</span>
                                  <span>{status?.currentProgress?.percent ?? 25}%</span>
                                </div>
                                <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                                  <div
                                    className="bg-indigo-400 h-1.5 rounded-full transition-all duration-300"
                                    style={{ width: `${status?.currentProgress?.percent ?? 25}%` }}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* 右侧：视频播放器或操作 */}
                        <div className="flex-shrink-0 flex items-center gap-3">
                          {hasVideo ? (
                            <div className="flex items-center gap-2">
                              <video
                                src={formatMediaUrl(shot.videoUrl)}
                                controls
                                className="w-32 h-44 rounded-lg bg-black border border-zinc-700 object-cover"
                              />
                              <div className="flex flex-col gap-1.5">
                                <button
                                  onClick={() =>
                                    setPreviewMedia({
                                      url: formatMediaUrl(shot.videoUrl),
                                      type: "video",
                                      title: `镜头 #${shot.id} 视频片段回放`,
                                    })
                                  }
                                  className="px-2.5 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 text-xs flex items-center gap-1 transition"
                                >
                                  <Maximize2 className="w-3 h-3" />
                                  大屏回放
                                </button>
                                <a
                                  href={formatMediaUrl(shot.videoUrl)}
                                  download
                                  className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-xs flex items-center gap-1 transition"
                                >
                                  <Download className="w-3 h-3" />
                                  下载 MP4
                                </a>
                              </div>
                            </div>
                          ) : (
                            <div className="w-32 h-44 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col items-center justify-center text-zinc-500 text-xs text-center p-2">
                              {isCurrentShotRendering ? (
                                <>
                                  <RotateCw className="w-6 h-6 text-indigo-400 animate-spin mb-2" />
                                  <span className="text-[11px] text-indigo-300 font-mono">
                                    {status?.currentProgress?.elapsedSec ?? 0}s 渲染中
                                  </span>
                                </>
                              ) : (
                                <>
                                  <Video className="w-6 h-6 text-zinc-600 mb-1" />
                                  <span>待生成视频</span>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* 3. 已落盘产物资产库 (Completed Media Gallery) */}
        {status?.activeProject?.completedMedia && status.activeProject.completedMedia.length > 0 && (
          <section className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                  <Film className="w-4 h-4 text-emerald-400" />
                  已落盘高分辨率资产列表 ({status.activeProject.completedMedia.length} 项)
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  所有从云端 Colab 完成并同步落盘到本地的 3x3 九宫格大图、切片与视频片段
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {status.activeProject.completedMedia.map((m, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80 hover:border-zinc-700 flex items-center justify-between text-xs transition"
                >
                  <div className="flex items-center gap-2.5 truncate mr-2">
                    <span className="p-1.5 rounded-lg bg-zinc-800 text-zinc-300">
                      {m.type === "image" ? (
                        <ImageIcon className="w-3.5 h-3.5 text-cyan-400" />
                      ) : (
                        <Video className="w-3.5 h-3.5 text-indigo-400" />
                      )}
                    </span>
                    <div className="truncate">
                      <div className="font-semibold text-zinc-200 truncate">{m.name}</div>
                      <div className="text-[10px] text-zinc-500 font-mono">{m.sizeMb} MB</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() =>
                        setPreviewMedia({
                          url: m.url,
                          type: m.type,
                          title: m.name,
                        })
                      }
                      className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition"
                      title="预览"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    <a
                      href={m.url}
                      download
                      className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white transition"
                      title="下载"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 4. 启动与安装全流程树 (Pipeline Lifecycle) */}
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
              <p className="text-[11px] opacity-80">/content/tasks/pending 扫描消费</p>
            </div>
          </div>

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

        {/* 5. 任务流水线看板 (本地队列与云端队列) */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* 左侧：队列状态 */}
          <div className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-6 space-y-4">
            <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-cyan-400" />
              异步任务队列状态监控
            </h2>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3.5 rounded-xl bg-zinc-950/60 border border-zinc-800 flex flex-col justify-between">
                <span className="text-zinc-400 font-medium">本地待消费队列</span>
                <span className="font-mono font-bold text-amber-400 text-lg my-1">
                  {status?.localPendingTasksCount ?? 0} 个任务
                </span>
                <span className="text-[10px] text-zinc-500">
                  Colab 关机时安全暂存，开机后自动扫描上传并消费
                </span>
              </div>
              <div className="p-3.5 rounded-xl bg-zinc-950/60 border border-zinc-800 flex flex-col justify-between">
                <span className="text-zinc-400 font-medium">云端接收待渲染</span>
                <span className="font-mono font-bold text-cyan-400 text-lg my-1">
                  {status?.pendingTasksCount ?? 0} 个任务
                </span>
                <span className="text-[10px] text-zinc-500">
                  /content/tasks/pending/ 云端目录
                </span>
              </div>
            </div>
          </div>

          {/* 右侧：最近任务记录 */}
          <div className="bg-zinc-900/90 rounded-2xl border border-zinc-800 p-6 space-y-4">
            <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              最近云端任务执行记录
            </h2>

            <div className="space-y-2.5 max-h-[160px] overflow-y-auto pr-1">
              {status?.recentTasks && status.recentTasks.length > 0 ? (
                status.recentTasks.map((t, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80 flex items-center justify-between text-xs"
                  >
                    <div className="space-y-0.5 truncate mr-2">
                      <div className="font-semibold text-zinc-200 flex items-center gap-1.5 truncate">
                        {t.status === "completed" ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        ) : t.status === "running" ? (
                          <RotateCw className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                        ) : (
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                        )}
                        <span className="truncate">{t.taskId}</span>
                      </div>
                      <div className="text-[11px] text-zinc-400 truncate">{t.message}</div>
                    </div>
                    {t.outputFile && (
                      <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 flex-shrink-0">
                        {t.elapsedSec ? `${t.elapsedSec}s` : "已落盘"}
                      </span>
                    )}
                  </div>
                ))
              ) : (
                <div className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-6 text-center text-zinc-500 text-xs">
                  暂无历史任务执行记录
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {/* 媒体预览弹窗 Modal */}
      {previewMedia && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPreviewMedia(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-4xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl relative"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
              <span className="text-xs font-bold text-zinc-200">{previewMedia.title}</span>
              <button
                onClick={() => setPreviewMedia(null)}
                className="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 flex items-center justify-center bg-black/50 overflow-auto">
              {previewMedia.type === "image" ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={previewMedia.url}
                  alt={previewMedia.title}
                  className="max-h-[75vh] w-auto rounded-lg object-contain"
                />
              ) : (
                <video
                  src={previewMedia.url}
                  controls
                  autoPlay
                  className="max-h-[75vh] w-auto rounded-lg"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
