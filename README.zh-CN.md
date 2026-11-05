<p align="center">
  <img src="assets/icon.svg" alt="MemoSync" width="88" />
</p>

<h1 align="center">MemoSync</h1>

<p align="center">
  <strong>和你的编程智能体一起管理记忆，跨越每一次会话。</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Bun 1.3.5+" src="https://img.shields.io/badge/bun-%E2%89%A51.3.5-f9f1e1.svg" />
  <img alt="Local-first" src="https://img.shields.io/badge/data-local--first-2ea44f.svg" />
  <a href="https://github.com/yzfly/awesome-context-engineering"><img alt="Mentioned in Awesome Context Engineering" src="https://img.shields.io/badge/mentioned%20in-Awesome%20Context%20Engineering-fc60a8.svg?logo=awesomelists&logoColor=white" /></a>
  <a href="https://github.com/0xWelt/Awesome-Vibe-Coding"><img alt="Mentioned in Awesome Vibe Coding" src="https://img.shields.io/badge/mentioned%20in-Awesome%20Vibe%20Coding-fc60a8.svg?logo=awesomelists&logoColor=white" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b> · <a href="https://baiqiaozhang.cc/memosync/">网站</a>
</p>

<p align="center">
  <img src="docs/figures/main-ui.png" alt="MemoSync 运行中的一轮对话" width="960" />
</p>

https://github.com/user-attachments/assets/488a1e41-5a01-4c01-ac76-5c37b8e764f0

---

编程智能体都有记忆：`CLAUDE.md`、它自己总结的笔记、以前会话里的经验。但这些记忆里有什么、这次任务带进去了哪几条、它到底照做没有，通常没人看得到。

MemoSync 是一个本地运行的工作台，支持 Claude Code、Codex、Pi 和 OpenCode，把这些记忆摆到你眼前：
- 每一处改动都要你点头；
- 每一轮开始前，带哪些记忆由你确认；
- 干活时，回复会标出用了哪条；
- 结束后，另有一轮检查告诉你哪些照做了、哪些被无视了。

