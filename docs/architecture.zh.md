# Forge Agent 架构总览

Forge Agent 是一个基于 Pi Coding Agent 1.4.0 的本机 coding agent。Pi 负责模型与工具回合、Provider、会话、上下文压缩、MCP、Skills 和资源发现；Forge 负责 Pi 上方的任务宿主层和 Web 产品。

项目的核心价值不是重写一个模型循环，而是让本机编码任务的执行、验证、完成判定、权限、持久化和中断恢复都能被检查。

## 总体结构

浏览器 Web UI
  → src/web/server.ts：本机网关、API、会话与执行生命周期
  → Pi AgentSession：模型/工具回合、会话、压缩、MCP、Skills
  → src/task/：任务状态、阶段、预算、队列、检查点、子任务
  → src/verification/：验证命令、工作区证据、保护路径门禁
  → src/web/ui/：聊天、设置、历史、工作区和任务视图

src/pi-cli.ts 是 CLI 入口，使用 Pi TUI 与 Forge 验证扩展。

## Forge 与 Pi 的边界

| 责任 | Pi | Forge |
| --- | --- | --- |
| 模型请求和流式响应 | 负责 | 适配 Web 状态 |
| 工具分发和 Agent loop | 负责 | 通过模式策略限制工具暴露 |
| Provider、认证和模型目录 | 负责 | 提供第三方服务配置界面 |
| 会话树、压缩和历史 | 负责 | 按项目组织会话并提供浏览器视图 |
| MCP、Skills、扩展和资源发现 | 负责 | 提供 Web 管理和产品边界 |
| 任务阶段和恢复 | 不负责 | 负责 |
| 验证、保护路径和完成门禁 | 不负责 | 负责 |
| 队列、项目占用和子任务 | 不负责 | 负责 |

Forge 不是 Pi 的替代品，也不是另一个独立 runtime。它是一个围绕成熟 Agent runtime 构建的任务控制和交付产品层。

## 主要源码目录

| 路径 | 职责 |
| --- | --- |
| src/pi-cli.ts | CLI 入口，接入 Pi TUI、身份和验证扩展 |
| src/web/server.ts | 本机 Web 网关、API、会话创建和执行生命周期 |
| src/web/ui/ | 浏览器客户端：聊天、历史、设置、项目、工作区和任务进度 |
| src/task/controller.ts | Planned 任务状态机：Inspect → Plan → Implement → Verify → Review |
| src/task/ | 任务状态、预算、队列、持久化、上下文、检查点、时间线和子 Agent |
| src/verification/ | 验证命令、工作区版本证据、受保护路径和信任约束 |
| src/tools/command.ts | 验证与本机终端共用的有界命令执行器 |
| src/web/providers.ts | 第三方模型服务和模型配置适配 |
| src/web/memory.ts | 全局、项目、会话记忆和用户审阅候选 |
| src/web/mcp.ts | MCP 配置、探测、OAuth 和生命周期适配 |

## 两种执行路径

### Agent 自适应执行

这是默认路径。Forge 创建任务封套并记录预算、工具活动、文件产物和当前状态；Pi 在其中继续执行原生模型/工具回合。它适合普通编码任务和问答，不额外强制 Planner 或 reviewer。

### Planned 规划并执行

只有用户明确选择时才启用：

Inspect → Plan → Implement → Verify → Review → Complete / Needs attention

Forge 控制阶段转换和证据门禁，Pi 仍然执行每一次模型与工具回合。Planned 和独立 reviewer 目前是实验能力，真实评测尚未证明它们普遍提高编码交付质量。

## 完成判定

Forge 将以下状态分开处理：

1. 模型回合是否结束。
2. 配置的验证命令是否通过。
3. 工作区和保护路径是否仍与当前证据一致。
4. 独立 reviewer 是否返回结构化结果。
5. 是否仍有未应用的子任务提案或收尾错误。

因此“模型说完成”不能直接变成“需求已解决”。当前产品会保留历史验证结果，并在工作区变化后将其标为过期或未确认。

## 进一步阅读

- 架构深读：architecture-deep-dive.md
- 结果语义：task-results.md 的中文章节
- 使用指南：usage.md
- English architecture map：architecture.md
