# 运行、存储与升级 / Operations and upgrades

## 前台与后台

源码安装先执行 `npm ci` 和 `npm run build`。`npm start` 启动前台 Web 网关；关闭浏览器不会停止任务，关闭网关进程会停止执行。需要脱离启动终端时，先退出前台网关，再执行：

```bash
node dist/pi-cli.js service start
node dist/pi-cli.js service status
node dist/pi-cli.js service stop
```

使用 `npm link` 或安装 tarball 后，可把 `node dist/pi-cli.js` 替换为 `forge-agent`。启动支持 `--port 4317` 和 `--no-open`；后台进程不会注册为操作系统开机服务。一个 Forge home 只有一个 Web owner，不能同时运行前台与后台网关。

后台日志在 `FORGE_AGENT_HOME/web/service.log`，实例记录在 `web/service.json`。状态检查核对回环地址和健康接口的随机实例 ID；停止通过认证 API 完成，不根据保存的 PID 杀进程。日志不主动输出 Web token，但会话、工具输出和错误仍可能含项目敏感信息。

## 队列与中断

先完成会话第一轮，使 Pi 保存会话文件，再用 `/queue 任务内容` 排队。无参数的 `/queue` 打开任务中心。队列目前接受文本任务，固定排队时的项目、会话、模型、推理强度与流程；不会复制聊天框里的图片或其他附件。任务开始前重新检查模型可用性、会话状态和项目信任。

任务中心可直接添加任务，并显示运行数和等待原因。队列最多同时执行 3 个不同项目，同一真实项目及会话保持顺序；忙碌项目等待时，其他项目可以运行。运行项可以在任务中心或对应会话独立停止。浏览器关闭后继续运行；停止服务会停止活跃执行，保留未开始任务。重启时 `running` 转为 `interrupted`，不会自动重试；`queued` 在重新启动且可执行时继续。“重新排队”创建新记录，先检查当前状态；旧失败或取消记录保留。详见 [多任务调度](task-scheduling.md)。

队列最多保留 500 项元数据，待处理项最多 100 个。`tasks/queue.json` 不可读时拒绝启动并保留原文件；保存失败时停止队列准入并显示诊断。不要在网关运行时手工编辑该文件。

## 检查点与 worktree

模型阶段完成后，统一收尾服务还会封存检查点、恢复模式并确认任务索引写入。成功在这道边界前保持 pending；失败保留验证报告，同时将会话与任务标为失败。计数快照最多每秒合并一次，阶段、警告、停止和终态及时保存；进程突然退出可能丢失最后一个窗口内的用量。任务索引会跳过尚未执行的旧快照，并记录实际写次数和字节数。存储永久失败无法保证终态写入，必须先修复存储再检查已有文件，不能直接相信旧成功记录。这里没有 Pi 日志与索引之间的跨文件事务。

可信 Git 仓库根目录中的 Agent 执行会在开始前记录工作文件、HEAD 和暂存区指纹，收尾时封存。右侧“变更 → 执行检查点”展示按次执行的差异；撤销恢复执行前内容，保留已有脏改动和暂存内容，不执行 `git reset`。HEAD/暂存区变化、之后的文件修改或过期 revision 会阻止自动撤销。只会处理检查点收集范围内的文件；外部编辑与 Agent 编辑若同时发生，不能保证准确区分作者。

已知敏感路径、忽略文件、链接和超限文件不入快照；每次快照最多 1,500 个文件、32 MB，单文件 2 MB。未封存和写入中断的检查点不能自动恢复。恢复是逐文件、带落盘日志的操作，不是跨文件原子事务；中断后应检查已处理文件，再人工处理余项。

可写子 Agent 位于 `worktrees/<parent-id>/<child-id>`，只提供普通读取与编辑工具。修改先封存为 proposal，用户在右侧选择应用；它不会自动合并分支或运行 shell。应用前会核对主项目当前内容并建立新的撤销检查点；应用后请重新执行项目验证。清理独立目录保留 proposal 和子会话。

