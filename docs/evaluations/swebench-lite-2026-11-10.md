# SWE-bench Lite：迁移到评测机并运行

这套流程用于验证 Forge 在真实 Python 仓库 issue 上的表现。它使用固定数据快照、官方 SWE-bench harness，以及相互隔离的模型和判题容器。**目前已完成数据准备、控制器实现和本地夹具检查，还没有运行 Docker 集成、baseline/reference 或真实模型题目，不能据此宣称已有 SWE-bench 成绩。**

## 已固定的协议

- 数据集：[SWE-bench/SWE-bench_Lite](https://huggingface.co/datasets/SWE-bench/SWE-bench_Lite)，test split，300 题、12 个仓库；revision `b0dde1093fe417d83b7184254edf8199c1f0dff5`。
- 官方 harness：[SWE-bench/SWE-bench](https://github.com/SWE-bench/SWE-bench)，commit `02e7a74ffd0b707aab73d203fe87bdc7c76afc8e`。通过安装元数据检查 commit，并记录实际 Python 源码哈希。
- 20 题名单在 [lite-20.json](../../evals/swebench-lite/lite-20.json)。先按仓库分组，再按固定 seed 的实例 ID 哈希排序轮流选题，覆盖 12 个仓库；选题没有使用模型结果、gold patch 大小或隐藏测试结果。它是仓库覆盖样本，不代表完整 Lite 的随机代表样本。
- parquet SHA-256：`438e281d80587aa7be470896ce410557002fde02d2ceee3e099331d308f62dd3`。
- 可迁移 JSONL 使用 LF 换行，SHA-256：`a7cab520e244f8fd23028324f2710a659870336eba87c7fd6713843636bb49ca`；固定 pyarrow 26.0.1。最初 Windows CRLF 导出的不同哈希仅保留在本地诊断文件中，没有用来替换任何已发布模型成绩。
- 依照冻结名单导入后的 cohort fingerprint：`c3b09510c51d594ecd3d48e04b0ad69726187b043b7789a0b002f9dc85b44796`。
- 初轮三组各 20 次，共 60 次：`direct`、`planned`、`planned-no-review`，顺序交错；同模型、推理强度、预算和可见检查。若重复三轮，每题每组各占每个顺序一次，共 180 次。

## GitHub Actions 单题 Smoke

仓库提供 `swebench-smoke.yml` 手动工作流。它在 Ubuntu runner 中安装固定 harness，下载并校验 300 题数据，只导入 [smoke.json](../../evals/swebench-lite/smoke.json) 指定的一题，然后执行官方 baseline/gold、Forge 打包、无 Key 的合成模型回合和独立官方判题。它不代表模型编码质量；它只验证 Docker、官方 harness、镜像、Forge 补丁采集、保护文件和 false-completion 判定链路。

触发方式：GitHub 仓库 → Actions → `swebench-smoke` → `Run workflow`。输入必须是 `smoke.json` 中的实例 ID；默认是 `scikit-learn__scikit-learn-13584`。这个 workflow 不需要 Provider Secret，也不消耗 Codespaces。单题镜像和 pip 安装仍可能占用较长 runner 时间，运行失败时先下载 artifact，看是镜像、harness、Forge 运行还是官方判题哪一层失败。

只有 smoke 通过后，才应在另一台 Linux/Docker 机器运行完整 20 题 validation；GitHub Actions smoke 的成功不能写成 20 题 SWE-bench 分数。

## 评测机

使用 **Linux x86_64 + Linux Docker daemon + Node.js >=22.19 + Python 3.11 或兼容版本 + Git**。Windows 电脑先安装 WSL2/Ubuntu 和 Docker Desktop 的 WSL 集成，再在 Ubuntu 终端中运行以下命令。WSL 本身不等于 Docker 已就绪。建议把仓库放在 Linux 的 home 目录，而不是 `/mnt/c`。

**Windows 可以作为宿主机**，不需要把现有系统换成 Linux。官方 SWE-bench 提供 Windows + Docker Desktop + WSL2 的设置路径；本项目的 Python 控制器在 WSL2 Ubuntu 内运行，Docker Desktop 使用 WSL2 engine 并启用该发行版集成。它直接使用 Python Docker SDK，需要发行版内可用的 Docker Engine API；仅提供 Windows docker.exe 命令的模式不足以满足这一点。

如果机器未安装 WSL，先在 BIOS/UEFI 确认硬件虚拟化启用，再用管理员 PowerShell 安装 WSL 平台。需要重启时保存工作后手动完成，然后创建 Ubuntu。近期 WSL 支持 `--location`，可以将发行版存储放到空间更大的数据盘；Docker Desktop 镜像目录另行设置，移动 Ubuntu 的存储位置并不会自动移动 Docker 的镜像数据。不要因为 WSL 尚未安装就把环境标成“Windows 不支持”。

Codespaces 是备选的短时容器链路验收环境。启动前先在本地固定代码、下载清单和任务配置，核对机器磁盘/内存及账户剩余额度。GitHub 的包含用量按 core-hours 计，与一次会话的分钟数不同；以用户当前实际可用时长作为上限。持续的终端输出可算活动，不能依靠空闲超时限制整场实验；保存/下载结果后显式停止。有限云额度优先验收单个 baseline/gold/模型路径，不承诺在一小时内完成整组 60 次执行。

官方任务镜像体积较大，应先准备充足磁盘；20 题可能占用数十至数百 GB，实际取决于共享镜像层。控制器按顺序执行，当前不要求 GPU。镜像下载、首次构建和模型执行各自记录；不要把安装耗时当模型执行时间。

```bash
# 在源码根目录；也可以解压本轮提供的源码 kit 后进入该目录。
npm ci
python3 -m venv .venv-swebench
.venv-swebench/bin/python -m pip install -r evals/swebench-lite/harness-requirements.txt
npm run eval:swebench:doctor -- --python "$PWD/.venv-swebench/bin/python"
```

只有 doctor 的 `ready` 为 true 才进入真实任务。没有 Docker、harness 版本错误或架构不符时，命令返回非零，不会发送模型请求。

## 下载和准备固定名单

```bash
.venv-swebench/bin/python scripts/download-swebench-lite.py \
  --output .forge-agent/swebench-data

npm run eval:swebench:import -- \
  --dataset .forge-agent/swebench-data/test.jsonl \
  --cohort evals/swebench-lite/lite-20.json \
  --output .forge-agent/swebench-lite-20

node scripts/swebench-lite.mjs prepare --bundle .forge-agent/swebench-lite-20
```

下载器核对原始 parquet 和完整 JSONL 的哈希。导入器继续验证每条记录、base commit 和 manifest 指纹，拒绝未知实例、重复实例和篡改的 reference。每次运行要求新的输出目录，避免误用官方 harness 的旧日志缓存。原始数据、参考补丁和完整报告都在 `.forge-agent/` 中，默认不进入 Git。

## 先验证 20 题环境

```bash
npm run eval:swebench:validate -- \
  --python "$PWD/.venv-swebench/bin/python" \
  --bundle .forge-agent/swebench-lite-20 \
  --trust-suite --repeat 1 \
  --output .forge-agent/swebench-validation-01
```

每题拉取数据集指定的官方镜像，将内容 image ID/digest 固定下来，然后分别在**新容器**中运行原始代码和 gold patch。正式执行、补丁应用、日志解析和 `resolved` 判定复用官方 harness；适配层只替换容器创建策略，去掉 Python Lite 不需要的 `SYS_ADMIN`，不挂载宿主工作区或 Docker socket。此策略明确记录在协议里。

baseline 必须确实运行并观察到目标 F2P 失败、P2P 保持；缺测试结果、未解析日志、超时、镜像缺失都不能当成“baseline 正确失败”。gold 必须有完整的官方通过证据。无效题目保留原因；正式模型执行前按该 validation 文件跳过，不临时换成其他题，也不算进模型失败率。

`--trust-suite` 授权运行这些固定公开镜像和测试；它不是对恶意镜像的安全证明。Docker daemon 仍是有权限的本机资源，适合在专用评测机运行。

## 配置模型并做三组对照

在评测机本地创建独立的 Forge 配置目录，通过 Web 设置保存一个用于实测的 API-key 或显式免 key Provider。**不要把 Key 写在命令里、发到聊天里或提交到仓库。**当前评测容器暂不支持 OAuth 登录流程。模型地址需要从容器内可达；宿主的 `127.0.0.1` 通常不能直接当作容器内的模型服务地址。

例如先用 `FORGE_AGENT_HOME="$PWD/.forge-agent/eval-config" npm start` 打开设置，保存后停止该前台服务。然后运行：

```bash
npm run eval:swebench -- \
  --python "$PWD/.venv-swebench/bin/python" \
  --bundle .forge-agent/swebench-lite-20 \
  --validation .forge-agent/swebench-validation-01/cohort-validation.json \
  --config-home .forge-agent/eval-config \
  --model provider/model --thinking medium \
  --budget evals/swebench-lite/budget.json \
  --workflow ablation --repeat 1 --trust-suite \
  --output .forge-agent/swebench-run-01
```

把 `provider/model` 换成该机器实际保存的模型 key；不自动替换为其他模型。示例预算每次 30 分钟、160 模型回合、400 工具调用、200,000 输出 token，累计输入 token 不硬停，配置费用上限 50 美元。价格未知时费用记作未知；这个阈值不能替代服务商的账单限额。可以在首次实验前调整预算，确定后整批固定，报告记录实际预算。

模型在官方任务镜像派生的独立容器里运行原版 Forge/Pi。派生层只安装打包后的 Forge 和固定 Node 运行时，安装前后的包和 image ID 都记录下来。镜像构建不含 Key；运行时只把**选中 Provider**的解析配置放进临时私有目录，再复制到单次 worker；不复制其他 Provider、聊天、MCP、Skills 或项目记忆。

模型只收到 issue 描述和统一的评测规则，不接触 evaluator 里的 gold/test patch、F2P/P2P 清单、Docker socket 或宿主报告目录。网络仍用于模型/依赖流量；“禁止寻找 issue 解答”目前靠指令约束，不是出网隔离。公开 benchmark 也可能存在模型训练污染，不能宣称消除了污染。

默认可见验证只检查**改动 Python 文件的语法**，并保护已有测试和 Forge 配置。各仓库测试入口不一致，因此没有冒称一个通用 `pytest -q` 就能公平验证所有仓库；Agent 可自行运行相关已有测试。要提供额外可见检查，可在首次实验前设置 `--verify-command`，但整组必须相同并写入协议。可见检查不含隐藏验收，也不把隐藏测试失败送回模型修复。规划流程的独立审阅仍是原产品路径；关闭审阅只限实验开关。

## 独立验收和结果

结束后收集相对原始 base commit 的完整 Git patch，包含 staged、unstaged 和新文件。临时 Git index 不改变模型 index；即使模型提交了 commit，也不能因此漏掉变更。evaluator 内部配置不进入预测补丁。补丁然后进入另一个全新官方容器，官方 harness 应用 hidden tests、解析输出并给出 `resolved`。

输出同时保留官方 `resolved`、Forge 完成状态、保护文件违规、空补丁、错误完成、基础设施失败、耗时、回合、token、审阅次数和费用。**官方解决率与严格保护策略下的交付接受率分开**；这是一份声明过约束的 Lite 子集消融，不直接当作完整 Lite 或竞品榜单结果。“无关文件”不能只靠是否出现在 gold patch 中判断，因此当前不自动给出这种主观质量分。

容器/解析失败时，外部成绩和错误完成为未知，不能记作模型没做对；补丁确实无法应用则属于可观察的提交失败。官方日志、patch、snapshot 和每次失败都保留在本机，公开前需单独脱敏。

## 中断后继续评测

```bash
# 其他参数保持原样，使用新目录，并额外指定：
# --resume-from .forge-agent/swebench-run-01
# --output .forge-agent/swebench-run-02
```

恢复要求相同代码指纹、原包哈希、模型/Provider 配置哈希、budget、可见检查、validation、任务与顺序，并复用已固定的 Node/task image 身份。已经完成官方判定的**成功和失败都保留**，只重跑未结束和基础设施失败项。新报告带父运行引用和原尝试，避免挑选成功重跑。配置与原日志目录不要提前删除。永久磁盘失败或直接断电无法保证最后一条记录落盘，无法把中断时未保存的副作用当作成功。

## 当前证据边界

当前 Windows 本机已经复现 parquet → LF JSONL → 固定 20 题名单/指纹；前置检查明确记录缺少 Linux、Docker 和 harness，且模型调用数为 0。JavaScript 和 Python 回归使用合成记录/官方 API 夹具，覆盖数据篡改、版本绑定、解析失败、错误完成和恢复策略；这些不是 Docker 集成或模型能力结果。

仓库现在还提供手动的 `.github/workflows/swebench-real.yml`。它在 GitHub 的 Linux Docker runner 上默认选择冻结 Lite-20 中的 3 题和 1 条真实模型执行臂，先跑 baseline/gold validation，再收集官方 `resolved`、Forge `completed`、`accepted`、`falseCompletion` 和基础设施状态。现有 `swebench-smoke` 仍然是无 Key 的合成 Agent plumbing 检查，不能当作模型成绩。

运行真实工作流前，在仓库 Secrets 中配置 `FORGE_BENCHMARK_API_KEY` 和受信任的 `FORGE_BENCHMARK_BASE_URL`。工作流只把这两个值写入短生命周期的隔离 `models.json`，不上传配置文件或本机 Forge 凭据；真实评测结果上传为 artifact。先运行 `repeat=1` 的 `direct` 或 `planned`，审阅 resolution/completion 表后再扩大到其他执行臂或重复次数。

工作流在创建 Docker 任务前会使用相同的隔离 Provider 配置发送一个最小的 `Reply with exactly OK.` 请求，验证 Base URL、Key、协议和模型 ID。这个 preflight 会产生一次真实模型请求；失败会立即停止，避免先消耗三题容器时间。当前官方 DeepSeek 地址支持的模型 ID 以服务端返回为准，例如 `deepseek-flash`；聚合网关的模型 ID 不能直接套用到官方地址。

Git workspace evidence treats tracked symlinks and Git submodule entries as opaque metadata. It records the link target or gitlink object without entering the target repository; non-Git nested repositories and unsafe external links remain unconfirmed. This keeps protected-path and freshness checks strict while allowing large repositories with untouched submodules to reach independent grading.
