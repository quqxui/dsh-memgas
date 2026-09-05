# dsh-memgas

> **状态：路线图 M0–M5 的功能已全部实现（2026-09-05）**，233 个测试覆盖，并在真实 dsh 中验证过加载。尚未发布到 npm，`memgas-mcp` 与其他 agent 的互通尚未实测。英文版 README 在首个发布版本前补齐。

## 开发

```sh
pnpm install
pnpm test        # vitest，233 个测试
pnpm run build   # tsc -b，同时做类型检查
```

### 在真实 dsh 里验证

```sh
pnpm run build
npm i @deepseek-ai/dsh          # 在任意空目录
cat > overlay.yml <<'YML'
- insert:
    - id: memgas
      name: '<仓库绝对路径>/packages/dsh-plugin/lib/index.js'
      config:
        dataDir: '/tmp/memgas-data'
YML
DSH_HOME=/tmp/dshhome npx dsh --profile headless --patch "$PWD/overlay.yml" "记住：本项目用 pnpm"
```

已验证到的程度（2026-09-05，dsh 0.1.2-rc.1）：overlay 层被解析、插件挂载并注入 `tools` / `systemPrompt` / `llm` / `commands` 四个服务、`apply` 执行、按作用域建出 SQLite 文件，dsh 启动一路走到模型请求。再往后需要 `DEEPSEEK_API_KEY`，模型实际调用工具、真实会话被收割、pre-step 注入、演化过程这几条链路只在假 ctx 下测过，没有在真实 dsh 里跑过。

**dsh-memgas** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的长期记忆插件，把 **记忆存储 → 演化 → 检索利用** 做成一个闭环。多粒度关联与自适应选择的思路来自 ICLR 2026 论文 *From Single to Multi-Granularity: Toward Long-Term Memory Association and Selection of Conversational Agents*（MemGAS）。

一句话：让 dsh 里的 agent 跨会话记住你和你的项目，记忆随使用不断整理、更新、遗忘，并在每次需要时用最稳的方式取回。

## 目录

