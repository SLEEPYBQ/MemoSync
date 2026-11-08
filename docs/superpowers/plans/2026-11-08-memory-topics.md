# 自定义记忆主题实施计划

> 执行：subagent-driven-development；按存储、接口、界面、验证顺序实施。用户已指定以 MEMORY_TOPIC_ISSUE_PLAN.zh-CN.md 为准，在 issue-theme 分支直接操作。

**Goal:** 交付主 Issue 的自定义主题、组合筛选、单条和批量归类。

**Architecture:** 使用独立 memory_topics 表和 memories.topic_id；保留旧 topic 的检索与内容版本语义。分类不改正文、作用范围、状态、内容版本或更新时间；分类事件无内容快照，内容回滚保留当前分类。SQLite 导出包含目录、关联和分类历史。

**Tech Stack:** Bun SQLite、TypeScript、React、Zustand、现有中英文 i18n。

## 约定

- 名称 trim + Unicode NFC，重复键使用 toLowerCase；界面、接口、迁移共享函数。同名创建返回已有实体，改名碰撞返回冲突。
- 迁移仅在添加 topic_id 的事务内执行一次；保留原 topic。敏感及已拒绝条目的旧 topic 仅保留在原字段，避免将敏感正文相关信息扩散到全局目录。
- MemoryItem 新增 topicId?: string、topicName?: string；旧 topic 不变。新模型候选不自动加入用户目录。
- GET/POST /api/memories/topics 返回 MemoryTopic[] / MemoryTopic；PATCH/DELETE /api/memories/topics/:id 改名/删除；POST /api/memories/topics/assign 接收 {ids, topicId: string|null} 或 {ids, name: string}，逐条返回 {id, status: success|failed|unprocessed, error?}；结果包含 topicId。
- MemoryTopic = {id,name,count}。单条与批量共用接口，最多 500 条一批；前端分批处理全选结果，保留原目标以仅重试失败项。
- 分类前调用已有候选保护逻辑；拒绝或缺失条目不允许修改。主题删除解除关联且记录历史，不恢复任何记忆。

## 任务与验证

- [ ] 存储：先写 topics.test.ts，覆盖名称复用、空主题、重启、旧数据迁移幂等、敏感/拒绝保护、分类版本不变、删除和内容回滚兼容；运行 bun test src/server/memory/topics.test.ts 观察失败，然后实现。
- [ ] 接口：在 routes.ts 添加主题管理和归类路由，校验 JSON 字段及上限；列表支持 topicId 与既有条件组合。测试部分失败、重复请求和并发创建。
- [ ] 界面：可搜索主题选择器，明确创建动作；详情和共享候选卡片接入；看板主题管理、组合筛选、多选、当前结果全选、结果明细和失败重试；中英文文案。
- [ ] 历史：分类事件显示主题名称与前后值，无内容回滚按钮；SQLite 导出回读检查关联和空主题。
- [ ] 验证：bun test src/server/memory 与相关客户端测试；bun run check；按设计验收清单检查并独立审阅；修复后重跑相关验证。

不实施会话不学习、统计、自动分类、多标签、目录树、主题合并及批量接受/归档。
