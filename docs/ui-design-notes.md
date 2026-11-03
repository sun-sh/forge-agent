# 模型与工作模式界面记录

核对日期：2026-11-03。以下参考均为官方文档或项目官方仓库。本项目采用自己的页面实现，以 Pi 1.4.0 为运行时。

| 参考 | 已核对的设计 | 本项目应用 |
| --- | --- | --- |
| [Cursor Plan Mode](https://cursor.com/docs/agent/plan-mode) | 输入区模式下拉、Shift+Tab 切换、先调研出计划再执行 | 聊天框下方 Agent / Plan / Ask，Plan 不自动转执行 |
| [Claude Code 权限模式](https://code.claude.com/docs/en/permission-modes) | Plan 先研究与提出变更方案，再进入执行流程 | 模式需要约束实际行为。本项目采用更保守的内置读取/搜索工具白名单，Plan 不开放 shell 命令 |
| [CC Switch FetchedModelPicker](https://github.com/farion1231/cc-switch/blob/main/src/components/providers/forms/FetchedModelPicker.tsx) | 搜索模型、复选框选择、草稿集合、确认后批量应用，保留配置中已有 ID | 服务表单内可搜索的下拉多选，筛选不丢失选择；确认时保留已有参数和手填 ID |
| [CC Switch PiProviderForm](https://github.com/farion1231/cc-switch/blob/main/src/components/providers/forms/PiProviderForm.tsx) | 模型获取与服务配置配合使用，连接配置改变后使旧获取结果失效 | 改协议、URL、Key 后清除旧发现列表；获取与实际推理测试分开 |
| [Codex App 功能入口](https://developers.openai.com/codex/app/features) | 查询了官方功能页作为整体工作流参考 | 未复刻 Codex 的完整桌面功能，也不据此宣称能力对齐 |

页面职责：聊天框负责当次工作选择；设置负责连接、认证和可用模型管理。主流程保留项目、工作模式、模型与发送。模型与当前推理强度合并为一个入口，展开后搜索模型、选择模型支持的强度；主界面不再单列“思考：关闭”。

推理能力以 Pi 1.4.0 的 `getSupportedThinkingLevels` 和 `clampThinkingLevel` 为准。只有显式映射的 `xhigh/max` 才出现；被 `null` 禁用的档位不出现。没有模型、未启用推理、固定档位和可调档位分别说明，不显示一个打不开的假开关。强度选择会保存到 Pi 的每模型偏好；历史对话仍以自己的已保存强度为准。切换文本模型不会覆盖其他模型的偏好。

第三方服务保留列表中明确返回的能力信息；仅有名称时不推测能力。模型编辑中直接展示推理能力与档位。按完整 ID、协议匹配 Pi 目录提供可选模板，注明来源，由用户选择；相同模型在不同服务上可能支持不同档位。原有配置中保存的 `reasoning: false` 保持原意，可通过聊天模型菜单的“设置推理能力”直接打开对应模型修改。

配置保存期间锁定模型、强度、模式和发送，显示保存状态；失败时显示原因并保留草稿。当前会话的模型能力与强度以服务器快照为准。模型菜单支持搜索、键盘、Escape 关闭与焦点返回；窄屏使用同一入口并限制面板在视口内。

模式由服务器保存，不能从提示词或模型输出提高权限。Pi 仍负责运行循环、模型调用、工具、会话、资源与信任。只读约束作用于模型驱动的工具调用和 Web 命令分派；可信扩展自身仍拥有启动用户的操作系统权限。

验收使用独立 Pi home、临时项目和本地模拟模型，不向用户真实模型发起测试请求。自动检查包含只读工具执行、被阻止的写入/命令、验证跳过、Agent 验证失败、模式恢复与运行锁；浏览器验收包含批量选择、聊天模型切换、Plan 对话、刷新恢复及 390px 布局。
