# Memory controls 实现与验证报告

在 `feat/settings-memory-controls` 上实现，基础提交为 `81d2ed3`。保留 `memory.enabled` / `memory.learn` 字段；未修改 `SettingsPage.tsx` 或 `src/client/app/settings/**`。

## 回合状态及副作用清单

所有行号指本次提交中的源文件。

| 路径 | 行为与位置 |
| --- | --- |
| 状态快照 | `src/server/agent.ts:340` 计算有效状态；`:4279` 在普通回合第一个 await 前保存。`studyMode` 强制忽略用户开关，实际能力仍由 condition policy 决定。interrupt continuation 在 `:8078` 保存同样的快照。 |
| 全部前置门控 | `src/server/agent.ts:4461` 关闭记忆时完全绕过 preview/proposals/transfer/checkup；`:4493` 直接以 `memoryDisabledForTurn: true` 启动。 |
| 仅使用、暂停学习 | `src/server/agent.ts:6071` 跳过 proposals（包括 prompt capture）、transfer、checkup 整段准备；preview 和只读使用照常运行。现有候选保持原样。 |
| 注入和工具 | `src/server/agent.ts:6667` / `:6739` 关闭注入；`:6755` 关闭 Codex 工具声明和 dispatch；`:6757` 在暂停学习时不注册 propose 工具。Claude 在 `:7264` / `:7265` 分别传入 memory/capture，关闭学习时只保留读取工具。 |
| Claude 会话复用 | `src/server/agent.ts:7229` 将学习模式纳入重建键；全关沿用原有 `memory-off` 重建流程，移除先前启动的 memory MCP server。`:7281` 同时保护提议回调。 |
| Capture 提醒 | `src/server/agent.ts:7032` 仅在快照允许学习时加入 CAPTURE_NUDGE。 |
| 回合后总入口 | `src/server/agent.ts:2816` / `:2988` 在 memoryActive=false 时跳过所有 passes；完成和取消路径传递原快照（`:7708` / `:7859` / `:8315` 附近），不重新读取设置。 |
| 回合后分项 | `src/server/agent.ts:3017` capture；`:3205` trace 驱动的 revision；`:3356` checkup precompute；`:3397` transfer prepare 均受学习快照控制。trace 在记忆开启、学习暂停时继续记录使用。 |
| 自动应用 | `src/server/agent.ts:2488` 保护 post-turn/Codex auto-apply；Claude 回调由 `:7281` 的固定能力标志保护。 |
| 引用和日志 | `src/server/agent.ts:2451` 拦截引用 bookkeeping；Claude/Codex 调用点为 `:7627` / `:7833`；`:7616` 保护 compact 日志，`:7118` 保护普通部署的 focus/injection receipt。Claude session 保留回合状态，覆盖 result 后的晚到输出；Codex 使用所属 ActiveTurn 快照。 |
| 记忆打断和恢复 | `src/server/agent.ts:7986` 拒绝打断关闭记忆的回合；`:8079` 拒绝在当前聊天记忆关闭时执行记忆恢复操作，防止选取/归因副作用。运行中修改设置不会撤销既有回合的能力。 |
| Opening Board / Working Memory | 已检查 `src/server/agent.ts:3895` 的恢复入口及 `:7412` 的 opening review admission；它们本来就只允许 study MemoSync。因此保留原研究流程，由 study policy 控制，不额外应用产品开关。 |

## 持久化及协议

- `src/server/event-store.ts:208` 验证 `chat_memory_disabled_set`；`:696` 重放；`:1126` 写入。新聊天和旧 snapshot/log 默认 false（`:389` / `:650`），fork 继承聊天开关（`:994`）。
- `src/shared/protocol.ts:134` 增加 `chat.setMemoryDisabled`，`:137` 增加首条 `chat.send.memoryDisabled`。路由见 `src/server/ws-router.ts:1533`，协调器见 `src/server/agent.ts:7350`。
- 独立 set 命令在 study mode 被拒绝；study 的 chat.send 忽略附带开关且不持久化，保持既有提示交付行为。普通新聊天在启动首个回合前持久化开关。
- `src/server/read-models.ts:142` / `:235` 输出显式 boolean；`ChatRuntime` 和 `SidebarChatRow` 都暴露此字段。`useAppState` 的 runtime 比较包含它，确保实时更新。

