# 简体中文界面与语言设置实施报告

分支：`feat/i18n-zh`。改动保存在本地并按功能提交，未推送或发布。任务开始时工作区干净。

## 实现与架构

- 使用`i18next@25.10.10`和`react-i18next@16.6.6`。两套资源放在`src/client/i18n/en/`和`zh-CN/`，按12个区域拆分。`CustomTypeOptions`绑定英文资源结构并启用`strictKeyChecks`；`typecheck.ts`用`@ts-expect-error`验证未知key，即使带`defaultValue`也会被TypeScript拒绝。中文资源结构与英文对应，测试进一步核对所有key和插值变量。
- `AppSettingsSnapshot`与`AppSettingsPatch`增加`language: system | en | zh-CN`，默认`system`。沿`submitWhileRunning`的现有路径接入文件读取与标准化、序列化、快照、比较、patch合并、WebSocket回退设置和客户端合并。设置位于“通用→外观→语言”。语言选项固定显示各自名称：`System`、`English`、`简体中文`。
- `system`检查`navigator.languages`，任一语言以`zh`开头即解析为`zh-CN`，否则为`en`。启动时在React首次渲染前同步读取缓存并初始化，更新`<html lang>`；localStorage访问有try/catch。浏览器触发`languagechange`时，只有`system`偏好跟随变化。
- 切换走现有乐观更新及保存失败回读流程，无需刷新。页面、独立消息组件和导出查看器均订阅语言变化；模块级registry使用延迟getter，避免导入时固定语言。包含文案的memo会随locale更新。空状态打字效果、已保存的UI错误和操作回执也能更新语言；输入草稿和组件状态保留。
- JSX文本、属性、无障碍标签、菜单、设置描述与搜索词、快捷键名称、通知和错误均使用资源。数量使用i18next复数与整句插值；句内代码使用`Trans`，例如快捷键重置和本地启动命令。日期、相对时间、紧凑数字、百分比、文件大小和运行时长通过`Intl`使用应用locale，原始时间与时区不变。
- 服务端保留英文诊断回退，同时提供136种稳定UI文案代码及参数。另有4条独立预览错误页文案，由共享目录同时供客户端资源和打包后的服务端使用；独立页面按缓存或浏览器语言直接显示，无需加载主应用。HTTP错误保留原有`error`形状并增加`uiText`；WebSocket错误增加`uiText`，操作结果增加`uiTextFields`。工作记忆选择错误、迁移助手回退、审查漏标和选择调整回退分别携带可选代码；客户端只翻译对应固定UI字段。默认对话标题带元数据，用户或模型命名的标题保持原文。
- 用户/智能体消息、记忆内容、模型生成的解释与计划、文件内容、路径、代码、产品和模型名称、记忆ID及键盘键名保持原文。`render-context.tsx`没有改动；消息组件既有demo props API保持兼容。

