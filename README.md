# Forge Agent

**在本机浏览器里读代码、规划和修改项目，用验证与审阅记录判断任务是否完成。**

简体中文 · [English](README.en.md)

[![CI](https://github.com/sun-sh/forge-agent/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/sun-sh/forge-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19.0-43853d)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Forge Agent 是一个以本机 Web 客户端为主要入口的 coding agent。它将项目、对话、模型选择、任务进度和 Git 差异放在同一个工作界面中，也提供可选的命令行入口。

项目基于 [Pi Coding Agent](https://github.com/earendil-works/pi) **1.4.0** 的完整运行时构建。我们在 Pi 会话之上实现任务编排、工作模式策略、验证门禁、Git 变更审阅和 Web 交互。当前版本为 **0.1.0，处于早期开发阶段**。

## 可以做什么

- **围绕项目工作**：按项目展开、搜索和恢复历史对话，保留草稿，查看文件变更与 diff。
- **选择工作方式**：Agent 执行修改；Plan 调研并规划；Ask 阅读代码并回答问题。项目、模式、模型和推理强度都在输入框下方选择。
- **接入自己的模型**：在设置中添加第三方服务，获取模型列表并批量勾选，也可以手填模型 ID，再通过实际调用测试连接。
- **连接外部工具**：在 MCP 设置中添加本机或 HTTP 服务、导入配置、完成浏览器 OAuth 授权，逐项控制工具，并查看各会话的连接状态。
- **让完成状态有依据**：复杂任务可使用“计划并执行”，逐步调研、规划、实现、验证和审阅；页面展示各阶段与验证证据。

## 快速启动

准备 Git、**Node.js >= 22.19.0**，以及一个可用的模型服务。远程服务通常需要 API Key；兼容的本机服务可以明确选择免 Key。

```bash
git clone https://github.com/sun-sh/forge-agent.git
cd forge-agent
npm ci
npm run build
npm start
```

`npm start` 会启动本机网关并自动打开默认浏览器，默认端口为 `4317`，正常使用无需复制启动链接或输入本机连接凭证。需要其他端口时使用 `npm start -- --port 4328`。目前从源码安装，尚未发布 npm 包或桌面安装包。

第一次使用：

1. 打开 **设置 → 服务 → 添加服务**，填写名称、Base URL、API 协议及 API Key，或明确选择本机免 Key。
2. 获取模型列表，在可搜索的下拉框中批量选择；没有列表接口时手动填写模型 ID。运行实际调用测试后保存服务。
3. 在输入框下方选择项目、模型和该模型支持的推理强度。服务保存与当前会话的模型切换是两个独立操作。
4. 检查项目内容及验证命令，再在项目设置中确认信任。需要验证门禁时，按下文配置 `forge-agent.json`。
5. 需要外部工具时，在 **设置 → MCP** 添加服务并测试连接；需要 OAuth 的 HTTP 服务可直接点击 **登录授权**。
6. 选择工作模式，描述任务并发送。复杂修改可在 Agent 模式中选择 **计划并执行**。

服务编辑器支持兼容 **OpenAI Chat Completions、OpenAI Responses、Anthropic Messages** 的接口；Ollama、LM Studio 等服务需要提供相应的兼容接口。模型能力以目录或手动配置为准，推理强度选项不会仅凭模型名称推断。

## 工作模式与执行流程

工作模式控制本轮允许使用的工具：

| 模式 | 用途 | 工具范围 |
| --- | --- | --- |
| **Agent** | 实现修改、运行命令与项目验证 | 按 Pi 配置和项目信任启用工具 |
| **Plan** | 阅读项目并制定计划 | 仅内置读取、搜索工具 |
| **Ask** | 理解代码、解释实现与回答问题 | 仅内置读取、搜索工具 |

Plan 和 Ask 会限制实际工具调用，阻止 shell、写入、MCP/自定义工具、斜杠命令分派和自动验证。模式随会话保存，运行期间不能切换。它们限制模型驱动的操作；可信扩展代码仍以启动者权限运行。

Agent 模式下可以选择两种执行流程：

- **直接对话**：使用 Pi 的交互循环完成日常问答和修改，并执行已配置的验证。
- **计划并执行**：由 Forge Agent 的任务控制器推进以下阶段，每次模型与工具执行仍交给 Pi。

```mermaid
flowchart LR
    Inspect[调研] --> Plan[规划]
    Plan --> Implement[实现]
    Implement --> Verify[验证]
    Verify --> Review[审阅]
    Review --> Complete[完成]
```

“计划并执行”的完成门禁要求：配置的验证通过、结构化审阅为 `ready` 且没有未解决问题，在可用的 Git 证据范围内未检测到审阅期间的变更。验证失败最多自动修复 `verifyRetries` 次；审阅发现问题、没有配置检查、审阅无效或证据失效时，任务会进入需要处理的状态。

停止任务会阻止后续阶段。服务重启后，未完成任务显示为中断，只有点击 **重新检查并继续** 才会重新调研当前工作区。模型审阅是第二次检查，仍可能遗漏问题。

## Agent 设计与实现边界

Forge Agent 将产品行为放在 Pi 会话之上，保留明确的职责边界：

| 层 | 职责与实现 |
| --- | --- |
| **任务控制器** | [src/task/controller.ts](src/task/controller.ts)：阶段转换、有限修复、停止/恢复、分支中的任务记录和完成门禁。 |
| **验证与证据** | [src/verification/](src/verification/) 与 [命令执行器](src/tools/command.ts)：保留原始输出、执行超时、终止子进程树、保存逐次报告。 |
| **工作模式策略** | [src/web/modes.ts](src/web/modes.ts)：通过 Pi 扩展约束实际工具调用，包括嵌套和动态工具调用。 |
| **Git 审阅** | [src/task/git.ts](src/task/git.ts)：暂存、未暂存与未跟踪变更，受限 diff 预览，任务开始前已有修改的标记与状态指纹。 |
| **MCP 管理** | [配置与授权](src/web/mcp.ts)、[运行时适配](src/web/mcp-runtime.ts) 和 [设置界面](src/web/ui/mcp.js)：全局/项目配置、连接测试、浏览器授权、工具规则与会话状态；协议和执行使用 Pi。 |
| **Web 产品层** | [src/web/](src/web/)：服务配置、项目会话、流式传输、重连恢复、草稿、任务与差异面板。 |
| **底层运行时** | Pi：Agent loop、模型调用与认证、工具、会话与压缩、项目信任、MCP、Skills、扩展和资源发现。 |

实现没有维护第二套 agent loop。CLI 委托 Pi 的入口，Web 通过 Pi SDK 创建会话；任务控制器负责阶段和判断，每个模型/工具回合仍由 Pi 执行。旧的自建原型保存在 `archive/prototype/`，不参与当前构建、测试或功能声明。

更多说明见 [架构与能力边界](docs/architecture.md) 和 [界面设计记录](docs/ui-design-notes.md)。

## 连接 MCP 服务

打开 **设置 → MCP → 添加**，选择本机 STDIO 或 Streamable HTTP，填写命令与参数，或 URL 与 Headers。也可以展开 **从 JSON 导入配置**，粘贴其他客户端使用的 `mcpServers` JSON，选择一个服务填入表单。命令参数每行填写一个，包含空格的路径保持在同一行。

先点击 **测试当前配置**，查看连接结果与可用的工具目录，再保存。若 HTTP 服务提示需要 OAuth，保存后点击 **登录授权**；浏览器批准后自动完成回调。弹窗被拦截时可以点击授权链接，也支持手动提交回调、取消和移除本机授权。MCP 授权与模型服务的 Provider 登录分别管理。

- **全局与项目**：全局配置保存在 `FORGE_AGENT_HOME/mcp.json`，项目配置保存在 `<project>/.pi/mcp.json`。项目配置仅在项目信任后加载。同名项目条目可以替换全局服务，也可以只覆盖启用状态和工具暴露方式，后者不会把全局凭据复制到项目。
- **连接测试**：使用临时 Pi 会话建立真实连接，显示最近结果和发现的工具；不请求模型，也不调用工具。测试会启动服务进程，结束后回收连接。该结果不代表每个聊天会话的实时连接状态。
- **配置生效**：保存、启停和删除会通过 Pi 重新加载受影响的空闲会话。任务运行时需要先停止，再修改配置；会话保留原有工作模式限制。
- **工具设置**：逐项设置工具的提供方式，也可以添加通配规则或恢复继承；已有 `toolExposure` 规则会保留。精确工具名优先于通配规则，多个通配规则按配置顺序匹配。Plan / Ask 始终阻止 MCP 工具执行。
- **会话连接状态**：展开后查看当前项目各会话实际加载的服务，每 3 秒更新连接状态与工具数量，并支持空闲会话重连。
- **凭据与编辑**：环境变量、Header 值和 OAuth Client Secret 保存后不会回显；留空保留已有值，移除对应行或勾选删除后清除。多窗口修改会检查冲突，OAuth 完成与状态刷新会保留正在编辑的草稿。

在服务卡片中打开 **工具设置**，按使用场景选择：

| 方式 | 适用场景与行为 |
| --- | --- |
| **Codemode**（默认） | Agent 通过脚本发现并组合调用工具，适合需要组合或筛选结果的任务。 |
| **Deferred** | 按需搜索后再向模型提供工具，适合工具较多的服务。 |
| **Direct** | 直接向模型提供工具，也可以从脚本调用，适合少量常用工具。 |
| **Hidden** | 隐藏工具，使其不可调用。 |

MCP 协议、传输、工具发现、执行和 OAuth 仍使用 Pi。网页授权完成后更新空闲会话；运行中的会话会在本轮结束后更新。凭据应放在环境变量、Headers 或 OAuth Secret 字段，避免直接写进命令参数或 URL；修改连接目标时需要重新填写保留的凭据。外部厂商的 OAuth 元数据、注册方式与代理环境仍需要实际兼容验收。详见 [MCP 管理设计](docs/mcp-management.md)。

## 配置项目验证

在目标项目根目录创建 `forge-agent.json`，也支持 `forge-agent.yaml` / `forge-agent.yml`。请将命令替换为该项目实际使用的检查：

```json
{
  "verify": [
    { "name": "typecheck", "command": "npm run typecheck", "timeoutMs": 120000 },
    { "name": "test", "command": "npm test", "timeoutMs": 300000 }
  ],
  "verifyRetries": 2
}
```

- 配置严格接受 `verify` 和 `verifyRetries`，未知字段会报错。[JSON Schema](forge-agent.schema.json) 描述了完整约束。
- 项目必须经过 Pi 信任，才会执行配置中的验证命令。
- 失败的原始命令输出会反馈给模型，最多进行 `verifyRetries` 次修复，内部自动继续不会重置预算。检查持续失败时，CLI 以非零状态退出。
- 超时和命令启动失败也会保存失败报告；停止时保留部分输出并结束后续检查和自动修复。新验证开始前会使旧的成功结果失效。
- 报告按工作区和运行记录保存到 `FORGE_AGENT_HOME/verification`，结果同时写入 Pi 会话分支。Web 可查看关联的验证与审阅记录。

## 其他入口

需要命令行时，在源码目录执行一次 `npm link`：

```bash
forge-agent web                            # 启动 Web 客户端
forge-agent                                # Pi 提供的交互式终端界面
forge-agent doctor                         # 检查本机配置，不显示凭据值
forge-agent check                          # 执行当前项目配置的验证
forge-agent -C path/to/project -p "Fix the failing tests"
```

Web 中的 API Key 配置覆盖常用兼容服务，MCP 有独立的设置入口。模型服务的 OAuth 登录仍使用终端中的 `/login`；Skills 和扩展的高级配置由 Pi 管理，Web 使用同一份本机配置。

## 验证与开发

| 命令 | 验证内容 |
| --- | --- |
| `npm run check` | 类型检查、活动回归测试、构建、CLI/bin 入口检查。 |
| `npm run test:web` | 通过真实 Chromium 浏览器和本地模拟服务验收模型配置、MCP 授权与工具设置、会话连接与恢复、任务进度、Git diff 和窄屏布局。 |
| `npm run eval:smoke` | 两道固定任务使用预设解答，通过真实 Pi 工具和工作流运行，再检查独立断言、文件修改与完成状态。 |
| `npm run eval:agent -- --model provider/model --workflow planned` | 使用已配置的真实模型运行同一任务集，会向对应服务发送任务内容并产生调用费用。 |

浏览器验收需要 Edge、Chrome 或 Chromium；也可通过 `FORGE_AGENT_TEST_BROWSER` 指定可执行文件。脚本使用临时项目、独立数据目录和浏览器配置。完整方法、输出路径与限制见 [评测说明](docs/evaluation.md)。修改完成状态、重试、信任、持久化或安全行为时，请补充回归测试，遵守 [AGENTS.md](AGENTS.md)。

## 本机数据与安全

| 内容 | 默认位置 |
| --- | --- |
| 配置、模型与认证 | `~/.forge-agent`，可通过 `FORGE_AGENT_HOME` 指定 |
| 全局 MCP 配置与 OAuth 凭据 | `FORGE_AGENT_HOME/mcp.json` 与 `FORGE_AGENT_HOME/mcp-auth.json` |
| 项目 MCP 配置 | `<project>/.pi/mcp.json`，仅在项目信任后加载 |
| 会话 | `FORGE_AGENT_HOME/sessions` |
| 验证证据与原始输出 | `FORGE_AGENT_HOME/verification` |
| 本机网关访问凭证 | `FORGE_AGENT_HOME/web/access-token` |

旧的 `PFORGE_HOME`、`~/.pforge` 与 `pforge.json/yaml/yml` 保持兼容；同目录中新的 `forge-agent.*` 配置优先。已有会话继续使用兼容的存储标识。

Web 网关默认绑定 `127.0.0.1`，使用本机访问凭证和 HttpOnly、SameSite=Strict Cookie，并检查 Host 与 Origin。模型 API Key 通过 Pi 认证接口保存，不会返回编辑器或写入浏览器存储。

“本机运行”指客户端、进程和数据存储的位置。使用远程模型时，相关内容仍会发送到你配置的服务。Agent、可信扩展与验证命令拥有启动者的操作系统权限，项目信任不构成 OS 沙箱；不可信项目请使用容器、虚拟机或受限账号。会话和原始日志可能含敏感内容，分享前需要检查。详见 [安全说明](SECURITY.md)。

## 当前范围与后续重点

当前适合本机使用、开发和早期反馈。Web 界面为中文，仍有以下工作：

- 完善模型服务高级配置和资源管理；部分 Provider 登录、Skills 与扩展配置目前依赖 Pi 的 TUI/配置。
- 补充会话归档、分支、导出、后台任务，以及文件引用和附件输入。
- 扩展到更复杂仓库的真实模型评测，比较直接执行与分阶段执行的成功率、时延和成本。
- 完善键盘可达性、安装升级与桌面分发。目前未发布 npm 包、GitHub Release 或桌面安装包。

完整现状与优先级见 [产品审计](docs/product-audit.md)。欢迎通过 [Issues](https://github.com/sun-sh/forge-agent/issues) 提交脱敏的复现问题，或围绕上述边界贡献改进。

## 许可与致谢

采用 [MIT License](LICENSE)。感谢 [Pi](https://github.com/earendil-works/pi) 提供 coding-agent 运行时，以及项目使用的开源依赖。
