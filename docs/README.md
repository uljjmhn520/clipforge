# AI 带货短视频生产系统（复刻与工程落地指南）

> 本项目基于原开源 ClipForge 项目核心机制，针对特定硬件（本地 Tesla T4 GPU + Google AI Pro 算力组合）与严苛商业合规要求（100% 商业友好、免侵权）进行全新架构重构与复刻。
> 原项目参考代码已完整备份至 [temp/from_src/](file:///home/debian/lopy_project/clipforge/temp/from_src)。

---

## 目录导引

* 🧩 **[系统模块拆解与接口设计 (MODULE_DESIGN.md)](file:///home/debian/lopy_project/clipforge/docs/MODULE_DESIGN.md)**：6 大核心业务子模块划分、JSON-RPC over stdio 规范、Colab 云端组件。
* 🏗️ **[系统架构与软硬件分工 (ARCHITECTURE.md)](file:///home/debian/lopy_project/clipforge/docs/ARCHITECTURE.md)**：本地 T4 与云端 Colab L4/A100 双驱协同、两阶段全周期看门狗、专属 Session 绑定。
* 🎯 **[开发目标与进度跟踪 (DEVELOPMENT_PLAN.md)](file:///home/debian/lopy_project/clipforge/docs/DEVELOPMENT_PLAN.md)**：里程碑规划、开发进度清单、各阶段验证标准。
* 🛡️ **[商业合规与外部依赖清单 (COMPLIANCE_AND_DEPS.md)](file:///home/debian/lopy_project/clipforge/docs/COMPLIANCE_AND_DEPS.md)**：字体、配音、大模型协议、BGM、肖像权与广告法合规闭环方案。

---

## 项目核心定位

把“一张商品实拍图”或“一句话主题”，全自动产出适合投放于**抖音小店、快手、小红书、视频号及 TikTok Shop**的高转化、高质感卖货短视频。

### 核心设计原则
1. **100% 商业友好（零侵权风险）**：彻底剔除逆向接口、未经商业授权的字库（锁定思源黑体/阿里普惠体）、盗版音乐与存在肖像权争议的模特。
2. **极限性价比（零增量 API 成本）**：充分盘活 Google AI Pro 权益（Gemini 3.8 Flash 免费额度 + Colab L4 积分）与本地 Tesla T4 算力，除电力和既有订阅外，日常生成逼近 ¥0 边际成本。
3. **物理级画面一致性 + 强人工闸门**：采用“3×3 九宫格一次成图 + 几何切片”，支持单格手工替换，未获人工确认绝不下发云端耗费算力。
4. **两阶段全周期安全看门狗**：开机即激活 15 分钟启动保护，就绪后转为 5 分钟忙闲轮询并支持 Web 续命，彻底杜绝 Colab 空转扣费。
5. **JSON-RPC over stdio 优雅通信**：无需任何公网穿透/ngrok，通过 `colab exec` 双向管道安全交互，视频大文件持久化落盘至 Google Drive。
