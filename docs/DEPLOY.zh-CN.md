# MemoSync 部署指南（中文）

把这份文件交给你的 AI 编程助手（Claude Code / Cursor 等），说"照这个文件帮我部署"即可。人工手动执行也完全可以，全程约 5 分钟。

> **给 AI 助手的执行约定**：按顺序执行每一步，核对"预期结果"后再进行下一步；`DEEPSEEK_API_KEY` 必须向使用者本人索要，绝不能虚构或使用其他来源的 key；不要把 `.env` 提交进 git；不需要 Docker，不需要安装或登录 Claude Code；遇到故障先查文末对照表。

## 0. 前提

- macOS 或 Linux（Windows 请用 WSL）。
- 一把 DeepSeek API key（在 https://platform.deepseek.com 申请）。

## 1. 安装 Bun（已装可跳过）

```bash
bun --version
```

预期结果：输出版本号且 ≥ 1.3.5。如果命令不存在：

```bash
curl -fsSL https://bun.sh/install | bash
```

装完**重开终端**再验证一次 `bun --version`。

## 2. 获取代码

```bash
git clone <仓库地址> MemoSync
cd MemoSync
```

或者：解压压缩包并 `cd` 进目录。

## 3. 安装依赖

```bash
bun install
```

预期结果：以 `xxx packages installed` 结尾，无红色报错。首次安装约 1–2 分钟。

## 4. 配置 API key

```bash
cp .env.example .env
```

然后编辑 `.env`，把 key 填进第一个变量：

```
DEEPSEEK_API_KEY=sk-xxxxxxxx
```

其余变量都可以不动。**AI 助手注意**：这一步必须让使用者提供真实 key；填完后不要展示或外发 key 内容。

_（可选）_ 如果你还有一把 **GLM key**（bigmodel.cn），在 `.env` 里再加一行，就能在模型选择里试用 GLM-5.3-Flash；不加不影响，DeepSeek 照常用：

```
GLM_API_KEY=你的GLM key
```

## 5. 构建并启动

```bash
bun run build
```

预期结果：两次 `✓ built in ...` 且无报错。

```bash
bun run start
```

预期结果：终端出现两行关键日志，然后自动打开浏览器：

```
[engine] Claude Code engine → DeepSeek (https://api.deepseek.com/anthropic, ...)
[memosync] ... http://localhost:3210
```

> 若终端没出现 `[engine] ... → DeepSeek` 这行，说明 key 没被读到（多半是 `.env` 不在当前目录或没填），回到第 4 步。

## 6. 验证（AI 助手请代为执行）

另开一个终端：

```bash
curl -s http://127.0.0.1:3210/health
```

预期结果：`{"ok":true,"port":3210}`。

浏览器打开 **http://127.0.0.1:3210**（个别机器上 `localhost` 会解析到 IPv6 打不开，用 `127.0.0.1` 最稳），应看到 MemoSync 首页。点 "Add a project" 添加你自己的一个项目文件夹，随便发一条消息，收到回复即部署成功。

底部模型选择器分两级：左边选厂商（DeepSeek / GLM），右边选具体模型（DeepSeek 有 V4 Flash / V4 Vision / V4 Pro；GLM 有 GLM-5.3 Flash，需已配 `GLM_API_KEY`）。

日常使用：保持 `bun run start` 的终端开着即可；关掉终端 = 关掉 MemoSync，下次再 `bun run start`（不用重新 build，除非更新了代码）。

## 7. 数据说明

所有数据（对话、记忆、使用记录）都只存在你本机 `~/.memosync/data/`，**不会自动上传任何地方**。详见 [DATA_AND_TELEMETRY.md](DATA_AND_TELEMETRY.md)。需要打包时在代码目录里跑：

```bash
bun run export-data
```

它会在当前目录生成 `memosync-export-*.tar.gz`（默认只含使用记录和记忆库，**不含聊天原文**；需要聊天记录时用 `bun run export-data --full`）。

## 8. 更新版本

在代码目录里依次执行：

```bash
git pull
```
```bash
bun install
```
```bash
bun run build
```

然后关掉在跑的 `bun run start`（Ctrl+C）再重新 `bun run start`。

**你的数据不受影响**：对话、记忆、项目都存在 `~/.memosync/data/`，和代码分开，更新只动代码、不碰这个文件夹。

## 故障对照表

| 现象 | 处理 |
| --- | --- |
| `bun: command not found`（刚装完） | 重开终端，或 `source ~/.zshrc` |
| 启动报端口被占（`EADDRINUSE`/自动换端口） | 用 `bun run start --port 4000` 换个端口，或找到占用 3210 的进程关掉 |
| 浏览器打不开 localhost:3210 | 改用 http://127.0.0.1:3210 |
| 聊天报 "There's an issue with the selected model" | 终端里确认启动日志有 `[engine] ... → DeepSeek` 这行；没有则 `.env` 的 key 没生效。若日志里有 `ignoring inherited ANTHROPIC_BASE_URL`，属正常（系统在忽略你机器上的残留配置） |
| 聊天一直无响应/报 401 | key 填错或额度用尽 |
| 选了 GLM 后聊天报错/401 | `.env` 里没填 `GLM_API_KEY`，或 key 无效；不想用 GLM 就在模型选择器左边切回 DeepSeek |
| 发消息前弹出记忆确认卡不知道点什么 | 点红色的 Start / Go on 继续即可；这是正常功能（记忆注入确认），不是卡死 |
| 转录里出现 "CONTEXT COMPACTED" 波浪线 | 正常现象：对话太长被自动摘要，已保存的记忆不受影响 |
