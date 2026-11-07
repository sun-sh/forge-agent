# Forge Agent

**连接你选择的模型，在本机浏览器中理解代码、修改项目，并检查执行结果。**

简体中文 · [English](README.en.md)

[![CI](https://github.com/sun-sh/forge-agent/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/sun-sh/forge-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-43853d)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Forge Agent 是一个面向本机项目的开源 coding agent，以 Web 工作区为主要入口：左侧组织项目与会话，中间进行对话，右侧查看 Git 差异、项目文件和终端输出。你可以接入兼容的第三方或本机模型服务，管理 MCP、Skills 和分层记忆，也可以通过终端使用。

项目基于 [Pi Coding Agent](https://github.com/earendil-works/pi) **1.4.0** 的完整运行时构建。Forge 自己实现的重点是**任务编排、工具权限策略、验证门禁、可审阅的变更与记忆，以及后台执行和恢复**。当前版本为 **0.2.0**，适合本机开发和早期反馈；支持源码运行，并提供安装包校验和 GitHub tag 发布流程。

[快速启动](#快速启动) · [设计与职责](#设计与职责) · [使用指南](docs/usage.md) · [架构](docs/architecture.md) · [评测](docs/evaluation.md)

## 快速启动

准备 Git、**Node.js >= 22.19.0**，以及一个可用的模型服务。

```bash
git clone https://github.com/sun-sh/forge-agent.git
cd forge-agent
npm ci
npm run build
npm start
```

`npm start` 启动本机网关并自动打开默认浏览器，默认端口为 `4317`，正常启动会自动完成浏览器授权。需要其他端口时使用 `npm start -- --port 4328`。

1. 打开 **设置 → 服务 → 添加服务**，填写 Base URL、协议和 API Key；兼容的本机服务可以明确选择免 Key。获取模型列表后批量选择，或手填模型 ID，再测试实际调用并保存。
2. 在聊天框下方选择模型、推理强度和工作模式。首次使用不需要先选文件夹：直接发送第一条消息，Forge 会在 `FORGE_AGENT_HOME/projects` 下创建独立项目；也可以打开项目选择器，主动创建项目或打开电脑上的已有文件夹。
3. 描述任务并发送，例如：**“修复登录接口失败的测试，保留现有 API，并运行项目验证。”** 需要自动验证时，先配置下文的 `forge-agent.json`。点击发送按钮旁的回形针图标添加图片、代码或文本文件，也支持拖放和粘贴图片。

服务编辑器支持兼容 **OpenAI Chat Completions、OpenAI Responses、Anthropic Messages** 的接口。Ollama、LM Studio 等本机服务需提供相应兼容接口。推理强度按模型能力显示；运行中选择的新模型与强度在下一条消息生效。

Web 模型选择器只提供在 Forge 数据目录中保存凭据或配置的服务模型；启动进程继承的其他应用环境凭据不会自动添加模型。`models.json` 中主动配置的环境变量引用仍受支持。

## 工作区与能力

| 场景 | 当前支持 |
| --- | --- |
| **围绕项目工作** | Forge 项目目录和主动打开的本机目录统一出现在项目列表，支持移除并通过重新打开文件夹恢复；按项目组织会话，搜索、重命名、置顶、归档、回收站与恢复；编辑消息建立分支，导出 Markdown / JSON。 |
| **检查修改** | 右侧 Git diff、文件与终端；展开执行检查点查看本次修改，选择文件撤销，保留执行前的脏改动，冲突时拒绝覆盖。 |
| **提供上下文** | 引用项目文本文件；上传图片、UTF-8 文本或代码文件；管理全局/项目/会话参考记忆；输入框下方显示上下文与 Pi 压缩状态。 |
| **连接模型与工具** | 第三方服务配置、模型发现与批量选择；MCP 配置、连接测试、浏览器 OAuth 和工具设置；Skills 预览、启停与本机目录导入。 |
| **跟踪与恢复任务** | 阶段、验证输出、预算与持久化索引；`/queue` 将后续文本任务排队；独立本机后台进程可脱离启动终端运行，崩溃后不重放已开始的任务。 |
| **子 Agent 协作** | 探索、审阅和独立 worktree 内的实现；右侧审阅、选择并应用子任务修改，主项目冲突时拒绝合入。 |

文件引用和预览会检查路径、已知敏感文件名、符号链接及大小；图片还会检查格式和总量。它们是 Web 功能的访问边界，不能替代进程隔离。

### 工作模式

| 模式 | 行为 |
| --- | --- |
| **Agent** | 使用 Pi 的工具完成修改与执行；默认采用自适应流程。 |
| **Plan** | 只读调研并提出计划；由用户切换到 Agent 后实现。 |
| **Ask** | 只读理解代码和回答问题。 |

Plan / Ask 的限制落实到实际工具调用，包含动态或嵌套调用；允许内置读取与搜索，阻止写入、shell、MCP/自定义工具和自动项目验证。可信扩展代码仍拥有启动者权限。

### 执行流程

**自适应是默认流程**：Pi 执行模型与工具回合，模型按任务安排步骤，Forge 在配置了检查时执行验证门禁。

只有在 Agent 的二级菜单中手动选择 **规划并执行**，Forge 才会启用阶段控制。需要修改代码的任务按以下流程推进：

```mermaid
flowchart LR
    Inspect[调研] --> Plan[规划]
    Plan --> Implement[实现]
    Implement --> Verify[验证]
    Verify --> Review[审阅]
    Review --> Complete[完成]
    Verify -->|失败且有剩余修复次数| Implement
```

完成门禁要求配置的验证通过、结构化模型审阅为 `ready` 且没有遗留问题，并在可用的 Git 证据范围内未检测到审阅期间的变更。缺少检查、审阅无效或证据过期会进入需要处理的状态。问答和纯验证请求会走较短路径。

这是一种可检查的执行机制；额外规划与模型自审的收益仍需实测。验证修复次数和每次执行的时间、模型回合、工具调用、token 与费用预算都有上限，预算耗尽会进入可恢复的“达到执行预算”状态。

### 子 Agent

主 Agent 可以通过 `subagent` 一次委派最多 3 个独立任务。`explorer` / `reviewer` 只读，`worker` 在独立的 detached Git worktree 中使用读取、搜索、编辑与写入工具。worktree 以当前提交为基础，复制检查点范围内的已有工作区内容；子任务不能写入主项目、运行 shell、调用 MCP、加载外部扩展或继续委派。每个子任务继承委派时的模型与推理强度。

会话标题旁查看子任务状态、耗时和 token，右侧查看过程或单独停止。实现任务结束后，先在右侧查看文件差异，再明确选择应用到主项目；应用也会建立可撤销的检查点。相同文件发生后续修改时不会静默覆盖。子任务没有运行项目验证的权限，应用后应由主任务重新验证。只读子会话可以由主 Agent 续问；可写任务需新建委派。可清理独立工作目录并保留封存补丁与历史。尚未提供子任务独立模型和面板直接聊天。

### 检查点与后台运行

可信 Git 仓库根目录中的 Agent 执行会记录工作文件检查点。右侧 **变更 → 执行检查点** 可选择某次执行、预览文件并撤销所选修改。它恢复执行前内容，不重置 Git；HEAD 或暂存区变化、后续文件编辑和目录链接都会阻止不安全的撤销。忽略文件、已知敏感文件、链接和超限文件不进入快照；单次快照最多 1,500 个文件、32 MB，单文件最多 2 MB。

需要关闭启动终端后继续工作时，先停止前台服务，再运行：

```bash
node dist/pi-cli.js service start
node dist/pi-cli.js service status
node dist/pi-cli.js service stop
```

完成第一轮对话后，使用 **`/queue 任务内容`** 将后续文本任务加入持久化 FIFO 队列，任务中心可查看、取消、打开会话或明确重新排队。排队时固定模型、强度与执行流程；执行前重新检查项目信任和会话状态。浏览器关闭不影响运行；进程退出后，未开始的任务仍保留，已开始的任务标为中断，明确重试时先检查当前项目，不重放旧工具调用。后台进程目前不会注册为操作系统开机服务。详见 [运行、存储与升级](docs/operations.md)。

### 执行预算

Web 设置中的 **关于 → 执行预算** 控制每次 Agent 执行（包括自适应和规划并执行）的上限，默认是 15 分钟、50 个模型回合、300 次工具调用、750,000 个 token 和 25 美元。预算状态会随任务写入会话和任务索引；调整设置后可以重新检查失败或预算耗尽的任务。Provider 用量通常在一轮响应结束时才能取得，因此单轮响应可能略微超过阈值，不能把它当作账单级硬隔离。

子任务的回合、工具与模型用量同时计入父任务总预算；每次子任务激活额外限制为最多 3 分钟、12 个模型回合、60 次工具调用、120,000 token 和 2 美元，且不能超过父任务的对应上限。单次用户请求最多委派 12 次（包含对子任务的续问）。

## 设计与职责

Forge 在 Pi 会话之上实现产品与控制层，复用 Pi 的模型/工具循环，不重新实现一套运行时。

| Forge 实现 | 解决的问题 | 代码 |
| --- | --- | --- |
| **任务状态机与恢复** | 阶段转换、停止、有限修复、任务发现与中断后重新检查；Pi 会话保存对话与任务记录。 | [任务控制器](src/task/controller.ts)、[任务索引](src/task/registry.ts) |
| **子任务生命周期** | 独立 Pi 会话、受限工具、并行容量预留、父子预算、结果回收、停止联动及归属验证。 | [子 Agent 管理](src/web/subagents.ts)、[设计说明](docs/subagents.md) |
| **执行所有权与预算** | 同一 home 只允许一个 Web owner；同一项目的 Agent、终端和信任变更互斥；执行有时间、回合、工具、token 和费用边界。 | [Home 租约](src/task/registry.ts)、[项目执行](src/web/executions.ts)、[预算](src/task/budget.ts) |
| **验证与执行证据** | 保留原始失败输出、限制修复次数、执行超时、终止子进程树；失败不能作为成功完成。 | [验证扩展](src/verification/pi-extension.ts)、[命令执行器](src/tools/command.ts) |
| **工具权限策略** | 在运行时约束只读模式，防止仅隐藏界面入口而仍可执行工具。 | [模式策略](src/web/modes.ts) |
| **变更与上下文适配** | Git 证据、检查点、冲突检测、受控恢复；三层记忆、待审阅候选与来源。 | [检查点](src/task/checkpoints.ts)、[worktree](src/task/worktrees.ts)、[记忆](src/web/memory.ts) |
| **后台任务** | 独立进程、持久化 FIFO、排队时设置快照、崩溃后明确重试。 | [队列](src/task/queue.ts)、[后台服务](src/web/service.ts) |
| **Web 产品层** | 流式输出、事件重连、历史分支、模型/MCP/Skills 管理与执行结果展示。 | [Web 网关与界面](src/web/) |

**Pi 负责** Agent loop、模型调用与认证、内置工具、会话树、压缩、项目信任、MCP 协议与执行、Skills、扩展和资源发现。Forge 的 MCP 管理复用 Pi 的协议和授权能力，终端界面也由 Pi 提供。

记忆按作用域注入，项目身份使用规范化真实目录并兼容旧文件。模型可通过 `memory_proposal` 提出项目或会话记忆，**设置 → 记忆 → 待审阅记忆** 中接受后才生效；支持拒绝、去重、来源说明、显式替换及版本冲突检查。分支不继承原会话的待审阅候选所有权。自动压缩由 Pi 负责，尚未实现向量检索或证明记忆带来编码收益。旧原型位于 `archive/prototype/`，不属于当前构建或受支持能力。

## 配置验证

在目标项目根目录创建 `forge-agent.json`，也支持 YAML。将命令替换为项目实际使用的检查：

```json
{
  "verify": [
    { "name": "typecheck", "command": "npm run typecheck", "timeoutMs": 120000 },
    { "name": "test", "command": "npm test", "timeoutMs": 300000 }
  ],
  "verifyRetries": 2
}
```

配置只接受 `verify` 与 `verifyRetries`，未知字段会报错。项目必须经过 Pi 信任才会执行检查；失败原始输出会反馈模型，内部自动继续不会重置修复次数。持续失败时，CLI 以非零状态退出。验证结果写入 Pi 会话分支，原始输出和报告保存在 `FORGE_AGENT_HOME/verification`。

详见 [JSON Schema](forge-agent.schema.json)。需要终端入口时执行 `npm link`，再使用 `forge-agent`、`forge-agent check` 或 `forge-agent -p "任务"`。

## 开发与评测

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 类型、活动回归测试、构建和 CLI/bin 检查。 |
| `npm run test:web` | 在真实 Edge / Chrome / Chromium 中，使用本地模拟模型验收 Web 交互。 |
| `npm run eval:smoke` | 使用预设解答检查工具执行、工作流与评测链路。 |
| `npm run eval:agent -- --model provider/model --workflow direct` | 使用已配置的真实模型运行固定任务集；启动前会检查模型认证，并将模型目录与凭据复制到隔离评测 home。 |
| `npm run eval:agent -- --model provider/model --workflow planned` | 同一任务集走规划流程，用于与直接执行对照。 |
| `npm run eval:agent -- --model provider/model --workflow both --repeat 3` | 在固定模型设置下重复运行两种流程，比较通过率、耗时、修复、token 和费用。 |
| `npm run eval:repo -- --suite <suite.json> --prepare` | 检查固定仓库提交、判题脚本、准备及验证命令，不调用模型。 |
| `npm run eval:repo -- --suite <suite.json> --model provider/model --workflow both --repeat 3 --trust-suite` | 隔离克隆真实仓库，检查初始失败与修复后独立判题结果，记录错误完成率与执行用量。 |
| `npm run pack:check` | 校验安装包资产、凭据排除和解包后 CLI，并生成 tgz 与 SHA-256；`-- --install` 额外检查全新依赖安装。 |

评测使用隔离的临时 home 与工作区，只复制所选来源的模型和认证配置。小型公开任务适合快速回归；真实仓库评测要求固定提交与位于工作区外的独立 Node 判题脚本，并同时检查受保护文件、验证门禁和完成状态。报告记录 suite / oracle 指纹、模型、workflow、错误完成、耗时、预算、token 与费用。`--trust-suite` 表示已审阅并允许执行该套任务的仓库资源、准备命令和判题代码。回归、模拟模型和评测框架通过均不代表真实编码成绩；当前尚未发布复杂仓库真实模型对照结果。格式与示例见 [评测说明](docs/evaluation.md)。

## 当前边界

- **交付**：本机 Web 与可选终端，Web 目前为中文。提供可安装 tgz 的构建校验和 tag 发布流程；尚未发布到 npm registry，也没有桌面安装包。
- **执行**：一个 home 只有一个 Web owner。独立后台进程与前台共用同一套网关、项目锁和 Pi runtime；FIFO 队列暂按一个任务执行，不提供跨机器调度或进程内存级故障接续。
- **兼容性**：服务编辑器可选择流式文本测试或编码兼容测试，后者实际检查工具调用和结果回传。协议 fixture 与错误响应有回归覆盖，厂商 OAuth、企业代理及每个真实第三方服务仍需单独验收。
- **证据**：尚无公开复杂仓库真实模型成绩、记忆增益数据或行业排名。检查点和 worktree 是受控文件操作，不构成 OS 沙箱，也不能代替 Git 提交或备份。

已复现的问题、影响范围与验收要求记录在 [产品审查](docs/product-audit.md)。

## 数据与安全

数据默认保存在 `~/.forge-agent`，可用 `FORGE_AGENT_HOME` 指定；旧 `PFORGE_HOME`、`~/.pforge` 和 `pforge.json/yaml/yml` 保持兼容。Forge 不会把服务启动目录自动当成首个项目。

Forge 管理的新项目位于 `FORGE_AGENT_HOME/projects`，项目索引位于 `FORGE_AGENT_HOME/web/projects.json`。主动打开电脑上的外部文件夹时，Forge 只保存规范化路径并在原位置工作，不移动或复制项目；无项目发送首条消息时才会按需创建目录。所有 Pi 会话仍统一保存在 `FORGE_AGENT_HOME/sessions`，所以项目、会话和分支可以在本机统一管理。

Web 网关默认绑定 `127.0.0.1`，使用本机访问凭证、HttpOnly / SameSite Cookie 及 Host / Origin 检查。模型 Key 通过 Pi 认证 API 保存，不返回编辑器或写入浏览器存储。

本机运行指客户端和执行进程的位置；使用远程模型时，相关内容仍会发送到所选服务。Agent、MCP、可信扩展与验证命令拥有启动者的操作系统权限，项目信任不是 OS 沙箱。会话和日志可能包含敏感信息，分享前应检查。详见 [安全说明](SECURITY.md)。

## 文档与贡献

- [使用指南](docs/usage.md)：模式、命令、上下文、记忆、Skills、MCP、会话与本机数据。
- [架构与职责](docs/architecture.md)：Pi 与 Forge 的实现边界。
- [MCP 管理](docs/mcp-management.md) · [评测方法](docs/evaluation.md) · [产品审查](docs/product-audit.md)。
- [开发约定](AGENTS.md)：完成状态、重试、信任、持久化和安全变更须补回归测试。

欢迎在 [Issues](https://github.com/sun-sh/forge-agent/issues) 提交脱敏的复现步骤，或围绕上述范围贡献改进。

## 许可与致谢

[MIT License](LICENSE)。感谢 [Pi](https://github.com/earendil-works/pi) 及本项目使用的开源依赖。
