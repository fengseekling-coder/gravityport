# GravityPort

[English](README.md) | 简体中文

[![CI](https://github.com/fengseekling-coder/gravityport/actions/workflows/ci.yml/badge.svg)](https://github.com/fengseekling-coder/gravityport/actions/workflows/ci.yml)
[![License: PolyForm Shield 1.0.0](https://img.shields.io/badge/license-PolyForm%20Shield%201.0.0-blue)](LICENSE)
[![Platforms: macOS arm64 | Windows x64](https://img.shields.io/badge/platforms-macOS%20arm64%20%7C%20Windows%20x64-lightgrey)](#下载)

> **为 AI 创作留住本地视觉记忆。**
> 把 AI 生成的每一张图，连同 Prompt、来源和版本，留在自己的电脑上。

GravityPort 是一个 AI 素材管理工具：把 ChatGPT、Gemini、Flow、Google AI Studio、Codex、Grok、即梦 生成的图片和视频，连同 Prompt、参考图和来源，自动收进你自己电脑上的素材库。

![GravityPort 画廊与检视器](docs/images/gravityport-app.webp)

**本地优先 · Prompt 与来源 · 版本历史 · 无 GravityPort 云账户**

[下载](#下载) · [第一次打开](#第一次打开) · [中文使用指南](docs/guide.zh-CN.md) · [隐私](PRIVACY.md) · [文档](#文档)

## 下载

从[官方下载页](https://gravityport.azhuilab.com/#download)获取 GravityPort。下载页始终列出现行安装包的体积；Windows 包还标注 SHA-256 校验值。

- **GravityPort 桌面版 macOS**（Apple Silicon）：DMG 镜像。把 `GravityPort.app` 拖入「应用程序」。
- **GravityPort 桌面版 Windows 10/11**（x64）：安装程序。双击即可安装到当前 Windows 账户（不需要管理员），开始菜单和桌面会出现 GravityPort，装好后自动打开。卸载在「设置 → 应用」里，素材库会保留。（0.3.3 及更早版本是便携 ZIP：解压后运行 `GravityPort.exe`。）
- **GravityPort 网页采集扩展**（Chrome / Chromium，可选）：ZIP 包，先启动桌面应用再加载，两边会自动配对。安装步骤见[安装指南](https://gravityport.azhuilab.com/guide/)。

已安装的桌面应用会在 **设置 → 关于** 里自行检查更新。[发布清单](https://gravityport.azhuilab.com/releases/gravityport/latest.json)是最新版本的机器可读来源。

## 第一次打开

- **macOS：** 打开「系统设置 → 隐私与安全性」，在 GravityPort 旁边点**仍要打开**。只需一次。
- **Windows：** 安装程序还没有代码签名，SmartScreen 可能提示「Windows 已保护你的电脑」。点**更多信息 → 仍要运行**。只在安装时出现一次。

## 为什么需要 GravityPort

单看一张图，很难知道下次怎么再用它：Prompt 可能在另一段对话里，生成工具可能已经想不起来，真正想要的那个版本可能混在一堆近似图中间。

GravityPort 把每张素材和让它可复用的上下文重新连在一起：可用的 Prompt、生成来源、出处信息和版本历史。素材库始终在你自己的电脑上，由你掌控。

## 主要功能

### 把上下文和素材存在一起

把生成的图片和视频连同可用的 Prompt、来源、模型或工具信息、时间戳和出处一起归档。某个 Prompt 不可用时，GravityPort 会如实记录，而不是编造一个。

### 拖拽整理

在同一个画廊里浏览和搜索：列数可调，支持框选和多选。把卡片拖到侧栏分组即可归档，拖到另一张卡上即可创建或加入堆叠，在堆叠内拖动即可重新排序，拖出窗口即可把文件交给其他应用。通过拖拽新建或加入的堆叠，几秒内可以撤销。

### 在版本树上迭代

检视器展示每张素材的版本树：来自同一个 ChatGPT 对话的生成按对话轮次分组，可以逐轮查看图片是怎么演变过来的。同一家族中的任意两个版本都可以并排比较。

### 让 AI 代理检索你的素材库

内置的 MCP 服务器让 Claude、Codex 等 MCP 客户端可以在同一个本地素材库里列出、搜索和记录素材、Prompt、版本与生成历史。`asset_search` 支持文本和时间范围。桌面版自带这个服务：在「设置 → 连接」里复制 Claude Desktop、Claude Code 或 Codex 的现成配置即可接入，不用装 Node.js，也不用下载源码；从源码运行用 `npm run mcp`。配置方法和工具清单见 [MCP 与接口](docs/guide.zh-CN.md#mcp-与接口)。

### 找回误删的作品

删除的素材进入回收站，保留 90 天并逐张显示倒计时；刚删除时会出现撤销按钮，回收站有自己的恢复、永久删除和清空菜单。

设置 → 反馈可以发送 bug 报告和建议，可以选择附上一份先脱敏、发送前可完整查看的诊断日志。Pinterest 入口已经在应用里显示，等 Pinterest 批准正式接口后开放。

## 融入你的工作流

| 你在哪里创作 | GravityPort 收进什么 |
| --- | --- |
| **Codex Desktop** | 生成的图片，以及可得时匹配到的本地生成上下文 |
| **Chrome 里的 ChatGPT、Gemini、Flow、Google AI Studio、即梦** | 通过本地扩展，可选收录网页生成的可见图片/视频和保守的页面级上下文 |
| **ChatGPT 桌面应用** | 桌面聊天里生成的图片，由同一个扩展（开启自动采集时）借助浏览器里的 ChatGPT 登录收录 |
| **Grok**（Grok Build CLI） | 本地会话产出的图片和视频，可得时匹配工具上下文 |

另外还支持 Cowart 画布归档等集成，配置见[中文使用指南](docs/guide.zh-CN.md)。

无论来自哪个来源，一切都会进入同一个本地画廊：分组、堆叠、可撤销删除的回收站和版本树。GravityPort 不生成媒体内容，也不替代这些工具。

## 平台状态

| 目标 | 状态 |
| --- | --- |
| macOS arm64 | 主桌面目标。首次安装用 DMG，之后走应用内更新。 |
| Windows 10/11 x64 | 首次安装用安装程序，之后走应用内更新。暂无代码签名。 |

## 从源码运行

面向开发，或在不安装桌面壳的情况下把 GravityPort 当作本地 Web 应用运行。需要 Node.js 22 或更新版本和 npm。

```bash
git clone https://github.com/fengseekling-coder/gravityport.git
cd gravityport
npm ci      # 安装依赖并构建界面
npm start   # 在 127.0.0.1:43517 启动本地服务
```

打开 <http://127.0.0.1:43517>。运行 `npm test` 可以检查本地代码是否正常。Codex Desktop 和 Cowart 插件是可选集成；[中文使用指南](docs/guide.zh-CN.md) 讲解它们的配置，以及每个来源各自的收录行为。

Electron 桌面壳使用同一套 Web 界面和本地运行时：

```bash
npm run desktop:start

# macOS arm64 DMG
npm run desktop:make

# Windows 10/11 x64 打包目录
npm run desktop:package:windows
```

桌面打包需要 Node.js 22.x：仓库在 `.nvmrc` 和 `.node-version` 里钉住 `22.23.1`，换成其他主版本会被打包命令明确拦下。发布通道、签名、公证和清单发布见[发布指南](docs/releasing.md)。

## 本地优先的设计

- GravityPort 是绑定回环地址的本地 Web 界面，不是云服务，不允许通过公网端口或反向代理暴露出去。
- 它只读取配置好的 Codex、Grok 和经批准的 Cowart 位置，不扫描「下载」「桌面」或任意的图片文件夹。
- 网页采集是可选功能。打包的桌面版会自动配置本地收录 Token 和固定的已批准扩展来源；单独用 `npm start` 跑起来的运行时，在这些值被显式配置之前保持关闭。扩展只把捕获的图片字节和页面出处发送到配置好的本地 GravityPort 地址。ChatGPT 在可得时保留消息级上下文；其他支持的网站只在能安全匹配时保留少量相关联的可见用户 Prompt 文本，并标记为未验证；扩展运行的完整网站清单见 [PRIVACY.md](PRIVACY.md#web-capture-chrome-extension)。开启自动采集后，扩展还会把你刚在 ChatGPT 桌面应用里用过的对话，在一个最小化的浏览器窗口里短暂打开并采集其中的图片，详见 [PRIVACY.md](PRIVACY.md#chatgpt-desktop-app-conversations)。
- 合格的参考图作为私有的、按内容哈希去重的生成记录附件存储，不是普通的画廊素材。
- 桌面应用不内置、也不下载任何 AI 模型。GravityPort 不添加任何远端同步或自动上传。
- 打包的桌面版通过发布更新元数据所用的同一个第一方端点，以无请求体的请求发送极少的安装 / 活跃元数据，以随机安装 ID 区分安装：只包含安装 ID、版本、平台、架构和首启 / 日活事件，绝不包含素材、Prompt 或本地路径。详见 [PRIVACY.md](PRIVACY.md)，其中也说明了如何关闭。

完整的数据边界见[隐私政策](PRIVACY.md)，私密漏洞报告见[安全政策](SECURITY.md)。

## 文档

用户指南：

- [中文使用指南](docs/guide.zh-CN.md)：安装、各来源配置、本地素材库、搜索、版本、MCP 与日常维护。
- [右键菜单](docs/context-menu.md)：侧栏、卡片和画廊空白处的操作说明。
- [网页采集扩展指南](extensions/chatgpt-web-capture/README.md)：本地配置、权限、采集行为与限制。

运行与开发 GravityPort：

- [运维指南](docs/operations.md)（英文）：运行模式、迁移、备份、校验、桥接健康与恢复边界。
- [发布指南](docs/releasing.md)（英文）：发布通道、签名、更新清单、更新说明与可选包发布。
- [架构](ARCHITECTURE.md)：当前运行时、存储与集成结构。
- [界面设计规范](DESIGN.md)：桌面版界面的颜色、字体、间距、组件和文案规则。
- [贡献指南](CONTRIBUTING.md)：开发流程、检查项与隐私要求。

政策与历史：

- [隐私政策](PRIVACY.md)：数据来源、本地存储、扩展权限与网络边界。
- [安全政策](SECURITY.md)：支持的版本与私密漏洞报告。
- [支持指南](SUPPORT.md)：常见问题、bug 报告与功能建议。
- [更新日志](CHANGELOG.md) 与[网页采集扩展更新日志](extensions/chatgpt-web-capture/CHANGELOG.md)：用户可见的变化与发布状态。
- [第三方声明](THIRD_PARTY_NOTICES.md)：GravityPort 构建时所依赖或再分发的上游项目与模型。

## 许可

GravityPort 采用 [PolyForm Shield License 1.0.0](LICENSE)，是 source-available（源码公开）软件。

- 任何人都可以免费使用，包括工作中使用和接单使用。
- 可以修改，也可以转发副本，但必须保留许可条款和要求的版权声明。
- 不允许用 GravityPort 的代码做和它竞争的产品，包括改名或稍作修改后发布，免费提供也不行。拿不准自己的用法算不算竞争，见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

GravityPort 是 source-available 软件，不是经 OSI 认可的开源软件。`v0.1.0` 是 MIT 许可下的最后一个公开发布快照；0.2.0 到 0.3.5 按 PolyForm Noncommercial License 1.0.0 发布，按当时条款取得的副本继续适用当时的条款。

第三方署名另行记录在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，不改变 GravityPort 自身的许可条款。