不想每轮都管？切到[自动模式](#自动模式)，记忆交给智能体自己处理。

<p align="center">
  <img src="docs/figures/metamemory-loop.png" alt="开发者与智能体共同监控和控制记忆" width="820" />
</p>

## 带着记忆的一轮对话

记忆由一条条简短的条目组成。每条都有作用范围（**个人**、**项目**或**会话**）、版本号和修改历史。在一轮对话里，同一条记忆会先后出现在四个地方。

### 1. 审阅它学到了什么

<p align="center"><img src="docs/figures/evolution.png" alt="审阅记忆变更" width="900" /></p>

每轮开始前，MemoSync 会把它建议的记忆改动分三组列出来。每一条你都可以接受、修改、换个作用范围，或者直接丢掉。你没同意的，一律不会写入记忆库。

- **新的候选记忆**：从上一轮对话和智能体实际的操作（改了哪些文件、跑了什么命令、遇到什么报错）里提炼出来。
- **跨项目迁移**：别的项目里的规则不会原样照搬，而是先改写成通用的说法，再结合当前项目改写一遍。原文、通用版和改写版并排给你看。
- **修正已有条目**：互相冲突的、可以合并的重复项，以及已经过时或者一再被违反的规则。

### 2. 挑选这一轮的工作记忆

<p align="center"><img src="docs/figures/selection.png" alt="挑选本轮工作记忆" width="900" /></p>

**本轮工作记忆**会列出智能体打算用的条目，每条附一句话，说明它准备怎么用。你可以删掉几行，也可以从记忆库里补几条，还可以直接用大白话说，比如「跟提交规范有关的都去掉」。你确认之后它才开始干活，事后的检查也严格按这份清单来核对。

### 3. 边干边看

<p align="center"><img src="docs/figures/execution.png" alt="查看引用并中途叫停" width="900" /></p>

回复里用到某条记忆时会带上引用标记（`M-07`），鼠标悬停就能看到原文。

工具调用会折叠成一行，比如“读了 3 个文件，运行了 2 条命令”，旁边显示正在跑的那一步。点开能看每一步和它的输出。

发现它跟记忆反着来，可以这样处理：
1. 在那个引用上点**停止**；
2. 写下本来应该怎么做；
3. 需要的话，勾选强制它在接下来的运行里遵守这条记忆。

它会从你叫停的那句话接着往下做，你写的纠正也会存回这条记忆。

不过引用只是智能体自己说用了，不代表真的照做了。所以还有第 4 步。

### 4. 核对结果

<p align="center"><img src="docs/figures/impact.png" alt="一轮结束后的记忆使用审查" width="900" /></p>

一轮结束后，**记忆使用审查**会单独把整轮对话从头读一遍，给每条选中的记忆一个结论：**已违反**、**影响了本轮**、**本轮不适用**或**无可见影响**。每个结论都注明是审查自己发现的还是智能体自报的，所以就算它违反了一条却根本没引用，也逃不掉。

被判违反的条目：
- 点**使用位置**，直接跳到判定依据所在的那句话和那次工具调用；
- 点**下次运行强制执行**，下一轮就会把它列为必选项，只有你能移除。

结论也会回到执行轨迹上：用到的记忆标在对应的工具调用旁边，违反的会标红。

审查本身也是模型做出的判断，可能出错。

### 两轮之间

<p align="center"><img src="docs/figures/memory-board.png" alt="记忆看板" width="900" /></p>

**记忆看板**是整个记忆库。左侧列出所有作用范围、项目和会话，还有待审阅的、已归档的条目和记忆文件。记忆库可以用**关系图**看每条记忆归属哪里，也可以用**看板**按作用范围分栏看：
- 在看板里把条目拖到另一栏，就改了它的作用范围；
- 点开一条，可以编辑、查看历史或归档；
- **记忆文件**会同步一份 Markdown 副本，方便别的工具使用，也能把已有的 `CLAUDE.md` 导入成候选，逐条审阅。

看板顶部的**导入记忆**会把 Claude Code 和 Codex 已有的记忆搬进来。你选一个模型，它把原来的笔记拆成一条条短记忆，分成个人偏好和各个项目的记忆。你审阅之前，什么都不会保存。以后再导入，只提出有变化的部分；你删掉的条目放在**已移除**里，随时可以找回。

**记忆记录**在每个对话的右侧，记下每一轮提议了什么、选了什么、引用了什么、在哪儿停过、审查结论是什么。上下文被压缩之后，它依然还在，你和智能体都能回头查。

### 自动模式

记忆要紧的时候，每轮审一遍很值；问个简单问题，就显得多余了。把**设置 → 记忆 → 控制方式**设为**自动**：
- 开始前不弹任何卡片，智能体自己查看记忆索引，需要哪条就读哪条；
- 每轮结束后在后台学习：不敏感的改动直接生效，每条都能撤销；敏感的留在记忆看板，侧边栏会显示数量；
- 审查照常进行，但只在发现违反时才在对话里提醒，所有结论仍记在记忆记录里。

## 快速开始

### Mac 应用

从 [Releases](https://github.com/SLEEPYBQ/MemoSync/releases/latest) 下载 DMG，把 MemoSync 拖进“应用程序”。应用只支持 Apple 芯片的 Mac；Intel Mac 请[从源码运行](#从源码运行)。

应用还没有经过 Apple 公证，第一次打开会被 macOS 拦下。先尝试打开一次，再到**系统设置 → 隐私与安全性**，点**仍要打开**。

应用里不带智能体，请先装好 Claude Code 或 Codex。要用 Pi，需要安装 `@earendil-works/pi-coding-agent` 1.3.0 或更新版本。应用和源码版共用 `~/.memosync/data`，两者不能同时运行。

### 从源码运行

需要 [Bun](https://bun.sh) 1.3.5 或更新版本，再加上下面任意一种：
- 已经登录好的 Claude Code 或 Codex；
- 任意一家服务商的 API key。

```bash
git clone https://github.com/SLEEPYBQ/MemoSync.git
cd MemoSync
bun install
bun run build
bun run start
```

浏览器会打开 <http://localhost:3210>。

### 开始使用

1. 打开**设置 → 模型**，选一个引擎，给它接上模型（见下一节）。
2. 点侧边栏的 **+**，再点**添加项目**，选一个文件夹。
3. 发一个任务试试。记忆库一开始是空的，所以头几轮多半是在提议新记忆。审过几轮，记忆就攒起来了。

## 接入模型

**引擎**是真正干活的智能体，**接入方式**决定它连哪个模型。两者都在**设置 → 模型**里配置。

| 引擎 | 运行的程序 | 接入方式 |
| --- | --- | --- |
| **Claude Code** | 你装好的 `claude`；源码版没装时用 Agent SDK 自带的那份 | 自己的登录，或支持 Anthropic API 或 OpenAI Chat 的 API 连接 |
| **Codex** | 你装好的 `codex`（必须安装） | 自己的登录，或支持 OpenAI Responses API 或 OpenAI Chat 的 API 连接 |
| **Pi** | MemoSync 内置；Mac 应用要用你本机装的 `pi` | 支持 OpenAI Chat 或 Responses API 的 API 连接 |
| **OpenCode** | 你装好的 `opencode`，需要 1.17.4 或更新版本 | 自己的 OpenCode 登录，或支持 Anthropic API、OpenAI Responses 或 OpenAI Chat 的 API 连接 |

连接只支持 OpenAI Chat 时，MemoSync 会在本机 `127.0.0.1` 上起一个转换层，替 Claude Code 和 Codex 做协议转换，引擎卡片上会标出**经协议转换**。引擎本身拿不到你的 key。

**自己的登录**：直接沿用你本机已有的登录和配置，MemoSync 不会往里加任何东西。引擎显示**还没有登录**的话，先在终端里登录，再点**重新检测**。

**API 连接**：
1. 点**添加连接**；
2. 选一家服务商，或者选**自定义地址**：
   - **服务商**：内置七十多家厂商、中转和本地服务，地址都已填好，大多数连模型也一并填好。贴上 key；模型列表是空的话，再填一个模型 ID；
   - **自定义地址**：填写 Base URL、协议、key 和模型 ID；
3. 点**测试**，发一个很小的请求，确认能连通；
4. 回到引擎卡片，选上这个连接和默认模型。

用 API 连接时，引擎运行在 `~/.memosync/data/cli-profiles` 下的独立配置里，你自己的 `~/.claude` 和 `~/.codex` 不会被读取，也不会被改动。key 保存在 `~/.memosync/data/credentials.json`，只有你的账户能读，也不会回传给浏览器。

MemoSync 会在 `PATH` 和常见的安装位置里找 `claude` 和 `codex`。想指定某个可执行文件，在引擎卡片里填上它的路径。版本太旧且 MemoSync 能识别其安装方式时，引擎卡片上会出现**升级**按钮。

## 日常用到的控制

**输入框下方**可以切换：
- 项目；
- **+** 添加文件，也可以直接拖进来；
- **记忆**菜单：**关闭**只影响这个对话，**请求**和**自动**对应下面的控制方式；
- 引擎和模型；
- 推理强度，支持的 Claude 模型还可以打开 **Ultracode**；
- **模式**菜单：设定智能体不经询问可以做哪些事，规划模式也在这里（先给出方案，等你同意了再动手）。

在输入框里输入 `/`，可以用引擎自带的命令和技能。发第一条消息之前就能用。

**设置 → 记忆**：

| 设置 | 作用 |
| --- | --- |
| **使用记忆** | 全局关闭记忆。记忆库原样保留在记忆看板里。 |
| **从对话中学习** | 照常使用已有记忆，但不再提议新条目。 |
| **控制方式** | **每轮确认**：按上面四步走。**自动**：不打扰你，见[自动模式](#自动模式)。 |
| **记忆变更** | **先询问**：每条提议都等你审。**自动应用**：不敏感的提议直接生效，每条都能一键撤销；敏感的仍然会问你。 |
| **记忆预览** | 每轮开始前显示工作记忆卡片；也可以设成没有适用记忆时自动跳过。 |

记忆变更和记忆预览只在「每轮确认」下生效。

**设置里的其他页面**：
- **外观**：语言（English / 简体中文）和主题；
- **通知**：对话需要你处理时的提示音和系统通知；
- **快捷键**：所有快捷键；
- **技能**：全局安装的智能体技能。

## 换个方式运行

```bash
bun run start --port 4000        # 换个端口
bun run start --no-open          # 不自动打开浏览器
bun run start --remote           # 监听 0.0.0.0，供局域网或 Tailscale 访问
bun run start --password <pw>    # 打开前先输入密码
bun run start --share            # 生成临时公网地址和二维码
```

全部参数见 `bun run start --help`。

## 数据与隐私

MemoSync 的所有数据都存在你本机的 `~/.memosync/data/` 下：
- 记忆（SQLite，加上 Markdown 副本）；
- 对话和设置；
- API 连接；
- 一份本地使用日志，记录记忆功能的使用情况。

MemoSync 不会上传任何东西。但你选的模型服务商会收到对话内容、选中的记忆，以及智能体读到的项目内容。

导入时只读取 Claude Code 和 Codex 的记忆文件夹，不做任何改动。精炼时，选中的记忆会发给你选的模型；这是一次性的会话，不带任何工具，也不会留在引擎自己的历史里。

智能体和终端以你的用户身份运行，能访问你的文件。独立配置只隔离配置文件，不隔离文件系统。

想关掉使用日志，设置 `MEMOSYNC_USAGE_LOG=0`。想把数据打包导出：

```bash
bun run export-data          # 使用日志、记忆和设置
bun run export-data --full   # 另外包含对话记录
```

导出的数据里不包含 API 连接和 key。

各个文件和事件的说明见 [docs/DATA_AND_TELEMETRY.md](docs/DATA_AND_TELEMETRY.md)。

## 开发

```bash
bun run dev       # 前端 :5174 + 后端 :5175，热更新
bun test src/     # 单元和集成测试，不联网
bun run check     # 类型检查和前端构建
```

服务端代码在 `src/server/`：
- `agent.ts` 负责调度一轮对话；
- `memory/` 是记忆引擎，包括提炼、体检、挑选、审查和迁移；
- `model-access/` 负责解析引擎和连接。

前端是 `src/client/` 下的 React 应用。开发模式的数据存放在 `~/.memosync-dev/`。

Mac 应用内置运行时，使用你在本机安装的智能体。开发和打包要在 macOS 上进行，只能打当前机器架构的版本：

```bash
bun run desktop:install       # 只需一次
bun run desktop:dev
bun run desktop:package:mac   # DMG 和 ZIP 在 desktop/release/
```

## 致谢

MemoSync 由 [Kanna](https://github.com/jakemor/kanna) 分叉而来，运行以下智能体：
- 通过 Agent SDK 运行 [Claude Code](https://github.com/anthropics/claude-agent-sdk-typescript)；
- 通过 `codex app-server` 运行 [Codex](https://developers.openai.com/codex/app-server/)；
- [Pi](https://github.com/badlogic/pi-mono)；
- [OpenCode](https://github.com/anomalyco/opencode)，通过 `opencode serve` 运行。

服务商预设和引擎发现移植自 [Magpie](https://github.com/yetone/magpie)，服务商图标来自 [Lobe Icons](https://github.com/lobehub/lobe-icons)。许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

[MIT](LICENSE)
