# Task execution and acceptance results

[简体中文](#中文) · [English](#english)

## 中文

Forge 将“宿主执行流程已结束”与“用户需求已验收”分开。当前通用 `verify` 命令和独立模型审阅，都没有机器可核对的完整需求覆盖契约。因此无论 Direct 还是 Planned，代码实现结束后都只报告 **已实现 · 需求未验收**（`implemented_unverified`）。命令实际通过仍单独显示“配置检查通过”；模型审阅通过也单独列出，不升级为问题已解决。

### API 与兼容

会话 snapshot、`pforge_task` SSE 事件、任务列表和任务详情共同提供派生的 `task.result`：

```json
{
  "version": 1,
  "status": "implemented_unverified",
  "execution": "finished",
  "acceptance": "unverified",
  "resolutionClaimed": false,
  "checks": "passed",
  "modelReview": "passed"
}
```

- `status`：`in_progress`、`implemented_unverified`、`finished_unverified`、`not_applicable` 或 `blocked`。未观察到文件修改的自适应对话使用 `finished_unverified`；只读问答及纯检查使用 `not_applicable`，不会假称已实现代码。
- `checks`：`passed`、`not_configured`、`not_run`、`running`、`failed` 或 `unconfirmed`，继续要求当前工作区/规则证据与保护路径。
- `modelReview`：`passed`、`not_applicable`、`not_run`、`unconfirmed` 或 `changes_requested`。模型审阅是证据，不是外部行为验收。 该枚举和整个 `task.result` 由 `taskResultSchema` 在运行时用 Zod 严格校验；新增值必须同时更新 schema、消费方和回归测试，不能静默落入 fallback。 Planned-no-review 将其明确设置为 `not_applicable`，因此 UI 不会把“未启用审阅”渲染为审阅通过或绿色完成。
- 当前宿主不签发“需求已验收”证明，`resolutionClaimed` 为 `false`。不能由模型文字、HTTP 提交、命令名字如 `pytest`/`test`，或旧记录中的成功标记改成 `true`。这不是对模型正文里任意措辞的自动判定；身份提示也要求模型区分实现和验收，但不能保证所有模型文字遵守。

旧的 `task.status=completed`、`session.outcome=completed`、`phase=complete` 和队列 `status=completed` 保留为**调度/执行生命周期兼容字段**，仅表示该执行通过既有宿主门禁并结束，不能被接入方理解为 `resolved`。接入方应读取 `task.result` 判断交付声明，而不是把旧布尔值重命名为正确性。队列界面显示“队列执行结束”，会话、交付卡及任务中心使用未验收结果。

`result` 从当前任务与证据计算，不作为第二套状态存储；历史恢复、证据过期、保护失败和收尾异常都重新派生。旧 Pi 日志、任务 ID、重试额度、队列和继续行为不迁移，不因为“需求未验收”自动重新运行、卡住输入或制造额外 reviewer 调用。现有验证失败、保护变化、Planned 审阅阻断和持久化失败仍阻止正常结束。

### 评测不能靠换名字变好

SWE-bench 的新记录额外保存 `executionFinished`、`resultStatus`、`acceptanceStatus` 和 `resolutionClaimed`。原 `completed` 与 `falseCompletion` 为兼容仍保留，后者继续表示“宿主门禁已结束，但外部验收不接受的结果”，不会被 UI 标签改变：

- `resolved`/`accepted`：外部判题及完整性结果，保持原定义。
- `unresolvedFinishes`：宿主正常结束但官方未解决的次数；降低声明强度不会减少这个数。
- `resolutionClaims` / `assessedResolutionClaims`：显式声明已解决的数量/已获官方判题的声明数量。
- `falseResolutionClaimRate`：错误声明数除以已判题声明数；没有声明时为 `null`（不适用），不能写成“0% 错误，所以更可靠”。
- 旧记录缺少声明字段时保持未知，不追填 `false`，也不覆盖已经发布的原始测量。

`9/15` 通过与 `6/15` 未解决仍是同一事实。修改结果语义的收益是减少误导，不是提高编码质量。工程回归通过 fixture 与 API 验证语义；它不构成新的真实模型质量成绩。

以后若接入需求级行为验收，需要显式的验收条件、执行证据、工作区/测试版本绑定与覆盖/失败约束；当前不把任意测试命令、模型判断或关键词当作这个契约，也没有添加新配置键或暗中读取 SWE-bench 隐藏测试。

## English

Forge separates workflow settlement from requirement acceptance. Generic configured commands and an independent model review do not carry a host-verifiable contract covering every requested behavior. Both workflows therefore expose implemented-but-unverified delivery rather than certifying resolution. Configured-command and model-review evidence remain separate.

Session snapshots, task SSE events, task lists and details derive a versioned `task.result` with `status`, `execution`, `acceptance`, `checks`, `modelReview` and `resolutionClaimed`. A code change normally ends as `implemented_unverified`, with `execution=finished`, `acceptance=unverified` and `resolutionClaimed=false`. Read-only answers/checks are not labeled implementation. Running, blocked, stale, protection and finalization cases remain distinct. Derived fields are recomputed rather than persisted as another source of truth.

The existing `task.status=completed`, `session.outcome=completed`, `phase=complete` and completed queue jobs are legacy **execution/scheduler** fields, not `resolved`. Consumers must use `task.result` for product delivery claims. No existing history, retry allowance, queue scheduling or continuation is migrated. Unverified acceptance alone neither restarts work nor adds model calls; existing verification/protection/review gates remain in force.

The host currently makes no complete behavioral acceptance attestation. Neither model text, HTTP fields, a command named “test,” nor a saved model-ready verdict can upgrade that claim. The identity prompt requests the same distinction in generated answers, but the structured host field is not a guarantee that arbitrary model wording obeys it.

SWE-bench retains official resolution, integrity and workflow-finished quality metrics. The old `completed` and `falseCompletion` fields preserve their definitions and comparability; new records additionally separate finished execution from resolution claims. `unresolvedFinishes` continues counting finished-but-unresolved patches. Explicit claim errors are measured over assessed claims, with a **null rate when there are no claims**, rather than marketing abstention as 0% errors. Old measurements remain immutable and missing historical claim fields stay unknown.

A 9/15 resolution result with six unsuccessful patches remains 9/15 after changing labels. This change improves honesty of reporting, not measured coding quality. Deterministic regression/API tests are not a new real-model benchmark. A future behavioral-attestation contract would need explicit requirement coverage and workspace/test/evidence identities; no such contract is inferred from command keywords or generic model review here.
