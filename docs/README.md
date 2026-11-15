# AI 带货短视频生产系统（复刻与工程落地指南）

> 本项目基于原开源 ClipForge 项目核心机制，针对特定硬件（本地 Tesla T4 GPU + Google AI Pro 算力组合）与严苛商业合规要求（100% 商业友好、免侵权）进行全新架构重构与复刻。
> 原项目参考代码已完整备份至 [temp/from_src/](file:///home/debian/lopy_project/clipforge/temp/from_src)。

---

## 目录导引

* 🎯 **[开发目标与进度跟踪 (DEVELOPMENT_PLAN.md)](file:///home/debian/lopy_project/clipforge/docs/DEVELOPMENT_PLAN.md)**：里程碑规划、开发进度清单、各阶段验证标准。
* 🏗️ **[系统架构与软硬件分工 (ARCHITECTURE.md)](file:///home/debian/lopy_project/clipforge/docs/ARCHITECTURE.md)**：本地 T4 与云端 Colab A100 双驱协同、前后端设计、九宫格到视频核心数据流。
* 🛡️ **[商业合规与外部依赖清单 (COMPLIANCE_AND_DEPS.md)](file:///home/debian/lopy_project/clipforge/docs/COMPLIANCE_AND_DEPS.md)**：字体、配音、大模型协议、BGM、肖像权与广告法合规闭环方案。

---

## 项目核心定位

把“一张商品实拍图”或“一句话主题”，全自动产出适合投放于**抖音小店、快手、小红书、视频号及 TikTok Shop**的高转化、高质感卖货短视频。

### 核心设计原则
1. **100% 商业友好（零侵权风险）**：彻底剔除逆向接口、未经商业授权的字库、盗版音乐与存在肖像权争议的模特。
2. **极限性价比（零增量 API 成本）**：充分盘活 Google AI Pro 权益（Gemini 2.0 Flash 免费额度 + Colab A100 积分）与本地 Tesla T4 算力，除电力和既有订阅外，日常生成逼近 ¥0 边际成本。
3. **物理级画面一致性**：采用“3×3 九宫格一次成图 + 几何切片”彻底攻克跨镜头角色换脸、商品变形的 AI 视频顽疾。
4. **真实感与去“塑料感”**：配备专业级 Voice Grounding（人声落地麦克风 EQ 模拟 + 房间环境底噪生成），杜绝数码死寂。