检查点和 worktree 目前没有全局容量回收。项目内容快照可能包含未识别的敏感数据，home 应视为私有数据目录。定期审阅和清理已停止任务的 worktree；清理快照前先备份，相关历史入口之后可能失效。检查点不能替代项目备份或 OS 隔离。

## 存储与兼容

| 内容 | `FORGE_AGENT_HOME` 下的位置 |
| --- | --- |
| 模型、凭据和 Pi 配置 | `models.json`、`auth.json`、`settings.json`、`mcp.json` 等 |
| Pi 会话与内部子会话 | `sessions/`、`subagents/` |
| 项目索引和本机授权 | `web/projects.json`、`web/access-token` |
| 任务索引和 FIFO | `tasks/index.json`、`tasks/queue.json` |
| 检查点内容与日志 | `checkpoints/<id>/manifest.json`、`objects/` |
| 可写子任务目录 | `worktrees/<parent-id>/<child-id>/` |
| 手工及已接受记忆 | `memory/` 和 Pi 会话自定义条目 |
| 待审阅记忆 | Pi 会话中的 `forge.memory-candidate` 条目 |

默认 home 为 `~/.forge-agent`；`PFORGE_HOME`、`~/.pforge`、旧配置名称和会话标识保持兼容。新队列、服务记录与检查点使用版本 1 schema；不会为了升级覆盖既有模型或凭据。分叉会话保留对话和已有参考记忆，但不继承原会话的子任务、检查点和待审阅候选所有权。

## 升级与发布

1. 停止前台或后台服务，检查队列中的未开始任务和未应用 proposal。
2. 备份 Forge home 和项目；备份含凭据，不要提交 Git 或公开分享。工作目录内的 Git worktree 还关联主仓库元数据，恢复时应一起核对。
3. 更新源码后执行 `npm ci`、`npm run check` 和 `npm run pack:check`，再启动服务。
4. 核对原模型、项目、历史和任务状态。回退版本前先停止队列；旧版本可能不展示新记录，不要据此删除数据。

`npm run pack:check` 生成 `.forge-agent/packages/forge-agent-<version>.tgz` 和 SHA-256，检查打包文件及解包后的 CLI；`--install` 验证实际 tarball 的全新依赖安装。tarball 可通过 `npm install -g /path/to/package.tgz` 安装。普通 CI 在 Windows/Ubuntu 和 Node 22/24 检查产品与包；`release.yml` 在手动触发或 `v*` tag 时额外检查全新安装。tag 与包版本一致且两平台通过后才创建 GitHub Release。配置这个流程不等于已发布 npm registry，也不包含桌面安装器。

## English

Build from source with `npm ci` and `npm run build`. `npm start` owns a foreground gateway. For a detached process, stop it first and run `node dist/pi-cli.js service start|status|stop` (or the installed `forge-agent` command). One home has one gateway owner. This is not an OS startup service. Status and stop validate the live loopback instance; they never kill an arbitrary saved PID.

After the first turn has persisted, add text tasks in the task center or use `/queue task text`. Model, effort and workflow are frozen. Up to three different projects run concurrently; each canonical project/session is serialized and rechecks trust and availability. Busy projects do not block others. Running jobs can be stopped independently. Browser closure does not stop execution. Restart preserves queued jobs and interrupts started ones. Explicit requeue inspects current state instead of replaying tools. Limits are 100 pending and 500 retained records. Invalid persistence is preserved and fails closed.

Host success stays pending until checkpoint sealing, mode restoration and task-index confirmation finish. Finalization errors preserve historical checks while failing the execution. Counters coalesce for up to one second; critical boundaries persist immediately and flush before completion. A crash can lose the last counter window. The index skips superseded pending snapshots and exposes write counts/bytes internally. Permanent storage faults cannot promise durable failure recording or a cross-file transaction.