## 客户端及 UX 决策

- 新组件 `src/client/components/chat-ui/MemoryToggle.tsx:11` 的纯函数决定隐藏、on/off、tooltip 和操作类型。新聊天状态按 draft key 保存；发送成功后清理，失败保留。已有聊天以服务端 runtime 为准，发送 WebSocket 命令。
- 使用已安装 lucide-react 的 `BrainCircuit` 与 `Slash` 叠加为关闭图标（该版本没有 BrainOff）。按钮沿用相邻 controls 的字号、间距、圆角、颜色及 hover；on 只显示安静图标，off 显示短标签。暂停学习只增加 tooltip 提示。
- `ChatInput.tsx:975` 挂载开关；`sidebar/ChatRow.tsx:91` 挂载带 title 的微型关闭图标；`AppSidebar.tsx:618` 挂载全局 Off 标记；`MemoryBoardPage.tsx:656` 挂载 slim banner。主要 UI 逻辑均放在新组件，`ChatInputDock.tsx` 无需修改。
- `MemorySettingsBanner.tsx:16` 通过已有 `useAppState.handleWriteAppSettings` 流程写 `{ memory: { enabled: true } }` 或 `{ memory: { learn: true } }`。错误在界面内显示，不弹确认框。
- 界面显示 DeepSeek，实际使用现有 Claude 引擎适配路径，按任务中的 Claude 路径实现及验证。

## 验证结果

- `bunx tsc --noEmit`：通过。
- 最终 `bun test`：**2120 passed / 4 skipped / 0 failed**，2124 tests、212 files，7473 assertions。4 个 skip 属于仓库原有 Next preview fixture 条件测试。
- `bun run build`：client 与 export-viewer 均通过。构建仍提示既有的大 bundle、过旧 Browserslist 数据及 Node deprecation；未扩大范围修改依赖。
- 新增服务端回归涵盖：所有有效状态组合、study 三臂忽略开关、关闭时跳过门控/注入/工具/全部 post-turn passes、暂停学习保留 preview/read/trace、候选不变、等待门控及运行时设置变化、Claude 会话模式切换、首条 incognito、事件重放/compact/fork、WebSocket 路由、关闭回合晚到输出的引用/compact 副作用。
- 新增客户端纯函数测试覆盖默认、聊天关闭、全局关闭优先级、学习暂停、study 和其他 condition 隐藏。
- Playwright 在独立 `/tmp/memosync-memory-controls-qa-data` 数据目录、禁用 discovery 的本地实例上验证：新聊天开关、全局关闭 banner/Off 标记、Turn on、学习暂停 banner、Resume、已有聊天关闭及 reload 后持久化、聊天行图标。console 无 error/warning。已人工查看截图，无遮挡或溢出。
- UI 证据保存在 `output/playwright/`；最终测试、类型检查、构建及基线日志保存在 `output/memory-controls/`，均为 gitignored 本地产物。引擎调用以测试 fake 验证，未发送真实模型请求。

## 基线复核和限制

- 在独立 detached worktree 的 `81d2ed3` 上复核，复用依赖和已生成 dist。一次全量基线为 2101 pass / 4 skip / 1 fail / 1 error：`DiffStore > ignoreFile accepts a folder entry for an untracked diff` 超过 5000 ms，随后已清理临时目录引起 ENOENT。证据为 `output/memory-controls/base-bun-test.log`。本次最终全量运行无此失败。
- 开发中曾观察到取消记忆准备后后台任务访问已关闭数据库的非确定性失败。基础提交的独立 memory-gate 文件 158/158 通过，未复现同一错误，因此不将它定性为已证实的基线问题；最终整套测试通过。未修改这段不属于开关的取消流程。
- **并行任务依赖**：开关调用 `navigate("/settings/memory#memoryEnabled")`（`MemoryToggle.tsx:73`）。基础 Settings 页面尚未注册 memory 分区，其 `SettingsPage.tsx:871` 现有逻辑会重定向到 general。完整的定位效果需合并并行 Settings UI 后复核；依任务要求，本次未改动该页面。
- 关闭记忆沿用现有 proceed-without-memory 语义：禁止本回合的新注入、记忆工具和自动处理；保留引擎已有对话上下文，不清洗历史对话。

仅本地提交，不 push、部署或修改真实账号设置。