实现参考：[i18next TypeScript](https://www.i18next.com/overview/typescript)、[react-i18next Trans](https://react.i18next.com/latest/trans-component)、[i18next复数](https://www.i18next.com/translation-function/plurals)。

## 资源数量

下表为每种语言的实际key数量；`_one`/`_other`分别计数，两种语言保留相同集合。

| Namespace | 每种语言的key数 |
|---|---:|
| `board` | 48 |
| `browser` | 18 |
| `chat` | 273 |
| `common` | 43 |
| `errors` | 146 |
| `export` | 4 |
| `files` | 47 |
| `git` | 83 |
| `memory` | 442 |
| `settings` | 185 |
| `sidebar` | 61 |
| `terminal` | 5 |
| **合计** | **1355** |

## 验证结果

| 验证 | 结果 |
|---|---|
| `bunx tsc --noEmit` | 通过，包含未知key的负向类型断言 |
| `bun test src/` | 1796通过、4跳过、0失败，共1800项、182个文件、7940次断言 |
| `bun run check` | 通过，主客户端与单文件导出查看器均构建成功 |
| 真实浏览器 | 42项检查全部通过，25张截图，0个未捕获浏览器错误 |
| `git diff --check` | 通过 |

Bun测试显式初始化为英文，继续验证真实英文文案。新增检查覆盖语言解析、配置标准化与持久化、客户端合并与回滚、资源key及插值一致性、复数和数字、服务端代码及参数、默认标题与用户标题的边界，以及中文下上传、拖放和图片结果协议值保持不变。

浏览器验证运行实际`bun run dev`，客户端5194端口、服务端5195端口，`HOME=/tmp/memosync-i18n-home-x52Dgg`。测试数据全部位于隔离目录，不调用模型。验证了从英文切到简体中文再切回、System匹配次选中文语言、显式语言忽略系统变化、页面重载后的持久化、首帧缓存语言、禁用localStorage时切换，以及独立挂载消息组件重渲染并保留输入状态。独立服务器预览失败HTML也验证了中文显示。真实导出HTML在拦截的测试域中离线加载，中文UI与原始英文对话内容均正确。

最初测试中发现并修复：缺失构建产物造成的应用壳503；Zustand初始化器误用React hook；英文连接处空格；内部协议字段、拖放类型及DOM属性误入文案提取；旧测试对新增服务端代码元数据的精确断言。最终结果以上表为准。

4项skip沿用仓库既有条件测试，未放宽或新增跳过条件。测试覆盖不等同于真实provider调用验证；本任务没有发起付费模型调用。

## 截图与布局

全部截图与机器可读检查结果在[`.codex-runs/i18n-shots/`](../.codex-runs/i18n-shots/)及[`verification.json`](../.codex-runs/i18n-shots/verification.json)。按任务约定，此目录被git忽略，图片保存在本地。

- 通用设置：[浅色](../.codex-runs/i18n-shots/settings-general-zh-light.png)、[深色](../.codex-runs/i18n-shots/settings-general-zh-dark.png)。
- 记忆设置：[浅色](../.codex-runs/i18n-shots/settings-memory-zh-light.png)、[深色](../.codex-runs/i18n-shots/settings-memory-zh-dark.png)。
- 记忆看板：[浅色](../.codex-runs/i18n-shots/memory-board-zh-light.png)、[深色](../.codex-runs/i18n-shots/memory-board-zh-dark.png)。
- 含记忆卡片的对话：[浅色](../.codex-runs/i18n-shots/chat-memory-cards-zh-light.png)、[深色](../.codex-runs/i18n-shots/chat-memory-cards-zh-dark.png)。
- 输入区：[浅色](../.codex-runs/i18n-shots/composer-zh-light.png)、[深色](../.codex-runs/i18n-shots/composer-zh-dark.png)。
- 侧栏：[浅色](../.codex-runs/i18n-shots/sidebar-zh-light.png)、[深色](../.codex-runs/i18n-shots/sidebar-zh-dark.png)。
- 记忆记录：[浅色](../.codex-runs/i18n-shots/memory-record-zh-light.png)、[深色](../.codex-runs/i18n-shots/memory-record-zh-dark.png)。
- [独立预览错误页](../.codex-runs/i18n-shots/preview-error-zh.png)、[中文离线导出查看器](../.codex-runs/i18n-shots/export-viewer-zh-dark.png)、[切回英文的通用设置](../.codex-runs/i18n-shots/settings-general-en.png)。
- 390×844窄屏：通用设置、记忆设置、看板和对话各有浅色/深色截图，文件名以`-mobile.png`结尾。

已人工查看代表性的桌面、窄屏、浅色、深色及导出截图。中文设置描述可换行，页面未出现横向溢出。侧栏相对时间最初被挤成两行，已通过为时间保留宽度及禁止换行修复；对话标题继续按既有方式省略。页面内文件名、代码及记忆内容的既有截断行为保留。

## 保留英文及原因

- 产品与模型名称：MemoSync、Claude Code、Codex、DeepSeek、GLM、Pi、Cursor、VS Code、GitHub CLI等；模型ID、`CLI`/`UI`等技术缩写保持原文。
- 语言选项`System`与`English`按要求始终使用自身语言；`简体中文`同理。
- 用户/智能体内容、记忆正文、模型输出、文件路径、命令、文件预览、记忆ID、键名、版本/轮次标记和测试fixture内容保持原文。截图中的“Example project”、英文记忆和英文回复即用于验证此边界。
- “记忆文件”展示实际生成的Markdown文件，所以文件内的`Personal Memories`、`Preferences`等原始标题也保持原样；文件外层UI已翻译。规范导出文件和模型输入协议不随界面语言改写。
- 原始异常、Git/CLI/provider输出、启动及网络诊断可以保留英文。HTTP状态正文（例如`Forbidden`、`Not found`）、日志、模型prompt、schema、SQL及导出协议保留原文。独立的HTML预览错误页已本地化。

[完整服务端英文保留清单](i18n-server-english.json)逐条列出源文件、行号、类别和完整字符串/模板，共1518条。这是一份刻意扩大范围的生产源码清单，包含非UI的模型prompt、SQL与协议文本，**不是1518条未翻译界面文案**。已进入UI文案代码目录的匹配项不再列入此清单；未知异常不会被泛化成一条中文错误而丢失细节。

| 保留类别 | 条数 | 原因 |
|---|---:|---|
| `server_internal_or_protocol` | 571 | 服务器内部数据与协议文本 |
| `raw_exception` | 274 | 原始异常详情 |
| `log_or_diagnostic` | 136 | 日志和排错信息 |
| `runtime_provider_or_diagnostic` | 327 | 运行环境、provider或CLI诊断 |
| `canonical_export_or_file_content` | 23 | 规范导出与文件原文 |
| `model_prompt_or_schema` | 187 | 模型指令与结构约束 |

## 最终术语表

| English | 中文 |
|---|---|
| Memory | 记忆 |
| Memory Board / Board | 记忆看板 / 看板 |
| memory candidate / candidates | 候选记忆 |
| Working Memory | 工作记忆 |
| Memory Preview | 记忆预览 |
| Memory Record | 记忆记录 |
| Transfer (suggestions) | 迁移（建议） |
| Bring in | 引入 |
| Checkup | 记忆检查 |
| Auditing memory use / audit | 记忆使用审查 / 审查 |
| trace | 使用记录 |
| Personal / Project / Session (scope) | 个人 / 项目 / 会话 |
| proposal / suggestion | 提议 / 建议 |
| Accept / Dismiss / Skip / Continue / Start | 接受 / 忽略 / 跳过 / 继续 / 开始 |
| Accept & replace | 接受并替换 |
| Archive / Restore / Delete | 归档 / 恢复 / 删除 |
| Muted proposals | 已静音的提议 |
| inject / injected | 注入 / 已注入 |
| enforce / enforced | 强制执行 / 已强制 |
| revision / replaces M-02 | 修订 / 替换 M-02 |
| sensitive | 敏感 |
| reinforce | 强化 |
| conflict | 冲突 |
| Use Memory | 使用记忆 |
| Learn From Chats | 从对话中学习 |
| Memory Changes: Ask First / Apply Automatically | 记忆变更：先询问 / 自动应用 |
| Memory off | 记忆已关闭 |
| Enter While Running: Queue / Steer | 运行时按 Enter：排队 / 立即插入 |
| agent | 智能体 |
| chat / conversation | 对话 |
| project | 项目 |
| Settings / General / Providers / Skills / Keybindings / Changelog | 设置 / 通用 / 模型提供方 / 技能 / 快捷键 / 更新日志 |
| Appearance / Theme / System / Light / Dark | 外观 / 主题 / 跟随系统 / 浅色 / 深色 |
| Notifications / System Notifications / Sound Effect | 通知 / 系统通知 / 提示音 |
| Plan mode | 规划模式 |
| Fork | 分叉 |
| Queue / queued | 排队 / 已排队 |
| Stop | 停止 |


补充术语：

| English | 中文 |
|---|---|
| review / reviewed | 审阅 / 已审阅 |
| Visible Memory Pool | 可见记忆池 |
| expected use | 预期用法 |
| scope | 范围 |
| constraint / preference / lesson / fact | 约束 / 偏好 / 经验 / 事实 |
| Redundancy / Staleness | 冗余 / 过期内容 |
| Encoder / Decoder | 编码器 / 解码器 |
| sanitized / redaction | 脱敏版本 / 脱敏 |
| Revert / Undo / Roll back | 还原 / 撤销 / 回滚 |
| Renewed | 已延期 |
| self-reported / audit-found | 自行报告 / 审查发现 |
| shaped this turn / no visible effect | 影响了本轮 / 无可见影响 |
| not applicable / violated | 不适用 / 已违反 |
| context window / context compacted | 上下文窗口 / 上下文已压缩 |
| Full Access / Fast Mode | 完全访问 / 快速模式 |
| Custom / Default | 自定义 / 默认 |
| file tree / inline preview | 文件树 / 内嵌预览 |
| branch / current branch / upstream | 分支 / 当前分支 / 上游 |
| Fetch / Pull / Push | 获取 / 拉取 / 推送 |
| Commit / commit message | 提交 / 提交信息 |
| Merge / Checkout | 合并 / 切换分支 |
| pull request | 拉取请求 |
| Discard changes | 放弃更改 |
| unified diff / side-by-side diff | 统一差异 / 并排差异 |
| scrollback / terminal pane | 回滚行数 / 终端窗格 |
| raw message / attachment | 原始消息 / 附件 |
| System (theme) | 跟随系统 |
| System (language option) | System |

## 复现与提交

```sh
# 使用新的隔离目录，不要指向真实应用HOME。
I18N_QA_HOME=$(mktemp -d /tmp/memosync-i18n-XXXXXX)
env HOME="$I18N_QA_HOME" I18N_QA_HOME="$I18N_QA_HOME" bun run scripts/seed-i18n-qa.ts
# 在独立终端保持dev运行：
env HOME="$I18N_QA_HOME" MEMOSYNC_QUICK_RESPONSE_OFFLINE=1 bun run dev --port 5194
# 另一个终端传入相同目录：
env I18N_QA_HOME="$I18N_QA_HOME" bun run scripts/verify-i18n.ts
bun run scripts/audit-i18n-server.ts docs/i18n-server-english.json
```

仓库已经有直接使用Playwright的截图/界面验证脚本，因此综合验证沿用该harness形式；同时使用Playwright CLI检查了真实页面与语言选项。Radix选项选择使用键盘Enter，避免最终复验中浏览器自动滚动等待导致的偶发超时。截图目录采用任务指定的`.codex-runs/i18n-shots/`。

为避免Vite在开发时把已构建的单文件导出查看器当成额外HTML入口扫描，`optimizeDeps.entries`限定为主`index.html`。这修复了验证时扫描导出产物中的可选依赖所产生的开发错误，不改变产品入口。

本地提交按基础设施、设置、记忆流程、对话与工作区、服务端文案、翻译及验证收尾拆分；未使用`git add -A`，未推送。
