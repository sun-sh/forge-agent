# 结构化任务交接：中文实现请求与真实模型格式失败

这是一次针对任务路由、交接与完成门禁的真实回归。模型为 DeepSeek V4.1 Flash，medium 推理强度，通过已配置的 OpenAI 兼容服务调用。原始配置、会话和输出保留本机，只发布[字段白名单汇总](deepseek-structured-handoff-2026-11-08.json)。它与[之前的实验](runtime-depth-2026-11-08.md)分别保留协议和代码指纹。

## 协议

使用 [sindresorhus/yocto-queue](https://github.com/sindresorhus/yocto-queue) 的固定提交 `72a8fa96a9d389765cdf2bb9c6daba8302fc375d`，要求惰性的 `drain(limit = Infinity)`、公开类型声明、错误参数验证、FIFO、undefined、提前关闭、空队列与队列后续操作兼容。中文题面从“请解决 Queue.drain 不能限制出队数量的问题”开始；当前提示规则返回 `undetermined`，不能靠扩充修改动词表直接绕过任务理解。

完整题面与末尾文件保护约束在 [中文 suite](../../evals/repositories/yocto-queue-bounded-drain.zh.json) 中。实现和声明可变；既有测试、package.json、readme 与用户 notes 不可变。每次使用临时 clone 和隔离 home；工作区外的[独立 oracle](../../evals/repositories/yocto-queue-bounded-drain.oracle.mjs)先确认基线失败，执行后再检查运行时和声明。配置验证、宿主完成、外部验收和保护文件分别判定。

## 首批：1/2，保留一次安全停止

自适应执行通过。规划执行在 inspect 停为 `needs_attention`：模型先输出调研发现，再输出一个完整、符合 schema 的 JSON brief；旧解析器只接受纯 JSON，因此没有进入实现。宿主没有宣称完成，错误完成数为 0。这是实际格式兼容缺陷，不能算成编码任务已成功，也不能删除该次失败。

解析器随后允许证据说明之后唯一的末尾 JSON，并继续拒绝多个对象、尾随文字指令、未知字段、超限或不符合 schema 的交接。没有为成功而放松验收或工具权限，也没有额外插入一次模型修复回合。回归验证歧义输入仍被拒绝，合法交接实际进入实现。

## 修复后：两个流程分别通过

| 流程 | 独立验收 / 保护 / 验证 / 宿主完成 | 准备 | Agent 执行 | 模型回合 | 累计 token |
| --- | --- | --- | --- | --- | --- |
| direct | 全部通过 | 75.4 s | 75.1 s | 7 | 57,826 |
| planned | 全部通过 | 56.8 s | 188.4 s | 21 | 384,369 |

规划流程将未知提示解析为 `change`，实际阶段为 inspect → plan → implement → verify → review → complete；结构化交接保留了 11 项验收，审阅恰好确认全部 11 项，宿主收尾成功。自适应继续由 Pi 决定模型/工具步骤，没有强加结构化规划或模型审阅。两个流程的外部判题均通过，错误完成数为 0。首批与修复后的 harness 指纹不同，不能合并宣称一个未变化协议的全通过率。

只有一个小仓库任务，每种流程每批一次；与本机其他验收并行，耗时只作描述。累计 token 包含缓存读取与重复输入；价格未配置，费用记未知。这个案例不能证明规划总体优于自适应、独立 reviewer 的收益、记忆增益或竞品表现，也没有强制触发真实模型压缩。完整性与阶段回归不能代替更大规模任务测量。

```sh
npm run eval:repo -- --suite evals/repositories/yocto-queue-bounded-drain.zh.json --prepare
npm run eval:repo -- --suite evals/repositories/yocto-queue-bounded-drain.zh.json --model provider/model --thinking medium --workflow both --trust-suite
```

`--prepare` 仅展示待审阅协议。确认可信后，`--trust-suite` 授权该 suite 的固定仓库、准备命令与判题代码；它们以启动用户权限运行。

## English overview

A Chinese request that the hint rules classify as `undetermined` exercised the same pinned public repository through adaptive and planned workflows. The first batch passed 1/2: planning safely stopped because a valid JSON brief followed evidence prose and the parser required pure JSON. That failure remains in the aggregate. After accepting one unambiguous final object while retaining schema and ambiguity checks, the new batch passed 2/2, including external runtime/declaration acceptance and protected-file integrity. Planning resolved to a change, executed every required phase and confirmed exactly 11 acceptance criteria. These are small runtime regressions with separate fingerprints, unknown cost and no competitor, independent-reviewer or memory-quality claim.
