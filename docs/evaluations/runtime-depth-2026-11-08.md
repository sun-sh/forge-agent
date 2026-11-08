# 真实模型实测：执行闭环、路由缺陷与外部验收

模型为已配置的 DeepSeek V4.1 Flash，通过 OpenAI 兼容服务调用，推理强度 medium；Windows、Node.js 24.19.0、Pi 1.4.0。原始评测报告、父会话快照、变更和输出留在本机，公开的是[经过字段白名单审阅的汇总](deepseek-runtime-depth-2026-11-08.json)。各批 suite、oracle 和 harness 指纹分别保留。

## 范围与方法

- 五个公开小任务，每种流程一次，共十次。
- 一个固定第三方仓库任务，每种流程重复两次。首批发现宿主路由和判题环境缺陷；原始四次结果保留，修复后四次单独报告。
- 一个明确要求两名只读子 Agent 的协作集成案例，单独记录，不并入编码 benchmark。

每次执行使用临时项目和隔离 home，只复制模型/认证配置。检查独立断言、受保护文件、当前版本验证和宿主完成状态。宿主称完成但独立验收失败保留为错误完成；不会仅看模型的总结。价格没有配置，费用记为未知。累计 token 包含重复输入和缓存读取，不能当作上下文窗口大小。

## 五个小任务

任务定义见 [eval-tasks.mjs](../../scripts/eval-tasks.mjs)：clamp、端口严格解析、稳定去重、跨文件配置规范化、跨文件安全路径拼接。

| 流程 | 通过 / 执行 | 含准备的中位耗时 | 累计 token | 错误完成 |
| --- | --- | --- | --- | --- |
| direct | 5/5 | 38.8 s | 152,044 | 0 |
| planned | 5/5 | 52.4 s | 287,531 | 0 |

这是每个任务一次执行的观察，不是显著性检验。部分小任务与本机验收并行运行，耗时只作描述。规划需要额外阶段；本组数据支持继续保留默认自适应的产品选择，但不足以证明某个流程总体更快或更强。该组早于最后的 Extend 路由修复，版本由指纹区分。

## 第三方仓库：bounded lazy drain

仓库为 [sindresorhus/yocto-queue](https://github.com/sindresorhus/yocto-queue)，固定提交 `72a8fa96a9d389765cdf2bb9c6daba8302fc375d`。任务扩展 `drain(limit = Infinity)` 并更新声明，要求惰性出队、FIFO、undefined 值、提前关闭、非法参数校验、size/head/tail 保持和 TypeScript 调用兼容。

现有测试、package.json、README 和已有 notes 都受保护。可见检查运行上游测试；位于工作区外的 oracle 增加边界和声明调用验收。直接依赖版本固定，上游没有 lockfile，传递依赖解析仍有重现限制。

### 首批失败：先修验收，保留宿主缺陷

原始 runner 记录 **0/4**，四次均被记为错误完成。这些原始结果完整保留，不能作为四次有效模型质量失败来解释：

1. 两次 direct 已通过 oracle 的运行时断言，随后声明编译误读了过新的环境 Node 类型，旧 TypeScript 在 ffi.d.ts 报语法错误。它没有完成有效的声明验收。oracle 改用外部 tsconfig 的 `types: []` 排除无关环境类型；回归同时确认错误参数声明和错误出队行为仍会失败。
2. 两次 planned 暴露了真实宿主错误：`Extend … Run configured verification` 被归成 verify，宿主只运行了本来就通过的上游测试，未进入实施却报告结束。外部 `drain(0)` 断言拒绝了未修改的实现。修复增加扩展请求路由及阶段回归；它仍是有限规则，不是完整语义任务解析。

原始协议与修复协议指纹不同，分别呈现，不合并为一套未变化的胜率。相关回归见 [task-controller.test.ts](../../tests/task-controller.test.ts) 和 [repository-oracle.test.js](../../tests/repository-oracle.test.js)。

### 修复后复跑

| 流程 / 重复 | 独立验收与完成门禁 | 准备 | Agent 执行 | 模型回合 | 累计 token |
| --- | --- | --- | --- | --- | --- |
| direct / 1 | 通过 | 58.0 s | 73.5 s | 8 | 64,567 |
| planned / 1 | 通过 | 49.1 s | 154.6 s | 16 | 176,208 |
| direct / 2 | 通过 | 58.1 s | 135.9 s | 7 | 61,683 |
| planned / 2 | 通过 | 49.6 s | 94.2 s | 12 | 101,096 |

准备、执行与总耗时分别记录。固定源码的复跑用于验证修复后的任务链路，不能代表大型陌生仓库能力；部分运行与本机回归检查重叠，不作性能排名。预算为每次 60 分钟、150 回合、300 工具调用、5M 累计 token 和已配置价格下的 25 美元，实际账单不由未知价格推算。

## 明确委派的真实协作案例

两个文件分别给出 retries 与 port 规则：重试接受 0–8 的数值整数，其余回退到 4；端口只接受 1–65535 的纯十进制字符串，其余回退到 4317。要求父 Agent 一次 `action=start` 启动两名 explorer，各读一个策略；父读取源文件和测试，收回结论后实现 `parseSettings`，保留策略、可见测试和用户笔记。

结果：通过；观测到的子任务操作为 start → wait → wait。两个独立子生命周期有交叠且结果均已回收；父实现通过外部非法值、边界、前导零、不修改输入及文件保护断言，当前验证有效。含准备耗时 81.5 s，父子合计 15 回合、19 次工具调用、86,842 token。

这是显式要求协作的单场景，证明启动、独立会话、汇总和验收能连通；没有单 Agent 对照，不能证明自主委派策略或质量提升。子生命周期交叠也不是 provider 各请求并发度的测量。

## 可复现入口与下一步

先构建并用自己的模型配置运行；模型和推理强度保持一致。仓库 suite 需要先 `--prepare` 审阅，再明确 `--trust-suite`：

```sh
npm run eval:agent -- --model provider/model --thinking medium --workflow both
npm run eval:repo -- --suite evals/repositories/yocto-queue-bounded-drain.json --prepare
npm run eval:repo -- --suite evals/repositories/yocto-queue-bounded-drain.json --model provider/model --thinking medium --workflow both --repeat 2 --trust-suite
```

后续需要有 schema 的目标/验收交接、更大任务集、长程中断恢复、压缩后约束保留、独立 reviewer 和单/多 Agent 对照。尚未做 Claude Code、OpenHands、Goose 或 Codex 的公平竞品 benchmark。工程回归通过和这些小任务结果均不支持行业领先的结论。架构取舍见 [Architecture Deep Dive](../architecture-deep-dive.md)。

## English overview

Five small tasks passed 10/10 executions across adaptive and planned workflows. The initial repository batch exposed an Extend routing defect and an unrelated ambient-type oracle failure; its four raw failures remain separate. The corrected pinned-repository protocol passed 4/4 repeated executions. One explicitly requested two-child integration also ran with independent acceptance. These are small engineering regressions with no competitor baseline, statistical performance claim or measured multi-agent quality gain. See the aggregate for fingerprints, individual gates, usage, failures and limitations.
