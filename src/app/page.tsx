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
  HardDrive,
  Film,
  ListOrdered,
  Plus,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  ChevronDown,
  Activity,
  X,
  Image as ImageIcon,
  Eye,
  Lock,
  Trash2,
  Download
} from "lucide-react";

export default function DashboardPage() {
  // 视图 Tab 切换: "workspace" (工作台) | "taskList" (视频进度列表)
  const [activeTab, setActiveTab] = useState<"workspace" | "taskList">("workspace");

  // 模型与 Colab 状态
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("gemini-3.5-flash");
  const [colabGpu, setColabGpu] = useState<string>("L4");
  const [isPoweringOn, setIsPoweringOn] = useState<boolean>(false);
  const [showMetricsPopover, setShowMetricsPopover] = useState<boolean>(false);
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
  const [referenceImages, setReferenceImages] = useState<string[]>([]);

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
  const [isGeneratingCloudGrid, setIsGeneratingCloudGrid] = useState<boolean>(false);
  const [isComposing, setIsComposing] = useState<boolean>(false);
  const [finalVideoUrl, setFinalVideoUrl] = useState<string>("");
  const [promptCopied, setPromptCopied] = useState<boolean>(false);

  // 全部项目进度列表
  const [projectList, setProjectList] = useState<any[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState<boolean>(false);

  const currentProject = projectList.find((p) => p.id === currentProjectId);
  const isGridGenerating = currentProject?.status === "grid_generating" || isGeneratingCloudGrid;

  // 1. 初始化拉取可用模型与启动 Colab 状态轮询
  useEffect(() => {
    fetch("/api/brain/models")
      .then((res) => res.json())
      .then((data) => {
        if (data.models && data.models.length > 0) {
          setAvailableModels(data.models);
          setSelectedModel(data.defaultModel || "gemini-3.5-flash");
        }
      })
      .catch(() => {});

    fetchProjects();

    // 每 5 秒轮询一次 Colab 心跳状态
    const timer = setInterval(() => {
      fetch("/api/colab/status")
        .then((res) => res.json())
        .then((data) => setColabStatus(data))
        .catch(() => {});
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  // 当切换到步骤 3 且已有项目时，自动拉取已生成的九宫格切片并支持云端轮询自愈
  useEffect(() => {
    if (activeStep === 3 && currentProjectId) {
      const loadSlices = () => {
        fetch(`/api/storyboard/slice?projectId=${currentProjectId}`)
          .then((res) => res.json())
          .then((data) => {
            if (data.frames && data.frames.length > 0) {
              setSlicedFrames(data.frames);
            }
          })
          .catch(() => {});
      };

      loadSlices();

      // 定期探测项目状态，若云端生图中 (grid_generating)，每 3 秒检测一次切片并刷新
      const pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/projects?id=${currentProjectId}`);
          const data = await res.json();
          if (data.project?.status && data.project.status !== "grid_generating") {
            loadSlices();
            fetchProjects();
          }
        } catch (_) {}
      }, 3000);

      return () => clearInterval(pollTimer);
    }
  }, [activeStep, currentProjectId]);

  // 当处于步骤 4 且已有项目时，每 3 秒检测分镜视频片段下载状态与最终成片
  useEffect(() => {
    if (activeStep === 4 && currentProjectId) {
      const pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/projects?id=${currentProjectId}`);
          const data = await res.json();
          if (data.project) {
            if (data.script?.shots) {
              setScriptData((prev: any) => ({
                ...(prev || {}),
                ...data.script,
              }));
            }
            if (data.composition?.outputPath) {
              const url = data.composition.outputPath.startsWith("public/")
                ? data.composition.outputPath.slice(6)
                : data.composition.outputPath.startsWith("/public/")
                ? data.composition.outputPath.slice(7)
                : data.composition.outputPath;
              setFinalVideoUrl(url.startsWith("/") ? url : `/${url}`);
            }
            fetchProjects();
          }
        } catch (_) {}
      }, 3000);

      return () => clearInterval(pollTimer);
    }
  }, [activeStep, currentProjectId]);

  // 商品参考图上传与删除辅助函数
  const handleAddReferenceImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    Array.from(files).forEach((file) => {
      if (referenceImages.length >= 3) {
        alert("最多支持上传 3 张商品参考图！");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          setReferenceImages((prev) => {
            if (prev.length >= 3) return prev;
            return [...prev, reader.result as string];
          });
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleRemoveReferenceImage = (index: number) => {
    setReferenceImages((prev) => prev.filter((_, i) => i !== index));
  };

  // 拉取所有视频项目列表
  const fetchProjects = async () => {
    setIsLoadingProjects(true);
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (data.projects) {
        setProjectList(data.projects);
      }
    } catch (e) {
      console.warn("拉取项目列表失败:", e);
    } finally {
      setIsLoadingProjects(false);
    }
  };

  // 载入特定项目并恢复到对应步骤
  const handleLoadProject = async (projId: string) => {
    try {
      const res = await fetch(`/api/projects?id=${projId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const p = data.project;
      setCurrentProjectId(p.id);
      setProductName(p.productName || "");
      setCategory(p.productCategory || "");
      setPrice(p.productPrice || "");
      setDescription(p.productDescription || "");

      if (data.script) {
        setScriptData({
          title: data.script.title,
          shots: data.script.shots || [],
          judgeReport: data.script.judgeReport,
          prompts: {
            googleFlow: data.script.externalPrompt,
            midjourney: data.script.externalPrompt,
          },
        });
        if (data.script.referenceImages && Array.isArray(data.script.referenceImages)) {
          setReferenceImages(data.script.referenceImages);
        } else {
          setReferenceImages([]);
        }
      } else {
        setScriptData(null);
        setReferenceImages([]);
      }

      if (data.composition) {
        setFinalVideoUrl(`/outputs/${p.id}/final_video.mp4`);
      } else {
        setFinalVideoUrl("");
      }

      // 拉取该项目已有的九宫格切片数据
      fetch(`/api/storyboard/slice?projectId=${p.id}`)
        .then((res) => res.json())
        .then((sliceData) => {
          if (sliceData.frames && sliceData.frames.length > 0) {
            setSlicedFrames(sliceData.frames);
          } else {
            setSlicedFrames([]);
          }
        })
        .catch(() => {});

      // 计算并跳转对应步骤
      if (p.status === "completed") {
        setActiveStep(4);
        setIsGridApproved(true);
      } else if (p.status === "clips_ready" || p.status === "cloud_running") {
        setActiveStep(4);
        setIsGridApproved(true);
      } else if (p.status === "grid_approved") {
        setActiveStep(4);
        setIsGridApproved(true);
      } else if (p.status === "grid_generating" || p.status === "grid_reviewing" || p.status === "grid_review") {
        setActiveStep(3);
        setIsGridApproved(false);
      } else if (data.script) {
        setActiveStep(2);
        setIsGridApproved(false);
      } else {
        setActiveStep(1);
        setIsGridApproved(false);
      }

      setActiveTab("workspace");
    } catch (err: any) {
      alert(`载入项目失败: ${err.message}`);
    }
  };

  // 新建视频项目
  const handleNewProject = () => {
    setCurrentProjectId("");
    setProductName("新品带货爆款");
    setCategory("通用百货");
    setPrice("¥99");
    setDescription("");
    setProductImageBase64("");
    setReferenceImages([]);
    setScriptData(null);
    setGridImageBase64("");
    setSlicedFrames([]);
    setIsGridApproved(false);
    setFinalVideoUrl("");
    setActiveStep(1);
    setActiveTab("workspace");
  };

  // 智能卖点提炼
  const [isExtractingSellingPoints, setIsExtractingSellingPoints] = useState(false);
  const handleExtractSellingPoints = async () => {
    if (!productName.trim()) {
      alert("请先填写商品名称！");
      return;
    }
    setIsExtractingSellingPoints(true);
    try {
      const res = await fetch("/api/brain/selling-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productName, model: selectedModel }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.category) setCategory(data.category);
      if (data.suggestedPrice) setPrice(data.suggestedPrice);
      if (data.description) setDescription(data.description);
    } catch (err: any) {
      alert(`提炼卖点失败: ${err.message}`);
    } finally {
      setIsExtractingSellingPoints(false);
    }
  };

  // 删除项目
  const handleDeleteProject = async (id: string, name: string) => {
    if (!confirm(`确定要彻底删除项目「${name || "未命名"}」及其本地生成的所有产物吗？`)) {
      return;
    }
    try {
      const res = await fetch(`/api/projects?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert("项目已成功删除！");
      if (currentProjectId === id) {
        handleNewProject();
      }
      fetchProjects();
    } catch (err: any) {
      alert(`删除失败: ${err.message}`);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch (_) {}
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      textArea.style.top = "-999999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand("copy");
      textArea.remove();
    } catch (e) {
      console.warn("Clipboard fallback failed:", e);
    }
  };

  // 复制项目台词文案
  const handleCopyProjectScript = async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects?id=${projectId}`);
      const data = await res.json();
      const shots = data.script?.shots || [];
      if (!shots.length) {
        alert("该项目暂无可用台词文案！");
        return;
      }
      const text = shots
        .map(
          (s: any, idx: number) =>
            `【镜头 ${idx + 1} · ${s.type || "分镜"}】\n画面：${s.description}\n台词：${s.voiceover}`
        )
        .join("\n\n");
      await copyToClipboard(text);
      alert("完整分镜台词文案已成功复制到剪贴板！");
    } catch (err: any) {
      alert(`获取文案失败: ${err.message}`);
    }
  };

  const handleCopyAllVoiceovers = async () => {
    const list = scriptData?.shots || [];
    if (!list.length) {
      alert("暂无可复制的台词！");
      return;
    }
    const text = list
      .map(
        (s: any, idx: number) =>
          `【镜头 ${idx + 1} · ${s.type || "分镜"}】\n画面：${s.description}\n台词：${s.voiceover}`
      )
      .join("\n\n");
    await copyToClipboard(text);
    alert("完整分镜台词文案已成功复制到剪贴板！");
  };

  // Colab 一键开机
  const handlePowerOnColab = async () => {
    setIsPoweringOn(true);
    try {
      const res = await fetch("/api/colab/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "power_on", gpu: colabGpu }),
      });
      const data = await res.json();
      alert(data.message || "开机指令已下发！");
    } catch (err: any) {
      alert(`开机失败: ${err.message}`);
    } finally {
      setIsPoweringOn(false);
    }
  };

  // MiniMax-H3-Image 云端一键生成九宫格 (带强校验与自动复用)
  const handleGenerateCloudGrid = async () => {
    if (!currentProjectId) {
      alert("请先生成分镜脚本！");
      return;
    }

    // 检查参考图：若步骤 2 未添加，自动尝试复用步骤 1 的商品主图
    let finalRefImages = [...referenceImages];
    if (finalRefImages.length === 0 && productImageBase64) {
      finalRefImages = [productImageBase64];
      setReferenceImages([productImageBase64]);
    }

    // 强校验阻断：两处均无任何图片时，弹出明确提示并高亮定位
    if (finalRefImages.length === 0) {
      alert(
        "⚠️ 门禁拦截：尚未添加任何商品参考图！\n\n请在下方「商品视觉参考图」区域至少添加 1 张商品白底图或细节实拍，以便 MiniMax-H3 模型精准还原商品外观。"
      );
      const refEl = document.getElementById("reference-images-section");
      if (refEl) {
        refEl.scrollIntoView({ behavior: "smooth", block: "center" });
        refEl.classList.add("ring-2", "ring-rose-500", "animate-pulse");
        setTimeout(() => {
          refEl.classList.remove("ring-2", "ring-rose-500", "animate-pulse");
        }, 3000);
      }
      return;
    }

    setIsGeneratingCloudGrid(true);
    try {
      const res = await fetch("/api/storyboard/cloud-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: currentProjectId,
          referenceImages: finalRefImages,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      alert(data.message || "任务已提交云端队列！Colab 就绪后将自动生成并切片。");
      setActiveStep(3);
      fetchProjects();
    } catch (err: any) {
      alert(`云端九宫格生图失败: ${err.message}`);
    } finally {
      setIsGeneratingCloudGrid(false);
    }
  };

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
      fetchProjects();
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
        fetchProjects();
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
      fetchProjects();
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
      fetchProjects();
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
      fetchProjects();
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
      <header className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur sticky top-0 z-50 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
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

          {/* 核心双视图 Tab 切换 */}
          <div className="flex items-center gap-1 bg-zinc-800/90 p-1 rounded-xl border border-zinc-700/60 ml-4">
            <button
              onClick={() => setActiveTab("workspace")}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                activeTab === "workspace"
                  ? "bg-zinc-700 text-white shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Film className="w-3.5 h-3.5 text-emerald-400" />
              制作工作台
            </button>
            <button
              onClick={() => {
                setActiveTab("taskList");
                fetchProjects();
              }}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                activeTab === "taskList"
                  ? "bg-zinc-700 text-white shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <ListOrdered className="w-3.5 h-3.5 text-cyan-400" />
              视频进度列表
              {projectList.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-cyan-500/20 text-cyan-400 text-[10px]">
                  {projectList.length}
                </span>
              )}
            </button>
          </div>

          <button
            onClick={handleNewProject}
            className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 text-xs font-medium flex items-center gap-1.5 transition"
          >
            <Plus className="w-3.5 h-3.5" />
            新建视频
          </button>
        </div>

        {/* 动态模型选择器与 Colab 状态/一键开机 */}
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

          {/* Colab 专属 Session 状态、系统资源监控与开机面板 */}
          {(isPoweringOn || colabStatus.isPoweringOn) ? (
            <div className="flex items-center gap-2 bg-amber-500/10 px-3.5 py-1.5 rounded-lg border border-amber-500/30 text-xs text-amber-300 shadow-sm">
              <RotateCcw className="w-3.5 h-3.5 animate-spin text-amber-400" />
              <span className="font-medium">
                {colabStatus.lastInitStep || "实例正在启动并初始化双向通信协议..."}
              </span>
            </div>
          ) : colabStatus.online ? (
            <div className="relative">
              <button
                onClick={() => setShowMetricsPopover(!showMetricsPopover)}
                className="flex items-center gap-2.5 bg-zinc-800/90 hover:bg-zinc-700/80 px-3.5 py-1.5 rounded-lg border border-emerald-500/30 text-xs transition cursor-pointer shadow-sm"
              >
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                <span className="text-emerald-400 font-bold">
                  在线 ({colabStatus.metrics?.gpu?.name ? colabStatus.metrics.gpu.name.replace("NVIDIA ", "") : "L4"})
                </span>
                <span className="text-zinc-600">|</span>
                <span className="text-zinc-300 font-medium">
                  CPU: <strong className="text-white font-mono">{colabStatus.metrics?.cpu?.percent ?? 0}%</strong>
                </span>
                <span className="text-zinc-600">|</span>
                <span className="text-zinc-300 font-medium">
                  内存: <strong className="text-white font-mono">{((colabStatus.metrics?.ram?.usedMb ?? 0) / 1024).toFixed(1)}</strong>/{((colabStatus.metrics?.ram?.totalMb ?? 0) / 1024).toFixed(1)}G
                </span>
                <span className="text-zinc-600">|</span>
                <span className="text-cyan-300 font-medium">
                  显存: <strong className="text-white font-mono">{((colabStatus.gpuMemoryUsedMb || 0) / 1024).toFixed(1)}</strong>/{((colabStatus.gpuMemoryTotalMb || 0) / 1024).toFixed(1)}G
                </span>
                <ChevronDown className={`w-3.5 h-3.5 text-zinc-400 transition-transform ${showMetricsPopover ? "rotate-180" : ""}`} />
              </button>

              {/* 展开浮层：Colab 系统级硬件资源仪表盘 */}
              {showMetricsPopover && (
                <div className="absolute right-0 top-full mt-2 w-84 bg-zinc-900/95 backdrop-blur-md border border-zinc-700 rounded-xl p-4 shadow-2xl z-50 space-y-3.5">
                  <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                    <span className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                      <Activity className="w-4 h-4 text-emerald-400" />
                      Colab 实时系统硬件监控
                    </span>
                    <span className="text-[10px] text-zinc-400 font-mono">
                      {colabStatus.sessionName || "clipforge_helloworld1234"}
                    </span>
                  </div>

                  {/* CPU 负载 */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-zinc-400">CPU 使用率</span>
                      <span className="text-zinc-200 font-bold font-mono">{colabStatus.metrics?.cpu?.percent ?? 0}%</span>
                    </div>
                    <div className="w-full bg-zinc-800 h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-emerald-500 h-full transition-all duration-500"
                        style={{ width: `${Math.min(100, colabStatus.metrics?.cpu?.percent ?? 0)}%` }}
                      />
                    </div>
                  </div>

                  {/* 系统内存 RAM */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-zinc-400">系统内存 (RAM)</span>
                      <span className="text-zinc-200 font-bold font-mono">
                        {((colabStatus.metrics?.ram?.usedMb ?? 0) / 1024).toFixed(1)} / {((colabStatus.metrics?.ram?.totalMb ?? 0) / 1024).toFixed(1)} GB ({colabStatus.metrics?.ram?.percent ?? 0}%)
                      </span>
                    </div>
                    <div className="w-full bg-zinc-800 h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-cyan-500 h-full transition-all duration-500"
                        style={{ width: `${Math.min(100, colabStatus.metrics?.ram?.percent ?? 0)}%` }}
                      />
                    </div>
                  </div>

                  {/* GPU 显存 VRAM */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-zinc-400">{colabStatus.metrics?.gpu?.name || "NVIDIA L4"} 显存 (VRAM)</span>
                      <span className="text-amber-400 font-bold font-mono">
                        {((colabStatus.gpuMemoryUsedMb || 0) / 1024).toFixed(1)} / {((colabStatus.gpuMemoryTotalMb || 0) / 1024).toFixed(1)} GB
                      </span>
                    </div>
                    <div className="w-full bg-zinc-800 h-2 rounded-full overflow-hidden">
                      <div
                        className="bg-amber-500 h-full transition-all duration-500"
                        style={{ width: `${Math.min(100, ((colabStatus.gpuMemoryUsedMb || 0) / (colabStatus.gpuMemoryTotalMb || 1)) * 100)}%` }}
                      />
                    </div>
                  </div>

                  {/* 状态与控制 */}
                  <div className="pt-2 border-t border-zinc-800 flex items-center justify-between text-xs">
                    <span className="text-zinc-400 flex items-center gap-1 text-[11px]">
                      <Clock className="w-3.5 h-3.5 text-amber-400" />
                      空闲释放倒计时: <strong className="text-amber-300 font-mono">{colabStatus.idleSecondsLeft > 0 ? `${colabStatus.idleSecondsLeft}s` : "BUSY"}</strong>
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={handleKeepAlive}
                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] transition cursor-pointer"
                      >
                        续命 15m
                      </button>
                      <button
                        onClick={handleTerminateColab}
                        className="px-2 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[11px] transition cursor-pointer"
                      >
                        释放停机
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 bg-zinc-800/80 px-3.5 py-1.5 rounded-lg border border-zinc-700/60 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-zinc-500" />
                <span className="text-zinc-300 font-medium">Colab 离线</span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={colabGpu}
                  onChange={(e) => setColabGpu(e.target.value)}
                  className="bg-zinc-700 text-zinc-200 text-[11px] px-1.5 py-0.5 rounded outline-none"
                >
                  <option value="L4">L4 (推荐)</option>
                  <option value="A100">A100</option>
                </select>
                <button
                  onClick={handlePowerOnColab}
                  disabled={isPoweringOn}
                  className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-[11px] flex items-center gap-1 transition shadow-sm cursor-pointer disabled:opacity-50"
                >
                  <Power className="w-3 h-3" />
                  {isPoweringOn ? "开机中..." : "一键开机 (colab new)"}
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* 视图 1：制作工作台 */}
      {activeTab === "workspace" && (
        <>
          {/* 主工作区导航步骤 */}
          <div className="border-b border-zinc-800 bg-zinc-900/30 px-6 py-2.5 flex items-center justify-between text-xs font-medium">
            <div className="flex items-center gap-6">
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

            {currentProjectId && (
              <span className="text-[11px] text-zinc-400 font-mono">
                当前项目 ID: {currentProjectId.slice(0, 8)}...
              </span>
            )}
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
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-zinc-300">商品名称</label>
                      <button
                        type="button"
                        onClick={handleExtractSellingPoints}
                        disabled={isExtractingSellingPoints}
                        className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-medium bg-emerald-500/10 hover:bg-emerald-500/20 px-2 py-0.5 rounded-lg border border-emerald-500/20 transition cursor-pointer disabled:opacity-50"
                      >
                        <Sparkles className="w-3 h-3" />
                        {isExtractingSellingPoints ? "AI 提炼中..." : "✨ AI 智能提炼卖点"}
                      </button>
                    </div>
                    <input
                      type="text"
                      value={productName}
                      onChange={(e) => setProductName(e.target.value)}
                      className="w-full bg-zinc-800/80 border border-zinc-700/80 rounded-xl px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition"
                      placeholder="例如：冷萃浓缩咖啡液"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-300 mb-1.5">品类</label>
                      <input
                        type="text"
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        className="w-full bg-zinc-800/80 border border-zinc-700/80 rounded-xl px-4 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition"
                        placeholder="冲调饮品 / 美妆"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-zinc-300 mb-1.5">售卖价格</label>
                      <input
                        type="text"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        className="w-full bg-zinc-800/80 border border-zinc-700/80 rounded-xl px-4 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition"
                        placeholder="¥39.9"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-zinc-300 mb-1.5">
                      核心卖点与用户痛点描述
                    </label>
                    <textarea
                      rows={4}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full bg-zinc-800/80 border border-zinc-700/80 rounded-xl px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition leading-relaxed"
                      placeholder="详细说明痛点场景与实测亮点..."
                    />
                  </div>

                  {/* 商品主图上传 (可选，生图时自动复用) */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                        <ImageIcon className="w-3.5 h-3.5 text-emerald-400" />
                        商品主图 (可选上传，生图时自动复用)
                      </label>
                      {productImageBase64 && (
                        <button
                          type="button"
                          onClick={() => setProductImageBase64("")}
                          className="text-[11px] text-rose-400 hover:text-rose-300 transition"
                        >
                          移除主图
                        </button>
                      )}
                    </div>
                    {productImageBase64 ? (
                      <div className="relative w-24 h-24 rounded-xl overflow-hidden border border-zinc-700 group bg-zinc-800">
                        <img src={productImageBase64} alt="商品主图" className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => setProductImageBase64("")}
                          className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition text-rose-400"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    ) : (
                      <label className="border-2 border-dashed border-zinc-700/80 hover:border-emerald-500/60 rounded-xl p-3 flex items-center justify-center gap-2 cursor-pointer transition text-zinc-400 hover:text-zinc-200 text-xs bg-zinc-800/40">
                        <Upload className="w-4 h-4 text-emerald-400" />
                        <span>点击上传商品白底/主图 (JPG/PNG/WEBP)</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              const reader = new FileReader();
                              reader.onload = () => {
                                if (typeof reader.result === "string") {
                                  setProductImageBase64(reader.result);
                                }
                              };
                              reader.readAsDataURL(file);
                            }
                          }}
                        />
                      </label>
                    )}
                  </div>

                  <button
                    disabled={isGeneratingScript}
                    onClick={handleGenerateScript}
                    className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 font-bold text-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition cursor-pointer disabled:opacity-50"
                  >
                    {isGeneratingScript ? (
                      <>
                        <RotateCcw className="w-4 h-4 animate-spin" />
                        Gemini 3.5 正在极速生成爆款剧本与五判官质检...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4" />
                        一键生成分镜脚本 (含广告法合规过滤)
                      </>
                    )}
                  </button>
                </div>

                {/* 规范指南说明卡片 */}
                <div className="bg-zinc-900/40 p-6 rounded-2xl border border-zinc-800 space-y-4">
                  <h3 className="text-sm font-bold text-zinc-200 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    商业级安全合规规范
                  </h3>
                  <ul className="text-xs text-zinc-400 space-y-2.5 leading-relaxed">
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-400 font-bold">1.</span>
                      <span>
                        <strong>大模型大脑</strong>：默认锁定极速稳定的{" "}
                        <code className="text-zinc-200">gemini-3.5-flash</code>，具备自动降级防崩容灾。
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-400 font-bold">2.</span>
                      <span>
                        <strong>广告法防违规</strong>：自动扫描并过滤「最高级、全网最低、第一」等绝对化违禁词。
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-400 font-bold">3.</span>
                      <span>
                        <strong>商业字体保障</strong>：字幕完全烧录开源 SIL OFL 1.1 思源黑体，杜绝商用侵权。
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-emerald-400 font-bold">4.</span>
                      <span>
                        <strong>声音与画面落地</strong>：90Hz 高通 + 9500Hz 低通降噪，AIGC 水印自动烧录。
                      </span>
                    </li>
                  </ul>
                </div>
              </div>
            )}

            {/* 步骤 2：剧本审阅与提示词导出 */}
            {activeStep === 2 && scriptData && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-bold text-zinc-100">{scriptData.title}</h2>
                    <div className="flex gap-2 mt-1">
                      {scriptData.sellingPoints?.map((p: string, i: number) => (
                        <span
                          key={i}
                          className="px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-xs border border-emerald-500/20"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={async () => {
                        await copyToClipboard(scriptData.prompts?.googleFlow || "");
                        setPromptCopied(true);
                        setTimeout(() => setPromptCopied(false), 2000);
                      }}
                      className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-200 flex items-center gap-1.5 transition"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      {promptCopied ? "已复制 Flow 提示词" : "复制 Google Flow 九宫格提示词"}
                    </button>

                    <button
                      disabled={isGeneratingCloudGrid}
                      onClick={handleGenerateCloudGrid}
                      className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1.5 transition shadow-sm cursor-pointer disabled:opacity-50"
                    >
                      {isGeneratingCloudGrid ? (
                        <>
                          <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                          下发云端队列中...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                          MiniMax-H3-Image 自动生图
                        </>
                      )}
                    </button>

                    <button
                      onClick={() => setActiveStep(3)}
                      className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold flex items-center gap-1.5 transition cursor-pointer"
                    >
                      前往九宫格审核台
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* 五判官质检报告卡片 */}
                {scriptData.judgeReport && (
                  <div className="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 flex items-start gap-3">
                    <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                    <div className="text-xs space-y-1">
                      <span className="font-bold text-zinc-200">
                        五判官综合质检：{scriptData.judgeReport.summary}
                      </span>
                      <p className="text-zinc-400">
                        已自动完成节奏优化、口语脱敏、结构转化点强化与广告法极限词规避。
                      </p>
                    </div>
                  </div>
                )}

                {/* 商品视觉参考图管理区 (MiniMax-H3 生图必填) */}
                <div
                  id="reference-images-section"
                  className="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 space-y-3 transition-all duration-300"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ImageIcon className="w-4 h-4 text-cyan-400" />
                      <span className="text-xs font-bold text-zinc-200">
                        商品视觉参考图 (MiniMax-H3 生成九宫格必填，最多 3 张)
                      </span>
                      <span className="text-[11px] text-zinc-400">
                        已添加 <strong className="text-emerald-400">{referenceImages.length}</strong>/3 张
                      </span>
                    </div>
                    {referenceImages.length < 3 && (
                      <label className="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium flex items-center gap-1.5 cursor-pointer transition">
                        <Upload className="w-3.5 h-3.5 text-cyan-400" />
                        添加参考图
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={handleAddReferenceImage}
                          className="hidden"
                        />
                      </label>
                    )}
                  </div>

                  {referenceImages.length > 0 ? (
                    <div className="flex flex-wrap gap-3 pt-1">
                      {referenceImages.map((imgBase64, idx) => (
                        <div
                          key={idx}
                          className="relative w-20 h-20 rounded-lg overflow-hidden border border-zinc-700 group bg-zinc-800 shadow"
                        >
                          <img
                            src={imgBase64}
                            alt={`参考图 #${idx + 1}`}
                            className="w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveReferenceImage(idx)}
                            className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition text-rose-400"
                            title="删除此参考图"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                          <span className="absolute bottom-1 right-1 bg-black/70 text-[9px] px-1 rounded text-zinc-300 font-mono">
                            #{idx + 1}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-zinc-500">
                      尚未添加参考图。MiniMax-H3-Image 自动生图需要至少 1 张清晰商品白底图或实拍图作为特征输入。若步骤 1 已上传商品主图，生图时将自动复用。
                    </p>
                  )}
                </div>

                {/* 分镜卡片展示 */}
                <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                  {scriptData.shots?.map((shot: any) => (
                    <div
                      key={shot.id}
                      className="bg-zinc-900/60 p-4 rounded-xl border border-zinc-800 space-y-3 flex flex-col justify-between"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-[11px] font-bold">
                          <span className="text-emerald-400">分镜 #{shot.id}</span>
                          <span className="text-zinc-500">{shot.durationSec}s</span>
                        </div>
                        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 inline-block">
                          {shot.type}
                        </span>
                        <p className="text-xs text-zinc-300 font-medium leading-relaxed">
                          {shot.description}
                        </p>
                      </div>

                      <div className="bg-zinc-800/60 p-2.5 rounded-lg border border-zinc-700/50">
                        <span className="text-[10px] text-zinc-400 block font-bold mb-1">配音台词:</span>
                        <p className="text-xs text-emerald-300 leading-normal">"{shot.voiceover}"</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 步骤 3：九宫格切片与强人工审核闸门 */}
            {activeStep === 3 && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
                      <Layers className="w-5 h-5 text-emerald-400" />
                      九宫格切片与人工把关闸门
                    </h2>
                    <p className="text-xs text-zinc-400 mt-1">
                      请使用步骤 2 导出的提示词在外部生成九宫格大图并上传；未通过人工审核绝不上传云端。
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    {!isGridGenerating ? (
                      <label className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold flex items-center gap-2 cursor-pointer transition">
                        <Upload className="w-4 h-4 text-emerald-400" />
                        {isSlicing ? "正在切片..." : "上传 3x3 九宫格原图"}
                        <input type="file" accept="image/*" onChange={handleUploadGrid} className="hidden" />
                      </label>
                    ) : (
                      <div className="px-3.5 py-1.5 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center gap-2 animate-pulse">
                        <RotateCcw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                        云端生成中，切片就绪后自动解锁审核
                      </div>
                    )}

                    {slicedFrames.length > 0 && !isGridApproved && (
                      <button
                        onClick={handleApproveGrid}
                        className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold flex items-center gap-1.5 transition cursor-pointer shadow-lg shadow-emerald-500/20"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        人工审核通过，解锁云端提交权限
                      </button>
                    )}

                    {isGridApproved && (
                      <span className="px-3.5 py-1.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-bold flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        已人工审核确认
                      </span>
                    )}
                  </div>
                </div>

                {/* 9:16 切片网格展示 (真实 3x3 九宫格布局) */}
                {slicedFrames.length > 0 ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-xs text-zinc-400">
                      <span>已就绪 {slicedFrames.length} 张 9:16 等比分镜切片（点击或人工核验无误后请点击右上角确认）</span>
                    </div>
                    <div className="grid grid-cols-3 gap-4 max-w-3xl mx-auto">
                      {slicedFrames.map((frame) => (
                        <div
                          key={frame.index}
                          className="aspect-[9/16] bg-zinc-900 rounded-xl overflow-hidden border border-zinc-800 relative group shadow-lg hover:border-emerald-500/60 transition"
                        >
                          <img
                            src={frame.url}
                            alt={`分镜切片 #${frame.index}`}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              console.warn(`图片加载降级处理: 分镜 #${frame.index}`);
                            }}
                          />
                          <div className="absolute top-2 left-2 bg-black/75 backdrop-blur px-2.5 py-0.5 rounded text-[11px] font-bold text-zinc-200 flex items-center gap-1 shadow">
                            <Eye className="w-3 h-3 text-emerald-400" />
                            镜头 #{frame.index}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : isGridGenerating ? (
                  <div className="border-2 border-dashed border-cyan-500/30 bg-cyan-950/10 rounded-2xl p-16 text-center space-y-4">
                    <div className="relative w-16 h-16 mx-auto flex items-center justify-center">
                      <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20 border-t-cyan-400 animate-spin" />
                      <Sparkles className="w-8 h-8 text-cyan-400 animate-pulse" />
                    </div>
                    <div className="space-y-1.5 max-w-md mx-auto">
                      <h3 className="text-sm font-bold text-zinc-200">
                        MiniMax-H3-Image 正在云端渲染九宫格原图...
                      </h3>
                      <p className="text-xs text-zinc-400 leading-relaxed">
                        已向 Colab 任务队列分发商品分镜与参考图。生成完成后，系统将自动下载、高精度等比切片为 9 张分镜画面，并在此处展示等待您的人工审核。
                      </p>
                    </div>
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-800/80 border border-zinc-700/60 text-[11px] text-zinc-400 font-mono">
                      <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                      实时监听云端就绪事件 (每 3 秒自动轮询)
                    </div>
                  </div>
                ) : (
                  <div className="border-2 border-dashed border-zinc-800 rounded-2xl p-16 text-center space-y-3">
                    <Layers className="w-10 h-10 text-zinc-600 mx-auto" />
                    <p className="text-xs text-zinc-400">
                      暂无切片数据，请在步骤 2 点击「MiniMax-H3-Image 自动生图」或在右上角手动上传 3x3 九宫格原图
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* 步骤 4：Colab 批处理与成片导出 */}
            {activeStep === 4 && (() => {
              const shotsList = scriptData?.shots || [];
              const completedShotsCount = shotsList.filter((s: any) => s.status === "done" || !!s.videoPath).length;
              const isAllClipsReady = shotsList.length > 0 && completedShotsCount === shotsList.length;
              const isCloudGeneratingClips = currentProject?.status === "cloud_running" && !isAllClipsReady;

              return (
                <div className="space-y-6 max-w-4xl mx-auto">
                  {/* 控制与进度卡片 */}
                  <div className="bg-zinc-900/60 p-6 rounded-2xl border border-zinc-800 space-y-5 text-center">
                    <Video className="w-10 h-10 text-emerald-400 mx-auto" />
                    <div>
                      <h2 className="text-base font-bold text-zinc-100">云端视频生成与本地压制</h2>
                      <p className="text-xs text-zinc-400 mt-1">
                        九宫格关键帧已审核通过！点击推入 Colab 队列进行动态镜头生成，全部就绪后由本地 T4 压制 1080p 成片。
                      </p>
                    </div>

                    {/* 实时分镜就绪进度条 */}
                    <div className="space-y-2 bg-zinc-800/50 p-4 rounded-xl border border-zinc-700/60 text-left">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-zinc-300 flex items-center gap-1.5">
                          <Film className="w-4 h-4 text-cyan-400" />
                          分镜视频渲染与下载就绪度
                        </span>
                        <span className="font-mono font-bold text-emerald-400">
                          {completedShotsCount} / {shotsList.length} 镜头就绪 ({shotsList.length > 0 ? Math.round((completedShotsCount / shotsList.length) * 100) : 0}%)
                        </span>
                      </div>
                      <div className="w-full bg-zinc-900 h-2.5 rounded-full overflow-hidden border border-zinc-700/50">
                        <div
                          className="bg-gradient-to-r from-cyan-500 to-emerald-400 h-full transition-all duration-500"
                          style={{ width: `${shotsList.length > 0 ? (completedShotsCount / shotsList.length) * 100 : 0}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-zinc-400">
                        <span>
                          {isAllClipsReady
                            ? "🎉 所有分镜视频已全部就绪！请点击右侧按钮立即合成 1080p 成片。"
                            : isCloudGeneratingClips
                            ? "⚡ Colab 正在并行渲染与自动下载分镜视频片段 (每 3 秒自动轮询刷新)..."
                            : "分镜已通过审核，点击下方按钮将任务推入 Colab 执行队列。"}
                        </span>
                        {isCloudGeneratingClips && (
                          <span className="text-cyan-400 font-mono flex items-center gap-1 text-[10px]">
                            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
                            云端流式就绪中
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 操作控制区 */}
                    <div className="flex gap-4 justify-center items-center pt-1">
                      <button
                        disabled={isSubmittingCloud || isCloudGeneratingClips}
                        onClick={handleSubmitToCloud}
                        className="px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold transition cursor-pointer disabled:opacity-50"
                      >
                        {isSubmittingCloud ? (
                          <>
                            <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                            正在下发云端...
                          </>
                        ) : isCloudGeneratingClips ? (
                          <>
                            <RotateCcw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                            云端生成中 ({completedShotsCount}/{shotsList.length})...
                          </>
                        ) : isAllClipsReady ? (
                          "✅ 分镜已全部就绪 (可重新下发)"
                        ) : (
                          "推入 Colab 任务队列"
                        )}
                      </button>

                      <button
                        disabled={isComposing || !isAllClipsReady}
                        onClick={handleComposeFinalVideo}
                        className={`px-6 py-2.5 rounded-xl font-bold text-xs flex items-center gap-2 transition cursor-pointer disabled:opacity-50 ${
                          isAllClipsReady
                            ? "bg-emerald-500 hover:bg-emerald-400 text-black shadow-lg shadow-emerald-500/30 ring-2 ring-emerald-400 animate-pulse"
                            : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                        }`}
                      >
                        {isComposing ? (
                          <>
                            <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                            本地 T4 正在进行多轨音画对齐与硬件压制...
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5" />
                            {isAllClipsReady ? "✨ 镜头全部就绪，立即一键合成 1080p 成片" : "本地 T4 最终合成 1080p 成片 (等待全部镜头)"}
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* 分镜视频就绪看板 */}
                  {shotsList.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-zinc-200 flex items-center gap-2">
                          <Film className="w-4 h-4 text-emerald-400" />
                          分镜视频渲染状态看板 ({shotsList.length} 镜头)
                        </span>
                        <span className="text-[11px] text-zinc-400">已就绪 {completedShotsCount} / {shotsList.length} 个镜头</span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
                        {shotsList.map((shot: any) => {
                          const isDone = shot.status === "done" || !!shot.videoPath;
                          let videoSrc: string | null = null;
                          if (shot.videoPath) {
                            if (shot.videoPath.includes("/outputs/")) {
                              videoSrc = "/outputs/" + shot.videoPath.split("/outputs/")[1];
                            } else {
                              videoSrc = shot.videoPath.startsWith("/") ? shot.videoPath : `/${shot.videoPath}`;
                            }
                          }

                          let keyframeSrc: string | null = null;
                          if (shot.keyframePath) {
                            if (shot.keyframePath.includes("/uploads/")) {
                              keyframeSrc = "/uploads/" + shot.keyframePath.split("/uploads/")[1];
                            } else {
                              keyframeSrc = shot.keyframePath.startsWith("/") ? shot.keyframePath : `/${shot.keyframePath}`;
                            }
                          }

                          return (
                            <div
                              key={shot.id}
                              className={`p-3 rounded-xl border transition-all flex flex-col justify-between ${
                                isDone
                                  ? "bg-zinc-900/80 border-emerald-500/40 shadow-sm"
                                  : isCloudGeneratingClips
                                  ? "bg-zinc-900/50 border-cyan-500/30 animate-pulse"
                                  : "bg-zinc-900/40 border-zinc-800"
                              }`}
                            >
                              <div className="space-y-2">
                                <div className="flex items-center justify-between text-xs">
                                  <span className="font-bold text-zinc-200">#{shot.id} {shot.type || "分镜"}</span>
                                  {isDone ? (
                                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[10px] font-bold flex items-center gap-0.5">
                                      <CheckCircle2 className="w-2.5 h-2.5" />
                                      就绪
                                    </span>
                                  ) : isCloudGeneratingClips ? (
                                    <span className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold flex items-center gap-0.5">
                                      <RotateCcw className="w-2.5 h-2.5 animate-spin" />
                                      生成中
                                    </span>
                                  ) : (
                                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[10px]">
                                      等待
                                    </span>
                                  )}
                                </div>

                                {/* 视频微预览或关键帧切片 */}
                                <div className="aspect-[9/16] rounded-lg overflow-hidden bg-black/60 border border-zinc-800 relative flex items-center justify-center">
                                  {isDone && videoSrc ? (
                                    <video
                                      src={videoSrc}
                                      controls
                                      className="w-full h-full object-cover"
                                      preload="metadata"
                                    />
                                  ) : keyframeSrc ? (
                                    <img
                                      src={keyframeSrc}
                                      alt={`分镜 #${shot.id} 关键帧`}
                                      className="w-full h-full object-cover opacity-60"
                                    />
                                  ) : (
                                    <Video className="w-6 h-6 text-zinc-600" />
                                  )}
                                </div>

                                <p className="text-[10px] text-zinc-400 line-clamp-2 leading-relaxed">
                                  {shot.description}
                                </p>
                              </div>

                              <div className="mt-2 pt-2 border-t border-zinc-800/60 flex items-center justify-between text-[10px] text-zinc-500 font-mono">
                                <span>{shot.durationSec || 5}s</span>
                                <span className="text-emerald-400/80">{isDone ? "本地已落盘" : "待云端返回"}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* 成片在线播放器 */}
                  {finalVideoUrl && (
                    <div className="bg-zinc-900/60 p-6 rounded-2xl border border-zinc-800 space-y-4 text-center">
                      <span className="text-xs font-bold text-emerald-400 block">成片渲染完毕！</span>
                      <div className="aspect-[9/16] max-w-xs mx-auto rounded-xl overflow-hidden border border-zinc-800 shadow-2xl">
                        <video src={finalVideoUrl} controls autoPlay className="w-full h-full object-cover" />
                      </div>
                      <div className="flex items-center justify-center gap-3">
                        <a
                          href={finalVideoUrl}
                          download="clipforge_final.mp4"
                          className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold transition shadow-lg shadow-emerald-500/20"
                        >
                          <Download className="w-4 h-4" />
                          下载成片 MP4
                        </a>
                        <button
                          type="button"
                          onClick={handleCopyAllVoiceovers}
                          className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-bold text-zinc-200 transition"
                        >
                          <Copy className="w-4 h-4 text-amber-400" />
                          复制完整台词文案
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </main>
        </>
      )}

      {/* 视图 2：全部视频任务列表与进度面板 */}
      {activeTab === "taskList" && (
        <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
                <ListOrdered className="w-5 h-5 text-cyan-400" />
                全部视频生成任务进度
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                实时追踪每个视频项目的阶段进度与当前状态，点击可直接切入对应工作台步骤
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={fetchProjects}
                disabled={isLoadingProjects}
                className="px-3.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium flex items-center gap-1.5 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingProjects ? "animate-spin" : ""}`} />
                刷新列表
              </button>
              <button
                onClick={handleNewProject}
                className="px-4 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold flex items-center gap-1.5 transition shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                新建视频
              </button>
            </div>
          </div>

          {/* 项目任务列表表格/卡片 */}
          {projectList.length === 0 ? (
            <div className="border-2 border-dashed border-zinc-800 rounded-2xl p-16 text-center space-y-3">
              <Film className="w-10 h-10 text-zinc-600 mx-auto" />
              <p className="text-xs text-zinc-400">暂无视频任务，点击上方「新建视频」开始第一条创作！</p>
            </div>
          ) : (
            <div className="space-y-4">
              {projectList.map((item) => (
                <div
                  key={item.id}
                  className="bg-zinc-900/60 p-5 rounded-2xl border border-zinc-800 hover:border-zinc-700 transition space-y-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-zinc-800 flex items-center justify-center text-emerald-400 font-bold text-xs">
                        {item.step}/4
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                          {item.name}
                          <span className="text-[11px] font-normal text-zinc-400">
                            ({item.productName} · {item.productPrice || "特惠"})
                          </span>
                        </h3>
                        <p className="text-[11px] text-zinc-500">
                          创建时间: {new Date(item.createdAt).toLocaleString("zh-CN")}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {/* 进度徽章 */}
                      {item.step === 5 ? (
                        <span className="px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-semibold flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          已成片输出
                        </span>
                      ) : item.status === "cloud_running" ? (
                        <span className="px-2.5 py-1 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20 text-xs font-semibold flex items-center gap-1">
                          <Lock className="w-3 h-3" />
                          云端渲染中 (只读锁定)
                        </span>
                      ) : item.step === 4 ? (
                        <span className="px-2.5 py-1 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 text-xs font-semibold flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          九宫格已审通过
                        </span>
                      ) : item.step === 3 ? (
                        <span className="px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs font-semibold flex items-center gap-1">
                          <AlertCircle className="w-3.5 h-3.5" />
                          待人工审核九宫格
                        </span>
                      ) : item.step === 2 ? (
                        <span className="px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 text-xs font-semibold flex items-center gap-1">
                          <Bot className="w-3.5 h-3.5" />
                          剧本已生成 ({item.shotsCount}分镜)
                        </span>
                      ) : (
                        <span className="px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700 text-xs font-semibold">
                          草稿策划中
                        </span>
                      )}

                      {/* 复制文案按钮 */}
                      <button
                        type="button"
                        onClick={() => handleCopyProjectScript(item.id)}
                        className="px-2.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium flex items-center gap-1 transition"
                        title="复制该项目完整分镜脚本与台词"
                      >
                        <Copy className="w-3.5 h-3.5 text-amber-400" />
                        文案
                      </button>

                      {/* 下载成片按钮 */}
                      {item.videoUrl && (
                        <a
                          href={item.videoUrl}
                          download={`${item.name || "video"}.mp4`}
                          className="px-2.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium flex items-center gap-1 transition"
                          title="下载成片 MP4"
                        >
                          <Download className="w-3.5 h-3.5 text-cyan-400" />
                          下载
                        </a>
                      )}

                      {/* 跳转工作台按钮 */}
                      <button
                        onClick={() => handleLoadProject(item.id)}
                        className="px-3.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold flex items-center gap-1 transition"
                      >
                        载入工作台
                        <ChevronRight className="w-3.5 h-3.5 text-emerald-400" />
                      </button>

                      {/* 删除项目按钮 */}
                      <button
                        type="button"
                        onClick={() => handleDeleteProject(item.id, item.name)}
                        className="p-1.5 rounded-xl bg-zinc-800 hover:bg-red-500/20 text-zinc-400 hover:text-red-400 transition"
                        title="彻底删除该视频项目"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* 步骤条进度指示器 */}
                  <div className="grid grid-cols-4 gap-2 pt-2 border-t border-zinc-800/80">
                    <div
                      className={`h-1.5 rounded-full ${
                        item.step >= 1 ? "bg-emerald-500" : "bg-zinc-800"
                      }`}
                    />
                    <div
                      className={`h-1.5 rounded-full ${
                        item.step >= 2 ? "bg-emerald-500" : "bg-zinc-800"
                      }`}
                    />
                    <div
                      className={`h-1.5 rounded-full ${
                        item.step >= 3 ? "bg-emerald-500" : "bg-zinc-800"
                      }`}
                    />
                    <div
                      className={`h-1.5 rounded-full ${
                        item.step >= 4 ? "bg-emerald-500" : "bg-zinc-800"
                      }`}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      )}
    </div>
  );
}
