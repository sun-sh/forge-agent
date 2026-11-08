# 执行记录 / Execution records

Forge 复用 Pi 的分支日志作为模型与工具事件来源，不维护另一套对话历史。本协议提供版本化的只读投影，不调度或重新执行动作。职责与取舍见 [Architecture Deep Dive](architecture-deep-dive.md)。

## 来源与身份

已打开会话的认证接口：`GET /api/sessions/{id}/timeline?task={taskId}`。省略 task 时返回当前分支最近的任务。其他分支或不存在的任务返回 404；协议没有 POST、Replay 或执行入口。

响应包含 `timeline.version: 1`、`taskId`、`readOnly: true`、`nodes`、`edges` 与 `truncated`。节点类型为 task、phase、model、tool、check；边为 contains、next、retry。ID 派生自任务 UUID、阶段序号、Pi message entry ID、toolCallId 或检查的 evidence ID。重复阶段与跨任务重复 toolCallId 不会混为一次调用。

阶段归属根据日志中的宿主快照位置决定，不按时间戳猜测。后续任务的工具结果不能填补前一任务的未完成调用。模型 token 来自实际 Pi usage；检查结果、时长和版本 freshness 来自宿主报告。投影不返回私有思考、原始工具参数/输出、原始检查命令或完整用户请求。检查名称仍是项目配置的显示数据。

## 状态与时间

没有工具结果的调用仅在当前执行仍活跃时显示 running，其他情况显示 interrupted，即使父任务曾声称完成也不推定成功。检查历史状态与 freshness 分开：曾通过的命令可以在当前版本 stale。失败的检查尝试与后续修复检查保留各自节点。

宿主阶段和检查使用实际记录的时间；工具时长标为 `message_interval`，是模型工具调用消息到结果消息的间隔，包含排队和等待，不能当作精确工具执行延迟。没有模型耗时数据时不编造。元数据更新不会把一次执行时长延长到后续检查证据失效的时刻。

最多展示 1,600 个节点，超限时设置 `truncated` 并提示查看原始会话导出。右侧工作区的“执行”标签按需获取并按阶段展开，异步响应须匹配当前会话与任务。关闭面板不影响任务。

## 任务交接与收尾

version 1 任务封套中的 `brief`、`plan`、`intentHint` 与 `finalization` 为可选字段，兼容旧记录。用户 `mode` 决定工具策略；路由提示与模型任务理解不能提高权限。inspect 保存完整目标、约束、验收和未解决问题；计划保留这些要求，审阅精确覆盖宿主分配的验收 ID。JSON 格式验证不等于模型语义已经正确。

交接接受纯 JSON、围栏 JSON，或证据说明之后唯一的末尾 JSON 对象；多个对象、尾随指令、未知控制字段、无效 schema 或超限内容均拒绝。真实模型曾输出“调研发现 + 合法 JSON”，旧解析器将其拒绝为需要处理；该次失败保留在评测中，格式兼容修复有独立回归。

“应用并验证”等明确的宿主动作直接携带 verify 意图，不再从按钮生成的描述文字推断；HTTP 用户提示与模型输出不能指定这个内部字段。只读模式的结束文案依据该次执行的权限模式，不会因未知意图而暗示已经实施。

模型阶段结束时仍需收尾，公开/落盘状态保持 running + finalization pending，直到封存、模式恢复与保存确认结束。finalization succeeded 表示宿主收尾结束，任务本身仍可能 failed / needs_attention；finalization failed 明确标记收尾异常。永久磁盘故障不承诺成功保存失败记录。队列消费同一最终任务结果。

高频计数在活动状态即时更新，持久化最多每秒合并一次；关键转换和最终 flush 保留最新值。索引暴露 `persistenceStats` 内部计数供实验统计；真实长任务性能仍待固定条件测量。

源码：[投影](../src/task/timeline.ts)、[验收协议](../src/task/plan.ts)、[收尾服务](../src/task/lifecycle.ts)。回归：[历史与中断](../tests/task-timeline.test.ts)、[收尾故障](../tests/task-lifecycle.test.ts)、[Web 封存故障](../tests/web-evidence.test.ts)、[界面与过期响应](../tests/web-ui.test.js)。

## English overview

The authenticated timeline endpoint projects a version-1 read-only graph from the active Pi branch and host snapshots. Stable task/phase/message/tool/check identities connect containment, phase progression and retries. Missing tool results remain running or interrupted; later executions cannot satisfy earlier calls. Check freshness is separate from historical command success. Tool duration is a message-interval estimate, not precise execution latency. Raw reasoning, tool inputs/outputs and commands are excluded; a 1,600-node limit is explicit.

Structured understanding, preserved acceptance IDs and shared host finalization sit above Pi. Success stays pending until host cleanup and persistence finish. Counter writes are coalesced, critical boundaries flush, and permanent storage faults remain visible. This graph does not authorize actions, replay side effects or promise arbitrary-node recovery.