- [为什么再做一个记忆插件](#为什么再做一个记忆插件)
- [设计原则](#设计原则)
- [核心概念](#核心概念)
- [系统架构](#系统架构)
- [记忆生命周期](#记忆生命周期)
  - [存储](#存储store)
  - [演化](#演化evolve)
  - [检索](#检索recall)
  - [利用](#利用use)
- [Embedder](#embedder)
- [提示词策略](#提示词策略)
- [可观测与自评](#可观测与自评)
- [memgas-mcp](#memgas-mcp)
- [配置草案](#配置草案)
- [隐私与安全](#隐私与安全)
- [仓库结构](#仓库结构)
- [路线图](#路线图)
- [决策记录](#决策记录)
- [未决问题](#未决问题)
- [引用](#引用)

## 为什么再做一个记忆插件

dsh 生态里已经有几十个记忆插件和若干 MCP 记忆服务。它们的检索层几乎全部是单通道：要么整段会话做向量检索，要么 FTS 全文匹配，要么抽三元组进图谱。单一通道的问题很具体：向量检索在稀有 token（文件路径、包名、报错码）上召不回，全文检索在换个说法问同一件事时召不回，图谱在关系没建对时把噪声传播得更远。

dsh-memgas 的差异化在三点：

1. **多通道检索加融合**：词法、稠密向量、多粒度、图扩展四条通道并行跑，用排名融合合并，任一通道退化不影响整体。多粒度关联与熵路由是其中的增强项，不是唯一路径。
2. **演化闭环**：记忆不是只写不改的日志。新证据会更新旧事实、合并重复、强化常用关联、衰减无人问津的条目、把零散记忆抽象成更高层的画像与约定。
3. **原生集成**：作为 dsh 插件运行在宿主进程里，直接监听会话事件自动收割记忆、复用宿主已配置的模型做摘要、在轮次开始前主动注入。MCP 方案拿不到这些接口，只能被动等模型调用工具。

同时提供 `memgas-mcp`，让 Claude Code、Codex 等其他 agent 共用同一个记忆库。

## 设计原则

三条硬约束贯穿全部设计：

1. **可降级**：每个高级机制失效时，系统退回一条不依赖它的普通路径，而不是崩溃或返回空结果。冷启动、模型没下载完、图太稀疏、LLM 不可用，都必须还能用。
2. **单调不劣化**：高级机制只能补充候选或重排结果，不能把基线检索已经找到的条目挤出最终结果集。最坏情况下的检索质量等于基线检索质量。
3. **可配置、可观测**：每条增强通道都有独立开关、权重与超时；每条被取回的记忆都能说清来自哪条通道、什么分数。默认配置是工程判断，用户可以按自己的场景调整。

配套的工程约束：所有 LLM 输出严格 JSON 加 schema 校验，畸形输出不入库；演化不做物理删除，更新走版本链、遗忘走归档；LLM 调用集中在后台任务，不进入轮次关键路径。

## 核心概念

以下概念来自论文，括号内是本插件里的对应实现。它们构成检索的**增强通道**，与两条基线通道并行工作。

- **多粒度记忆单元（Multi-Granularity Memory Unit）**：每段对话产生四个粒度的记忆：session（整段会话）、turn（单轮 user+assistant）、summary（LLM 生成的摘要）、keyword（LLM 抽取的关键词/实体）。四者独立向量化、独立成为图节点。（`MemoryUnit.granularity`）
- **记忆关联（Memory Association）**：新记忆入库时，计算它与历史记忆在各粒度上的相似度向量，用 Gaussian Mixture Model 把历史记忆分成 accept 集和 reject 集，accept 集与新记忆建边，形成关联图。（`Evolve.associate`，`AssociationGraph`）
- **熵路由（Entropy-Driven Granularity Router）**：对一个 query，在每个粒度上算相似度分布的 Shannon 熵；熵低表示该粒度上有明确匹配，权重按逆熵归一化分配。（`Router.weights`）
- **PPR 检索**：用路由权重加权的相似度作为种子分布，在关联图上跑 Personalized PageRank，取最终得分 top-k。（`GraphChannel.ppr`）
- **LLM 过滤（Redundancy Filtering）**：对候选做一次相关性与去重判断。默认关闭，按 query 复杂度或配置开启。（`Filter`）

本插件在论文之外加入的概念：

- **通道与融合（Channel & Fusion）**：检索由多条独立通道并行产出候选列表，再用 Reciprocal Rank Fusion 合并。上述论文机制分布在其中两条通道里。
- **演化（Evolve）**：把论文的动态关联扩展成六个后台过程（关联、调和、强化、衰减、抽象、重关联），见[演化](#演化evolve)。
- **作用域（Scope）**：记忆分 `global`（跨项目的用户画像与偏好）和 `project:<key>`（按 git remote 归一化的项目记忆）两轨。
- **健康度（Health）**：每个高级机制自带健康检查，不健康时自动摘除，状态在 `/memory status` 可见。

## 系统架构

pnpm monorepo，三个包：

- `@memgas/core`：纯 TypeScript 算法与存储库，零 dsh 依赖。包含记忆数据模型、SQLite 存储、词法索引、向量索引、Embedder 接口与实现、GMM、熵路由、PPR、融合器、演化调度器、提示词模板与结构化输出校验。可被任何 Node 程序引用。
- `dsh-memgas`：dsh 插件（bundle）。只做接线：把 core 接到 dsh 的事件、工具、提示词、任务、命令与 LLM 接口上。
- `memgas-mcp`：MCP server，用 core 暴露同一套记忆库给其他 agent。

数据流：

```text
[dsh 会话]
   │ session/event (turn/end, user/message, assistant/message, compaction)
   ▼
Ingest ──► Segment ──► Summarize+Keywords (ctx.llm) ──► Embed (4 粒度)
                                                          │
                                                          ▼
                                       Evolve: associate → reconcile → store
                                                          │
                            ┌─────────────────────────────┤ 后台 (ctx.jobs)
                            ▼                             ▼
                    reinforce / decay / abstract / re-associate

[新一轮 query]
   │
   ├──► C1 词法 FTS5        ┐
   ├──► C2 稠密向量 top-k    │ 并行，各自出候选列表
   ├──► C3 多粒度 + 熵路由   │ （增强，可关闭）
   └──► C4 图扩展 PPR       ┘ （增强，可关闭，种子来自 C1+C2）
                             │
                             ▼
                    RRF 融合 + 基线保底配额
                             │
                             ▼
                     可选 LLM 过滤（默认关）
                             │
   ┌─────────────────────────┼─────────────────────────┐
   ▼                         ▼                         ▼
memory_search 工具      agent.inject() 卡片      systemPrompt 常驻段
```

dsh 接线点（全部为官方文档记录的扩展点，不改核心）：

- `ctx.on('session/event', ...)`：监听 `turn/end`、`user/message`、`assistant/message`，作为自动收割的数据源。
- `ctx.compaction`：上下文压缩发生时，把被折叠掉的消息先收割进记忆。
- `ctx.llm`：摘要、关键词、调和判断、过滤全部复用宿主已配置的模型，不要求用户额外配置 API key。
- `ctx.jobs`：所有演化过程作为后台任务运行，不阻塞轮次。
- `ctx.tools.register(defineTool(...))`：注册 `memory_search`、`memory_save`、`memory_forget`、`memory_status`。
- `agent.inject()`：主动召回命中阈值时注入记忆卡片，落到下一次模型请求。
- `ctx.systemPrompt.section()`：注入用户画像与置顶记忆的常驻段。
- `ctx.commands`：注册 `/memory` 用户命令。
- `ctx.storageDomain`（sqlite 后端）或自管 SQLite：记忆记录与关联图；向量存紧凑二进制 sidecar。
- `ctx.settings`：在 Web UI 设置里暴露配置卡片（后期）。

分发：npm 包在 `package.json` 声明 `dsh.bundle`，附带 `cordis.patch.yml`。用户执行 `dsh plugin --profile web add dsh-memgas` 安装，`remove` 卸载。发布 npm 预构建产物，避免 git 直装时 pnpm 的 `allowBuilds` 授权门槛。

## 记忆生命周期

### 存储（Store）

数据模型（草案）：

- `MemoryUnit`：`id`、`scope`、`granularity`（session | turn | summary | keyword）、`content`、`embeddingRef`、`provenance`（sessionId、seq 范围、时间、工作目录、git 分支）、`createdAt`、`updatedAt`、`importance`、`accessCount`、`lastAccessedAt`、`status`（active | superseded | archived）、`supersededBy`、`version`、`derivedFrom[]`、`promptVersion`、`embedderId`。
- `Fact`：summary 粒度下的结构化子项，`kind` ∈ {preference, decision, convention, environment, pitfall, entity, todo}，带 `confidence` 与 `evidence[]`（指向 turn 单元）。用户画像与项目约定由 Fact 聚合生成。
- `Edge`：`from`、`to`、`weight`、`kind` ∈ {association（GMM accept）, coRetrieval（共同被取回）, supersedes（版本链）, derivedFrom（抽象来源）}。
- `Session`：会话元数据，记录 ingest 游标（已处理到的 seq），保证重启后不重复收割。

索引：每个单元同时进两个索引。SQLite FTS5 负责词法检索，对标识符做保原样分词（路径、包名、报错码不被切碎）；向量 sidecar 负责稠密检索。两个索引都不依赖任何高级机制，是永不关闭的基线。

存储位置：`$DSH_HOME/memgas/`（memgas-mcp 默认同一路径，可配置）。目录下每个 scope 一个 SQLite 文件加向量 sidecar，便于单项目导出、删除或同步。

### 演化（Evolve）

六个后台过程，全部在 `ctx.jobs` 中运行。每个过程独立、幂等、可恢复，任一失败不影响主循环，也不影响其他过程。

1. **关联（associate）**：新单元入库时按论文方法计算与历史单元的跨粒度相似度向量，GMM 二分量聚类，accept 集建 `association` 边。**兜底**：GMM 不可分（两分量重叠度过高、协方差退化、accept 集占比超出 [5%, 60%] 区间）时，改用固定分位阈值建边，并在健康度中标记降级。触发：每次 ingest。
2. **调和（reconcile）**：新 Fact 入库前，取回语义邻近的既有 Fact，由 LLM 判定关系：duplicate（丢弃并强化旧条目）、update（新条目 supersede 旧条目，保留版本链）、contradict（两者共存并标记冲突，检索时一起返回让模型判断）、unrelated（正常入库）。**兜底**：LLM 不可用或输出不合 schema 时，退化为按相似度阈值去重，其余一律 unrelated 直接入库——宁可留冗余，不可丢事实。触发：每次产生新 Fact。
3. **强化（reinforce）**：被取回并注入的单元 `accessCount` 加一、`importance` 上调；同一次检索中共同返回的单元之间 `coRetrieval` 边加权；注入后助手回复中引用了该记忆（通过卡片 id 回指检测），额外加权。触发：每次检索与每次 turn/end。
4. **衰减与遗忘（decay & forget）**：`importance` 按上次访问时间做指数衰减（半衰期可配）；低于阈值的单元转为 `archived`，不再参与检索但可通过 `/memory` 恢复；每个 scope 的 active 单元数有上限。**不做物理删除**，除非用户显式 `forget` 或 `purge`。触发：会话开始与定时。
5. **抽象（abstract）**：当一个图社区（或 GMM 分量）内的 active 单元超过阈值，LLM 把它们综合成一个更高层的 summary 单元（例如「该项目的测试约定」「用户对回复格式的偏好」），新单元通过 `derivedFrom` 边指向来源。**兜底**：抽象产物是叠加而非替换，来源单元保持 active；抽象单元初始置信度打折，只有被实际取回并使用后才升权。抽象失败或输出不合 schema 时跳过本次，来源不受影响。触发：阈值与定时。
6. **重关联（re-associate）**：记忆库增长后，对最近窗口内的单元重新跑 GMM，刷新 accept/reject 集与边权。同时做图健康检查：平均度过低（图太稀疏，PPR 无意义）或出现超级枢纽节点（度数超过全图 P99 数倍，会把噪声扩散到全库）时，分别关闭图通道或对该节点截断边。触发：定时或单元数每增长固定比例。

### 检索（Recall）

检索不是一条流水线，是四条并行通道加一次融合。任何一条通道退化，其余通道仍然出结果。

**通道**

| 通道 | 内容 | 擅长 | 可关闭 |
|---|---|---|---|
| C1 词法 | SQLite FTS5，标识符保原样分词 | 文件路径、包名、报错码、精确措辞 | 否 |
| C2 稠密 | 全库向量 top-k，不分粒度 | 换个说法问同一件事 | 否 |
| C3 多粒度 | 四粒度分别检索，熵路由分配权重 | 判断该看整段会话还是某一轮 | 是 |
| C4 图扩展 | 以 C1+C2 结果为种子在关联图上跑 PPR | 跨会话的多跳关联 | 是 |

**融合**：用 Reciprocal Rank Fusion（按排名而非分数融合）。选它的原因是各通道分数量纲不可比，而 RRF 只看排名，某条通道整体失准时不会污染其他通道的排序。每条通道有可配权重。

**基线保底配额**：最终 top-k 中，至少一半席位保留给 C1 与 C2 的融合结果。C3、C4 只能填充剩余席位与重排，不能把基线结果挤出去。这条规则把「高级机制最坏情况」钉死在「等于普通检索」。

**降级阶梯**（自动，逐级触发，状态记入健康度）：

- 记忆总量低于冷启动阈值（默认 50 单元）→ 只跑 C1+C2，不建图不路由。
- embedding 模型尚未就绪 → C2 用词法向量顶替，模型就绪后自动恢复。
- 熵路由退化（四个粒度熵值接近、无区分度）→ C3 回落到等权重，等同于普通多粒度检索。
- 图健康检查不通过（过稀疏、有超级枢纽、边数不足）→ 跳过 C4。
- PPR 迭代超时或超过迭代上限 → 直接返回种子集合。
- 任一通道抛异常 → 记录并跳过该通道，其余照常融合。
- 全部通道失败 → `memory_search` 返回空结果并说明原因，主动注入静默跳过。检索失败不允许影响正在进行的轮次。

**预算**：整条检索路径有硬性延迟预算（默认 300ms，主动注入路径更严）。超预算返回当前已完成通道的融合结果。

**可选 LLM 过滤**：对融合后的候选做相关性与去重判断，默认关闭。`memory_search` 带 `deep: true` 或配置 `filter: always` 时开启。过滤只能删除候选、不能新增，且删除后若结果数低于下限则回退到未过滤结果。

**模式**：`lite`（只有 C1+C2）、`hybrid`（默认，四通道全开但增强通道受保底与健康度约束）、`memgas`（放宽保底配额，给增强通道更大权重）。

### 利用（Use）

三条通道把取回的记忆送进模型上下文：

- **工具**：`memory_search(query, scope?, k?, deep?)` 返回记忆卡片列表；`memory_save(content, kind?, scope?)` 显式记忆；`memory_forget(id | query)`；`memory_status()`。
- **主动注入**：每个 turn 的首个 step 前，用本轮用户消息做一次检索。命中的最高分超过阈值时，通过 `agent.inject()` 注入一个记忆卡片块。注入有 token 预算上限与每轮一次的频率限制；同一条记忆在同一会话内不重复注入，避免污染上下文。
- **常驻段**：`systemPrompt.section()` 注入 global scope 的用户画像与用户置顶（pin）的记忆，预算默认 400 token，内容随抽象过程更新。

记忆卡片格式（模型可见）：

```text
[memory:m_8f3a | project | 2026-08-29 | decision | conf 0.86]
接口层统一用 zod 做参数校验，不再手写类型守卫。
来源：会话 s_… 第 12 轮
```

卡片自带 id、作用域、时间、类型与置信度，模型可以据此判断是否采信，并可用 id 回指，供强化过程检测引用。冲突记忆（reconcile 判为 contradict）成对返回并显式标注冲突，由模型在上下文中判断，不在检索层替用户做决定。

## Embedder

默认行为：插件首次激活时，在后台自动下载一个小型 embedding 模型到本地缓存，下载期间用词法向量兜底，模型就绪后自动切换并对已有单元补算向量。

- 运行时：`@huggingface/transformers`（transformers.js）在 Node 中通过 onnxruntime 推理，无需 Python。
- 默认模型：`multilingual-e5-small` 的量化 ONNX 版本（约 100–130 MB，中英混合场景下效果与体积的折中；具体数字在 M1 实测后更新）。可选 `bge-small-zh-v1.5`（中文优先）、`bge-small-en-v1.5`（英文优先）。
- 缓存位置：`$DSH_HOME/memgas/models/`，可配置。
- 镜像：读取 `HF_ENDPOINT` 环境变量，并在配置中提供 `embedder.mirror` 字段（国内用户可指向 hf-mirror.com）。
- 降级链：远程 API（若配置）→ 本地 ONNX → 词法向量。任何一级不可用自动降到下一级，`/memory status` 显示当前生效的 embedder。下载失败不重试轰炸：指数退避，失败期间插件功能不受影响，只是 C2 通道用词法向量。
- 一致性：每个单元记录建索引时的 `embedderId`；切换模型后触发全量重算，重算完成前旧索引继续服务，混用期间 C2 只在同 `embedderId` 的子集内比较。

## 提示词策略

不移植论文的提示词模板，自行构建。目标是在编码 agent 的对话上稳定产出可入库的结构化记忆，而不是通用聊天记忆。

设计原则：

- 所有 LLM 调用输出严格 JSON，用 schema 校验，失败自动重试一次并降级为「本次不产生记忆」，绝不把畸形输出写进库。
- 每个提示词都有明确的「无内容」出口（例如输出 `{"facts": []}`），避免模型为了填充而编造。
- 记忆类型采用面向编码场景的分类：偏好、决策、约定、环境事实、踩坑、实体、待办。每条带置信度与证据引用。
- 保留原语言：中文对话产出中文记忆，不翻译。
- 明确排除项：密钥、token、密码、一次性中间值、模型自己的推理过程、工具的冗长原始输出。
- 时间与来源作为输入的一部分交给模型，输出中要求区分「用户陈述」与「助手推断」，后者置信度上限更低。
- 提示词与 schema 版本化，记忆单元记录 `promptVersion`，方便后续演化时识别旧格式。

提示词清单（M2 实现，文本届时写在 `packages/core/src/prompts/`）：

1. `summarize-turn`：单轮摘要 + Fact 抽取。
2. `summarize-session`：会话级摘要，输入为各轮摘要而非原文，控制成本。
3. `extract-keywords`：关键词与实体，要求归一化（文件路径、包名、命令保持原样）。
4. `reconcile-fact`：给定新 Fact 与候选旧 Fact，输出 duplicate / update / contradict / unrelated 及理由。
5. `abstract-cluster`：给定一组同社区单元，输出一条更高层的总结与其覆盖的来源 id。
6. `synthesize-profile`：由 global scope 的 Fact 生成用户画像段，限定长度。
7. `filter-results`：给定 query 与候选卡片，输出保留的 id 列表。

## 可观测与自评

没有归因就无法判断一条记忆为什么被取回，所以可观测性从 M1 起就是基础功能。

- **通道归因**：每条被返回的记忆记录它来自哪条通道、在该通道的排名、融合后的分数。`/memory diag <query>` 打印各通道原始列表与融合过程。
- **使用回执**：记录被注入的记忆是否在后续助手回复中被引用，作为强化过程的输入。
- **健康度面板**：`/memory status` 显示当前 embedder、各通道开关状态、最近的降级事件与原因、各演化过程的上次运行时间与处理条数。
- **自检用例**：`packages/core/tests` 里有针对多跳关联、粒度选择等场景的构造用例，保证增强通道在这些形态上确实补充了基线找不到的结果，且从不挤出基线结果。

## memgas-mcp

用 core 暴露同一个记忆库的 MCP server（stdio，后续可加 streamable-http）。

- 工具：`memory_search`、`memory_save`、`memory_forget`、`memory_status`、`memory_ingest(transcript)`。最后一个用于没有会话事件接口的宿主，把对话文本手动喂进 ingest 管线。
- 默认与 dsh 插件共用 `$DSH_HOME/memgas/`，同一份记忆在 dsh、Claude Code、Codex 之间共享；也可指定独立目录。共享时用 SQLite WAL 加文件锁处理并发，写冲突退让重试。
- MCP 模式的 LLM 与 embedder 由 memgas-mcp 自己配置（OpenAI 兼容端点或本地模型），因为拿不到宿主的 `ctx.llm`。未配置 LLM 时自动运行在无摘要模式：只存 turn 粒度与词法索引，检索退化为 C1+C2。
- 局限：MCP 模式没有自动收割、没有主动注入、没有 compaction 联动，演化过程只能靠定时或显式 `memory_ingest` 触发。这些局限会写在 README 里，作为推荐原生插件的理由。

## 配置草案

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: memgas
  config:
    mode: hybrid            # lite | hybrid | memgas
    scope:
      projectKey: git-remote   # git-remote | cwd | manual
    embedder:
      provider: local          # local | api | lexical
      model: multilingual-e5-small
      mirror: null             # 例如 https://hf-mirror.com
      cacheDir: null           # 默认 $DSH_HOME/memgas/models
    recall:
      k: 8
      baselineFloor: 0.5       # C1+C2 在最终结果中的保底席位比例
      budgetMs: 300            # 整条检索路径的延迟预算
      channels:
        lexical: { enabled: true, weight: 1.0 }    # 不可关闭
        dense: { enabled: true, weight: 1.0 }      # 不可关闭
        granularity: { enabled: true, weight: 0.8, router: entropy }  # entropy | uniform
        graph: { enabled: true, weight: 0.6, maxHops: 2, pprIterations: 20, timeoutMs: 80 }
      coldStartUnits: 50       # 低于此数量只跑 C1+C2
      filter: off              # off | auto | always
      inject: true
      injectThreshold: 0.62
      injectBudgetTokens: 600
      sectionBudgetTokens: 400
    ingest:
      auto: true
      onCompaction: true
      minTurnChars: 80
    evolve:
      decayHalfLifeDays: 30
      archiveBelow: 0.15
      maxActivePerScope: 5000
      abstractClusterSize: 12
      reassociateEvery: 200    # 每新增 200 单元
      gmmFallbackPercentile: 0.85   # GMM 不可分时的建边分位阈值
    privacy:
      secretPatterns: default
      confirmWrites: false
```

## 隐私与安全

- 本地优先：记忆库不出本机，除非用户配置远程 embedder/LLM 端点。
- 写入前用正则集拦截密钥、token、私钥、密码形态的内容，命中即丢弃该片段并在 `/memory status` 计数。
- `confirmWrites: true` 时，自动收割的 Fact 进入待确认队列，用户在 `/memory review` 中采纳或拒绝。
- `/memory export` 输出可读 JSON，`/memory purge --scope` 物理删除某项目全部记忆（唯一的物理删除入口）。
- 记忆卡片对模型可见但带有来源标记，模型不会把记忆误认为当前用户输入。

## 仓库结构

```text
dsh-memgas/
├── packages/
│   ├── core/          # @memgas/core：模型、存储、索引、embedder、通道、融合、evolve、prompts
│   ├── dsh-plugin/    # dsh-memgas：bundle、cordis.patch.yml、dsh 接线
│   └── mcp/           # memgas-mcp：MCP server
├── docs/              # 设计笔记、评测记录、ADR
├── README.md
└── README.zh.md       # 发布前补齐（当前以中文 README.md 为准）
```

## 路线图

全部里程碑的功能均已实现，以下保留原计划与实际落地的对照。

1. **M0 脚手架**（已完成）：pnpm workspace、三包骨架、从源码检出的 dsh 用 `--patch` 加载、`dsh plugin add` 链路验证。
2. **M1 基线可用**（已完成，除本地 ONNX embedder）：SQLite 存储、FTS5 词法索引、向量索引、词法 embedder、C1+C2 双通道加 RRF 融合、三个工具。本地 ONNX embedder 的自动下载与降级链**尚未实现**，目前只有词法 embedder；接口（`Embedder`）与降级位置已经预留。
3. **M2 自动收割与提示词**（已完成）：`session/event` 收割、compaction 收割、提示词与 schema 校验、后台队列、主动注入、常驻段、使用回执。
4. **M3 增强通道**（已完成）：多粒度 + 熵路由（C3）、GMM 关联图 + PPR（C4）、健康检查与降级阶梯、可选 LLM 过滤、`lite` / `hybrid` / `memgas` 三种模式。
5. **M4 演化**（已完成，除 review 队列）：调和、强化、衰减、抽象、重关联，全部由 `EvolutionRunner` 按事件调度；`/memory` 提供 status / search / diag / list / forget / restore / pin / export / purge。`confirmWrites` 的待确认队列（`/memory review`）**尚未实现**。
6. **M5 memgas-mcp 与发布**（MCP server 已完成，发布未做）：`memgas-mcp` 提供 stdio JSON-RPC 与五个工具，与插件共用同一套存储布局。跨 agent 共享记忆库**尚未实测**；npm 发布、英文 README、Web UI 设置卡片都还没做。

## 决策记录

- 2026-09-04：插件范围包含存储、演化、检索利用三部分，不只做检索。
- 2026-09-04：命名 `dsh-memgas`（npm 包名同名，插件 id `memgas`，核心库 `@memgas/core`，MCP 包 `memgas-mcp`）。
- 2026-09-04：做 `memgas-mcp`。
- 2026-09-04：默认 embedder 为首次激活时自动下载的本地小模型，词法向量兜底。
- 2026-09-04：不移植论文提示词，自行设计面向编码 agent 的结构化提示词。
- 2026-09-04：独立仓库，pnpm monorepo。
- 2026-09-04：**论文机制作为可配置的增强通道，与基线通道并行**。词法与稠密检索作为永不关闭的基线，融合层设基线保底配额，保证最坏情况不劣于普通检索。
- 2026-09-04：默认模式为 `hybrid`；`memgas` 模式放宽保底配额，给增强通道更大权重。
- 2026-09-04：许可证倾向 MIT，待确认。
- 2026-09-05：存储用 Node 内置的 `node:sqlite`，不用 better-sqlite3。理由：原生模块需要 postinstall 构建，而 `dsh plugin add` 走的 pnpm ≥10 默认拦截构建脚本，会把「装上就能用」变成「先授权再重装」。代价是依赖宿主 Node 自带的 SQLite，因此 FTS5 在打开库时做能力探测，缺失时自动切到进程内的 JS 倒排索引（`capabilities.lexicalIndex` 会显示 `memory`）。
- 2026-09-05：插件不在构建期依赖 dsh 的包。`@deepseek-ai/dsh-tools` 依赖未发布的 `@deepseek-ai/dsh-type-meta`，在 dsh 仓库外装不上；插件改为按 npm 上的 `.d.ts` 抄出所需接口的结构化类型（`ToolDefinition` = name/description/parameters + output.schema/render + execute），注册原始 JSON Schema 工具定义，与 MCP 工具进入注册表的路径一致。
- 2026-09-05：插件必须导出 `inject = ['tools']`，且自身故障不得阻断 dsh 启动。集成测试发现：Cordis 在未声明 inject 时拒绝 `ctx.tools` 访问，并且该异常会让整棵插件树加载失败，即整个 dsh 起不来。现在 `apply` 把开库失败降级为内存库并在 `memory_status` 中说明。
- 2026-09-05：中文检索走 CJK 双字组。
- 2026-09-05：M2 的提示词从计划的七个收敛为两个（`summarize-turn@1`、`summarize-session@1`），关键词抽取并入摘要输出，一次调用同时产出摘要、事实、关键词。`reconcile-fact` / `abstract-cluster` / `synthesize-profile` 属于演化，推到 M4；`filter-results` 属于增强通道，推到 M3。两者共用一套输出契约与校验器（`validateExtraction`），坏掉的单条 fact 被丢弃而不是整批拒绝。
- 2026-09-05：会话级摘要只存 `session` 粒度单元与关键词，不再单独落 fact。轮次级已经抽过的事实在会话级会重复出现，而去重合并是 M4 调和过程的职责，在那之前宁可少存也不制造重复。
- 2026-09-05：不用 `ctx.jobs`，自带串行后台队列（`BackgroundQueue`）。dsh 的 JobRegistry 面向用户可见的进程型任务（有输出流、kill、等待），与进程内异步维护工作形状不符。
- 2026-09-05：收割用的模型路由取自会话日志里的 `request/header`（与 `dsh-session-title-llm` 同一做法），收割发生在 turn/end 之后，路由此时必然已知；不引入 `agentDefaultModel` 依赖。
- 2026-09-05：主动注入挂在 `agent/pre-step` waterfall 上：先 `next()` 拿到 enter 决策，再把召回卡片作为 `source.kind = 'plugin', form = 'recall'` 的用户消息插到本步消息之前；检索预算 150ms，同一进程内同一条记忆只注入一次；召回失败一律返回原决策。
- 2026-09-05：注入判定不看 RRF 分数（它只编码排名），看证据：两条通道同时命中，或稠密通道单独命中且余弦 ≥ 0.6。
- 2026-09-05：作用域改为按会话解析。插件从 `session.cwd` 推出该会话所属项目，每个作用域一套独立的存储、收割器与演化调度器（`Workspace`）；会话没有声明工作目录时回落到进程目录。工具调用通过 `exec.agent.session.id` 找到对应作用域。
- 2026-09-05：增强通道分两波执行。图通道声明 `dependsOnBaseline`，检索器先跑基线与多粒度通道，再把基线结果作为种子交给图通道，因此图扩展只能围绕真实命中展开，不会自己发散。
- 2026-09-05：GMM 不可分时按分位数建边；accept 集占比落在 [2%, 60%] 之外也视为不可信。图上出现超级枢纽节点时不关闭通道，而是把该节点的边截断到最强的若干条——关掉整条通道的代价比截断一个节点大得多。
- 2026-09-05：调和只在事实已入库之后进行。收割器先写入再调和，模型不可用时最坏结果是留下一条冗余记忆，而不是丢掉一条有效记忆。duplicate 会物理删除刚写入的重复件并给原件加权，update 走 supersede 版本链，contradict 两条都留下并记一条 `contradicts` 边。
- 2026-09-05：抽象是叠加而非替换。来源单元保持 active，抽象单元记录 `derivedFrom` 并以较低置信度起步。
- 2026-09-05：衰减只归档不删除，`pinned` 类型完全豁免。物理删除只有 `/memory purge --yes` 一个入口。
- 2026-09-05：`memgas-mcp` 没有自己的模型，`memory_ingest` 直接原文入库而不做摘要。宁可让 MCP 侧的记忆质量低于插件侧，也不引入第二套模型配置。SQLite 的 unicode61 分词器把整段连续中文当成一个 token，无法部分匹配；索引与查询都改用相邻汉字组成的 bigram，词法通道因此对中文可用。

## 未决问题

- 默认模型定稿：`multilingual-e5-small` 还是 `bge-small-zh-v1.5`。
- RRF 的 k 常数与各通道权重初值，先用文献常用值 60 起步，后续按使用反馈调整。
- `ctx.storageDomain` 是否适合存向量与大图，还是 core 自管 SQLite 更省事。M0 读完 storage 子系统文档后定。
- **发布前必须解决**：`dsh-memgas` 依赖 `@memgas/core` 的 `workspace:*`，打包时会重写成一个未发布的版本号，用户 `dsh plugin add dsh-memgas` 会装不上。两条路：把 `@memgas/core` 一并发到 npm（`memgas-mcp` 也要用它，倾向这条），或在构建时把 core 打进插件的 `lib/`。M5 前必须选定。
- 是否要 Web UI 记忆浏览面板（client 包）。
- 本地 ONNX embedder（自动下载 + 降级链）尚未实现，是当前与设计差距最大的一块。
- `confirmWrites` 的待确认队列（`/memory review`）尚未实现。

## 引用

```bibtex
@inproceedings{xu2026memgas,
  title     = {From Single to Multi-Granularity: Toward Long-Term Memory Association and Selection of Conversational Agents},
  author    = {Xu, Derong and Wen, Yi and Jia, Pengyue and Zhang, Yingyi and Zhang, Wenlin and Wang, Yichao and Guo, Huifeng and Tang, Ruiming and Zhao, Xiangyu and Chen, Enhong and Xu, Tong},
  booktitle = {International Conference on Learning Representations (ICLR)},
  year      = {2026}
}
```

