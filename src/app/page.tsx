"use client";

import { useState, useEffect } from "react";
import {
  Sparkles,
  Bot,
  Layers,
  Video,
  Copy,
  CheckCircle2,
  AlertCircle,
  Play,
  RotateCcw,
  Power,
  ShieldCheck,
  Upload,
  ArrowRight,
  Clock,
  HardDrive
} from "lucide-react";

export default function DashboardPage() {
  // 模型与 Colab 状态
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("gemini-3.8-flash");
  const [colabStatus, setColabStatus] = useState<any>({
    online: false,
    state: "OFFLINE",
    idleSecondsLeft: -1,
    gpuMemoryUsedMb: 0,
    gpuMemoryTotalMb: 0,
    sessionName: "clipforge_helloworld1234",
  });

  // 项目与流程状态
  const [activeStep, setActiveStep] = useState<number>(1);
  const [productName, setProductName] = useState<string>("冷萃浓缩咖啡液");
  const [category, setCategory] = useState<string>("冲调饮品");
  const [price, setPrice] = useState<string>("¥39.9");
  const [description, setDescription] = useState<string>(
    "0脂0糖低卡，3秒即溶，还原现磨星巴克美式风味，熬夜早八打工人续命神器，性价比超高"
  );
  const [productImageBase64, setProductImageBase64] = useState<string>("");

  // 生成状态
  const [isGeneratingScript, setIsGeneratingScript] = useState<boolean>(false);
  const [currentProjectId, setCurrentProjectId] = useState<string>("");
  const [scriptData, setScriptData] = useState<any>(null);

  // 九宫格与切片
  const [gridImageBase64, setGridImageBase64] = useState<string>("");
  const [slicedFrames, setSlicedFrames] = useState<Array<{ index: number; url: string }>>([]);
  const [isSlicing, setIsSlicing] = useState<boolean>(false);
  const [isGridApproved, setIsGridApproved] = useState<boolean>(false);

  // 视频与导出
  const [isSubmittingCloud, setIsSubmittingCloud] = useState<boolean>(false);
  const [isComposing, setIsComposing] = useState<boolean>(false);
  const [finalVideoUrl, setFinalVideoUrl] = useState<string>("");
  const [promptCopied, setPromptCopied] = useState<boolean>(false);

  // 1. 初始化拉取可用模型与启动 Colab 状态轮询
  useEffect(() => {
    fetch("/api/brain/models")
      .then((res) => res.json())
      .then((data) => {
        if (data.models && data.models.length > 0) {
          setAvailableModels(data.models);
          setSelectedModel(data.defaultModel || "gemini-3.8-flash");
        }
      })
      .catch(() => {});

    // 每 5 秒轮询一次 Colab 心跳状态
    const timer = setInterval(() => {
      fetch("/api/colab/status")
        .then((res) => res.json())
        .then((data) => setColabStatus(data))
        .catch(() => {});
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  // 2. 步骤 1：生成分镜脚本与五判官质检
  const handleGenerateScript = async () => {
    setIsGeneratingScript(true);
    try {
      const res = await fetch("/api/brain/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName,
          category,
          price,
          description,
          imagesBase64: productImageBase64 ? [productImageBase64] : [],
          model: selectedModel,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setCurrentProjectId(data.projectId);
      setScriptData(data);
      setActiveStep(2);
    } catch (err: any) {
      alert(`生成脚本失败: ${err.message}`);
    } finally {
      setIsGeneratingScript(false);
    }
  };

  // 3. 步骤 3：上传九宫格切片
  const handleUploadGrid = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsSlicing(true);
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = reader.result as string;
      setGridImageBase64(b64);

      try {
        const res = await fetch("/api/storyboard/slice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: currentProjectId,
            imageBase64: b64,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        setSlicedFrames(data.frames || []);
      } catch (err: any) {
        alert(`九宫格切片失败: ${err.message}`);
      } finally {
        setIsSlicing(false);
      }
    };
    reader.readAsDataURL(file);
  };

  // 4. ⚠️ 强人工审核闸门：确认通过
  const handleApproveGrid = async () => {
    try {
      const res = await fetch("/api/storyboard/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: currentProjectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setIsGridApproved(true);
      setActiveStep(4);
    } catch (err: any) {
      alert(`审核确认异常: ${err.message}`);
    }
  };

  // 5. 步骤 4：提交至 Colab 队列
  const handleSubmitToCloud = async () => {
    setIsSubmittingCloud(true);
    try {
      const res = await fetch("/api/colab/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: currentProjectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      alert(data.message);
    } catch (err: any) {
      alert(`提交云端失败: ${err.message}`);
    } finally {
      setIsSubmittingCloud(false);
    }
  };

  // 6. 最终成片压制与渲染
  const handleComposeFinalVideo = async () => {
    setIsComposing(true);
    try {
      const res = await fetch("/api/compose/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: currentProjectId,
          aigcBadge: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setFinalVideoUrl(data.videoUrl);
    } catch (err: any) {
      alert(`视频合成失败: ${err.message}`);
    } finally {
      setIsComposing(false);
    }
  };

  // 7. Colab 续命与停机
  const handleKeepAlive = async () => {
    await fetch("/api/colab/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "keep_alive", minutes: 15 }),
    });
    alert("已成功向 Colab 续命 15 分钟！");
  };

  const handleTerminateColab = async () => {
    if (confirm("确定立即关闭释放 Colab 实例以停止计费吗？")) {
      await fetch("/api/colab/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "terminate" }),
      });
      alert("已发送停机指令！");
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* 顶部导航与状态条 */}
      <header className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur sticky top-0 z-50 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-cyan-500 flex items-center justify-center font-black text-black text-lg shadow-lg shadow-emerald-500/20">
            CF
          </div>
          <div>
            <h1 className="font-bold text-base tracking-tight flex items-center gap-2">
              ClipForge
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                商业友好版
              </span>
            </h1>
            <p className="text-xs text-zinc-400">Google AI Pro + Tesla T4 双驱全自动带货短视频系统</p>
          </div>
        </div>

        {/* 动态模型选择器与 Colab 状态监控 */}
        <div className="flex items-center gap-4">
          {/* Gemini 模型动态选择 */}
          <div className="flex items-center gap-2 bg-zinc-800/80 px-3 py-1.5 rounded-lg border border-zinc-700/60 text-xs">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-zinc-400">大脑:</span>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="bg-transparent text-zinc-200 outline-none cursor-pointer font-medium"
            >
              {availableModels.map((m) => (
                <option key={m} value={m} className="bg-zinc-800 text-zinc-100">
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* Colab 专属 Session 状态 */}
          <div className="flex items-center gap-3 bg-zinc-800/80 px-3.5 py-1.5 rounded-lg border border-zinc-700/60 text-xs">
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  colabStatus.online ? "bg-emerald-400 animate-pulse" : "bg-zinc-500"
                }`}
              />
              <span className="text-zinc-300 font-medium">
                {colabStatus.online ? "Colab L4 就绪" : "Colab 离线排队"}
              </span>
            </div>

            {colabStatus.online && (
              <>
                <div className="h-3 w-px bg-zinc-700" />
                <span className="text-zinc-400 flex items-center gap-1">
                  <HardDrive className="w-3 h-3 text-cyan-400" />
                  {colabStatus.gpuMemoryUsedMb}/{colabStatus.gpuMemoryTotalMb}MB
                </span>
                <div className="h-3 w-px bg-zinc-700" />
                <span className="text-amber-400 flex items-center gap-1 font-mono">
                  <Clock className="w-3 h-3" />
                  {colabStatus.idleSecondsLeft > 0 ? `${colabStatus.idleSecondsLeft}s` : "BUSY"}
                </span>
                <button
                  onClick={handleKeepAlive}
                  className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-[11px] transition"
                >
                  续命 15m
                </button>
                <button
                  onClick={handleTerminateColab}
                  className="p-1 rounded hover:bg-rose-500/20 text-rose-400 transition"
                  title="立即停机"
                >
                  <Power className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* 主工作区导航步骤 */}
      <div className="border-b border-zinc-800 bg-zinc-900/30 px-6 py-2.5 flex items-center gap-6 text-xs font-medium">
        {[
          { step: 1, label: "1. 商品录入与策划" },
          { step: 2, label: "2. 五判官质检报告" },
          { step: 3, label: "3. 九宫格审核台 (强闸门)" },
          { step: 4, label: "4. Colab 批渲染与成片" },
        ].map((item) => (
          <button
            key={item.step}
            onClick={() => setActiveStep(item.step)}
            className={`flex items-center gap-2 py-1 transition ${
              activeStep === item.step
                ? "text-emerald-400 border-b-2 border-emerald-400 font-semibold"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* 步骤内容区域 */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {/* 步骤 1：商品信息录入 */}
        {activeStep === 1 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-5 bg-zinc-900/60 p-6 rounded-2xl border border-zinc-800">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <Bot className="w-5 h-5 text-emerald-400" />
                商品基本信息录入
              </h2>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1.5">商品名称</label>
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1.5">品类</label>
                  <input
                    type="text"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1.5">售价</label>
                  <input
                    type="text"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                  核心卖点与痛点描述 (用于生成高留存钩子)
                </label>
                <textarea
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
                />
              </div>

              <button
                disabled={isGeneratingScript}
                onClick={handleGenerateScript}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-black font-bold flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-50 transition shadow-lg shadow-emerald-500/10 cursor-pointer"
              >
                {isGeneratingScript ? (
                  <>
                    <RotateCcw className="w-4 h-4 animate-spin" />
                    Gemini 3.8 正在策划分镜与执行五判官审核...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    一键开始 AI 策划分镜
                  </>
                )}
              </button>
            </div>

            {/* 右侧：合规与技术特性说明 */}
            <div className="space-y-4">
              <div className="bg-zinc-900/40 p-5 rounded-xl border border-zinc-800/80">
                <h3 className="font-semibold text-sm flex items-center gap-2 text-emerald-400 mb-2">
                  <ShieldCheck className="w-4 h-4" />
                  100% 商业友好保障
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  系统默认开启广告法违禁极限词脱敏过滤；配音采用 Apache 2.0 商业许可的 CosyVoice 2；字体严格写死 Noto Sans CJK (SIL OFL 1.1)；视频前 3 秒自动打上 AIGC 合规标识。
                </p>
              </div>

              <div className="bg-zinc-900/40 p-5 rounded-xl border border-zinc-800/80">
                <h3 className="font-semibold text-sm flex items-center gap-2 text-cyan-400 mb-2">
                  <Layers className="w-4 h-4" />
                  物理级画面一致性 (九宫格)
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  不再逐镜单独生图。单次生成一张 3×3 九宫格（同人物、同服装、同房间光线），本地 Sharp 几何裁切为 9 张 9:16 关键帧，彻底攻克换脸变形难题。
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 步骤 2：五判官质检报告与分镜预览 */}
        {activeStep === 2 && scriptData && (
          <div className="space-y-6">
            <div className="bg-zinc-900/60 p-5 rounded-2xl border border-zinc-800 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-zinc-100">{scriptData.title}</h2>
                <div className="flex gap-2 mt-1">
                  {scriptData.sellingPoints?.map((sp: string, idx: number) => (
                    <span key={idx} className="text-[11px] bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
                      {sp}
                    </span>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setActiveStep(3)}
                className="px-5 py-2.5 rounded-xl bg-emerald-500 text-black font-bold text-xs flex items-center gap-1.5 hover:bg-emerald-400 transition"
              >
                前往九宫格审核台 <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* 五判官审查与重写列表 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {scriptData.shots?.map((shot: any) => (
                <div key={shot.id} className="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      镜头 {shot.id} ({shot.type})
                    </span>
                    <span className="text-xs text-zinc-400 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {shot.durationSec}s
                    </span>
                  </div>
                  <div>
                    <span className="text-[11px] text-zinc-400 font-semibold block">【画面动作】</span>
                    <p className="text-xs text-zinc-300">{shot.description}</p>
                  </div>
                  <div>
                    <span className="text-[11px] text-zinc-400 font-semibold block">【口语台词】</span>
                    <p className="text-xs text-emerald-300 font-medium">“{shot.voiceover}”</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 步骤 3：九宫格分镜审核台 (强人工闸门) */}
        {activeStep === 3 && scriptData && (
          <div className="space-y-6">
            {/* 外部 Prompt 导出条 */}
            <div className="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 flex items-center justify-between gap-4">
              <div>
                <span className="text-xs font-bold text-zinc-200 block">
                  外部生图流 (Google Flow / Midjourney 专用提示词)
                </span>
                <span className="text-[11px] text-zinc-400">
                  支持一键复制，在外部工具生成满意的 9:16 大图后，直接拖拽回传切片
                </span>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(scriptData.prompts?.googleFlow || "");
                  setPromptCopied(true);
                  setTimeout(() => setPromptCopied(false), 2000);
                }}
                className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium flex items-center gap-1.5 transition shrink-0"
              >
                {promptCopied ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {promptCopied ? "已复制到剪贴板" : "复制 Google Flow Prompt"}
              </button>
            </div>

            {/* 九宫格拖拽上传切片区 */}
            <div className="border-2 border-dashed border-zinc-800 hover:border-emerald-500/50 rounded-2xl p-6 text-center transition bg-zinc-900/30">
              <Upload className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
              <label className="cursor-pointer text-xs font-medium text-emerald-400 hover:underline">
                点击上传或拖拽 9:16 九宫格大图
                <input type="file" accept="image/*" onChange={handleUploadGrid} className="hidden" />
              </label>
              <p className="text-[11px] text-zinc-500 mt-1">系统将自动使用 Sharp 毫秒级几何等分裁切为 9 张关键帧</p>
            </div>

            {/* 切片预览网格 */}
            {slicedFrames.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  九宫格切片预览 (3x3 矩阵)
                </h3>
                <div className="grid grid-cols-3 gap-3 max-w-lg mx-auto">
                  {slicedFrames.map((frame) => (
                    <div key={frame.index} className="aspect-[9/16] rounded-lg overflow-hidden border border-zinc-800 bg-zinc-900 relative group">
                      <img src={frame.url} alt={`Shot ${frame.index}`} className="w-full h-full object-cover" />
                      <div className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 rounded">
                        #{frame.index}
                      </div>
                    </div>
                  ))}
                </div>

                {/* ⚠️ 强人工审核确认按钮 */}
                <div className="pt-4 max-w-md mx-auto text-center">
                  <button
                    onClick={handleApproveGrid}
                    className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition cursor-pointer"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    人工审核确认通过 (解锁云端视频生成)
                  </button>
                  <p className="text-[11px] text-zinc-400 mt-1.5">
                    未人工确认前，系统绝不下发云端，彻底防止算力点被误烧
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 步骤 4：Colab 批处理与成片导出 */}
        {activeStep === 4 && (
          <div className="space-y-6 max-w-2xl mx-auto">
            <div className="bg-zinc-900/60 p-6 rounded-2xl border border-zinc-800 space-y-4 text-center">
              <Video className="w-10 h-10 text-emerald-400 mx-auto" />
              <h2 className="text-base font-bold text-zinc-100">云端视频生成与本地压制</h2>
              <p className="text-xs text-zinc-400">
                九宫格关键帧已审核通过！点击下方按钮将任务推入 Colab 队列，由 MiniMax-H3 生成动态镜头。
              </p>

              <div className="flex gap-3 justify-center">
                <button
                  disabled={isSubmittingCloud}
                  onClick={handleSubmitToCloud}
                  className="px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold transition"
                >
                  {isSubmittingCloud ? "正在下发..." : "推入 Colab 任务队列"}
                </button>

                <button
                  disabled={isComposing}
                  onClick={handleComposeFinalVideo}
                  className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold flex items-center gap-2 transition cursor-pointer"
                >
                  {isComposing ? <RotateCcw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  本地 T4 最终合成 1080p 成片
                </button>
              </div>
            </div>

            {/* 成片在线播放器 */}
            {finalVideoUrl && (
              <div className="bg-zinc-900/60 p-6 rounded-2xl border border-zinc-800 space-y-4 text-center">
                <span className="text-xs font-bold text-emerald-400 block">成片渲染完毕！</span>
                <div className="aspect-[9/16] max-w-xs mx-auto rounded-xl overflow-hidden border border-zinc-800 shadow-2xl">
                  <video src={finalVideoUrl} controls autoPlay className="w-full h-full object-cover" />
                </div>
                <a
                  href={finalVideoUrl}
                  download="clipforge_final.mp4"
                  className="inline-block px-5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 transition"
                >
                  下载成片 MP4
                </a>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
