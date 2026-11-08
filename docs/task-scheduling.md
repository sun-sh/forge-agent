# 多任务与执行进度 / Task scheduling and progress

Forge 的调度分为项目任务和父任务内的子 Agent；模型与工具回合始终由 Pi 执行。

## 项目任务

完成首轮对话后，在任务中心添加任务，或使用 `/queue 任务内容`。队列保存项目、Pi 会话文件、原始请求、模型、推理强度和 workflow；之后切换模型不会改写已排队任务。任务中心显示全部或当前项目、全局队列运行数、等待原因、停止、取消和明确重新排队。

队列最多同时执行 **3 个不同项目**。同一规范化真实目录及同一会话的任务按入队顺序执行；别名、junction 和 Windows 大小写差异不能绕过项目占用。一个忙碌项目保留自己的位置，其他项目继续准入。手动会话也受项目独占约束；3 是队列的并发上限，不是所有手动会话的全局配额。

运行前重新检查项目是否存在、信任、模型、会话模式和资源更新状态。所有权竞争只在实际执行前延后；已经开始的失败任务不会自动重放。项目消失导致该任务失败，不停止其他项目的调度。运行项的停止信号只传递给对应父会话及其子任务，清理结束后释放项目占用。

| 情况 | 处理 |
| --- | --- |
| 同一项目两个任务 | 按顺序执行，保护同一工作目录 |
| 三个不同项目 | 队列可同时运行 |
| 前面的项目被手动会话或终端占用 | 该项目等待，其他项目可以运行 |
| 停止一个运行项 | 只停止对应执行树，其他项目继续 |
| 服务异常退出 | 未开始的任务保留，已开始项恢复为中断，需明确重试 |
| 队列保存失败 | 停止新的准入，展示最后成功落盘状态和错误 |

## 父任务内协作

`subagent action=start` 立即返回句柄，父 Agent 可以继续独立工作；`wait` 最长等待 30 秒，`status` 查询，`result` 取回结果。Pi 的结束边界等待未取回结果并要求父 Agent 汇总；宿主再次确认结果取回状态。每个父用户请求最多 12 次激活、同时最多 3 个子任务，自动继续不会重置额度。停止父任务会停止并等待子任务。

worker 在独立 worktree 提出补丁，人工选择应用；“应用并验证”在同一项目占用下运行主项目配置的命令，无额外模型请求。没有验证配置时在写入前拒绝这项组合操作；仍可单独应用。验证失败保留应用内容和输出。权限、冲突与恢复边界见 [子 Agent 设计](subagents.md)。

## 重复操作和上下文

主任务的进度监测比较工具输入与实际结果的指纹。连续 6 次返回见过的相同证据时提醒调整策略，达到 12 次且仍未改变时停止，任务标为需要处理。检测覆盖内置读取/搜索、重复相同错误和成功但重复的 shell/写操作，也可识别小范围循环；新证据或阶段变化会重置连续计数，成功本身不清空历史。时间长本身不构成停滞。它没有语义进度判断或每次调用后的文件版本观察，合法重复可能误判；总预算仍约束其他情况。

对符合 Pi 1.4.0 结果格式的 `bash` / `powershell`，指纹忽略 `wall_time_seconds`，避免同一命令仅因耗时波动就被视为有进展。输出、退出码、截断状态及其他结构化字段仍参与比较；原始工具结果保持完整，其他工具的同名字段仍作为证据。

全局、项目和会话记忆有独立配额。显式约束和偏好优先，事实与决策按当前目标的中英文词项匹配召回；设置展开后展示选择原因。规划任务交接从持久化状态优先恢复结构化目标、完整约束与验收、文件范围和未解决问题，再加入阶段摘要与验证状态。自适应或旧记录使用明确标记的原始请求首尾节选，完整请求仍在任务记录中。长期记忆仍需用户接受候选，工具输出和模型摘要不会变成权限。

实现与回归：`src/task/queue.ts`、`src/task/progress.ts`、`src/task/context.ts`、`src/web/subagents.ts`，以及 `tests/task-queue.test.ts`、`tests/web-queue.test.ts`、`tests/web-progress.test.ts`、`tests/memory.test.ts`、`tests/web-subagents.test.ts`。

当前未提供跨机器调度、任意依赖 DAG、同目录多个主任务自动合并、子任务独立模型、向量检索或协作质量增益结论。运行和数据维护见 [operations](operations.md)。

## English overview

The durable queue runs up to three different projects concurrently, preserving admission order per canonical project and session. Frozen model/effort/workflow settings are revalidated against current trust and availability. Busy projects do not block unrelated work; cancellation targets one execution tree. Persistence precedes execution and visible transitions. Restart preserves unstarted jobs and interrupts started ones without replay.

Within a parent task, asynchronous child handles allow independent parent work. Pi's settlement boundary returns unread results for synthesis, and the host refuses completion if collection failed. Workers remain proposal-based; explicit apply-and-verify transfers the same project lease into configured host verification without a model request.

A bounded progress monitor warns after six repeated unchanged observations and stops after twelve; new evidence and phase transitions reset the consecutive count, while identical successful shell/write results do not erase history. It never infers a stall from duration alone and may misclassify legitimate repetition. Scoped lexical recall and structured task checkpoints prioritize complete constraints and acceptance through Pi compaction; unstructured adaptive/legacy requests have explicitly partial head/tail excerpts. These are inspectable host mechanisms, not evidence of improved model quality or a replacement agent loop.

For `bash` / `powershell` results matching Pi 1.4.0's shell contract, fingerprints exclude only `wall_time_seconds`. Output, exit code, truncation and other structured evidence remain significant. Raw results are unchanged; custom-tool duration fields are not normalized.