Trusted Git roots support bounded working-file checkpoints and selected-file undo without resetting HEAD or the index. Dirty baseline content is preserved. Conflicts, stale revisions, HEAD/index changes, links and interrupted writes block unsafe recovery. Writes are journaled per file, not atomic across files. Snapshots exclude ignored/known sensitive paths, links and files over 2 MB, and are bounded to 1,500 files/32 MB. There is no global retention quota yet. Treat snapshots as private project data, not backups.

Writable children use detached worktrees and produce sealed proposals for explicit review and selective application. They cannot run shell or verify the project. Application checks current main-project content and creates an undo checkpoint; run project verification afterward. Removing the worktree preserves the proposal/transcript. Ordinary forks do not inherit ownership of children, checkpoints or pending memory.

Before upgrading, stop the gateway, inspect queued work and unapplied proposals, and privately back up the home and projects. Keep associated worktree Git metadata consistent. Update, install dependencies, run checks/package validation, restart and verify existing configuration/history. Stop the queue before downgrading; older versions may not understand new versioned records. Legacy home/config aliases remain supported and credentials are not replaced.

`pack:check` validates packaged assets and the CLI, creates a tarball and SHA-256, and accepts `--install` for a clean tarball installation. Install with `npm install -g /path/to/package.tgz`. CI checks Windows/Ubuntu and Node 22/24. The tag/manual release workflow additionally checks clean installs on both platforms; only a matching version tag creates a GitHub Release. No npm registry publication or desktop installer is implied.

Service status reads retry only transient OS sharing errors with bounded backoff (six attempts). Malformed records remain explicit failures and never authorize a PID-based kill. Service metadata uses atomic replacement; Windows verification cancellation launches process-tree termination asynchronously so the host can continue publishing state.

Integration test deadlines are separate from runtime limits: the dynamic MCP lifecycle case has a 60-second total budget; workspace-evidence end-to-end lifecycles allow 120 seconds for multiple bounded parent/check operations and Git/worktree setup. Their 45-second parent-run and 20-second verification waits remain unchanged. Working-mode tests keep 15 seconds for ordinary settlement and allow 30 seconds specifically for resumed implementation → verification → independent review → sealing, under a 60-second lifecycle budget; timeout diagnostics include the phase and active tools. This does not increase production task, model, transport or command limits.

### Updating a running Web service

Check for active user tasks before restarting the service. Navigating away or closing an SSE subscription does not cancel the running server task; same-project execution ownership remains exclusive. After a safe service update, reload the existing page so the client and gateway use the same build. Provider configuration and Pi history remain in the selected Forge data home. The current conversation qualification and its retained failures are documented in [conversation stability](evaluations/conversation-stability-2026-11-10.md), separate from real-model quality results.

### SWE-bench evaluation runtime

Run the [dedicated SWE-bench controller](evaluations/swebench-lite-2026-11-10.md) on Linux x86_64 with Docker, Python and the pinned official harness. WSL alone is insufficient. `npm run eval:swebench:doctor` refuses mismatched environments before model calls. Frozen datasets and raw evidence stay under `.forge-agent/`; only the selected API-key/keyless Provider crosses into a worker, never the evaluator's gold/tests or other credentials. Each experiment needs a new output directory; `--resume-from` binds reused results to code/package/cohort/validation/model/budget identity and retains assessed failures. Docker integration still requires qualification on the evaluation machine.

For local Windows evaluation, use WSL2 Ubuntu with the Docker Desktop WSL2 engine and distro integration; Windows remains the host. Verify firmware virtualization and the initial administrator/reboot steps before installation. Ubuntu storage and Docker image storage are separate locations. Codespaces is a fallback pilot environment: prepare artifacts first, respect the user's remaining core-hour/time budget, retain evidence and explicitly stop the codespace after the bounded pilot; ongoing terminal output can prevent idle shutdown.
