# dsh-memgas — 给 agent 的项目说明

## 这是什么

DeepSeek Harness (dsh) 的长期记忆插件：存储 + 演化 + 检索利用。检索与关联算法的概念来自本项目作者的 ICLR 2026 论文 MemGAS。

**设计文档就是 `README.md`。改设计先改 README，再改代码。**

当前阶段：0.1.0 待发布，共 263 个测试，已在真实 dsh 上端到端验证过。剩下：npm 发布（需要用户自己 `npm login`，然后 `pnpm publish -r --access public`，core 必须先发）、英文 README、跨 agent 共享实测、Web UI 卡片。动手前先读 README 的「设计原则」「路线图」「决策记录」「未决问题」。

三个包：`packages/core`（存储与图、四条检索通道、融合、收割器、提示词、演化六过程、诊断）、`packages/dsh-plugin`（三个工具、`/memory` 命令、事件映射、pre-step 注入、按会话分作用域）、`packages/mcp`（stdio JSON-RPC server）。

```sh
pnpm test        # 全量测试，当前 263 个
pnpm run build   # tsc -b，兼做类型检查
```

集成验证方法在 README「在真实 dsh 里验证」；上次装好的 dsh 在会话临时目录，新会话要重装。

已定的实现约束：
- 存储用 Node 内置 `node:sqlite`，**不引入原生模块**（原生模块的 postinstall 会被 `dsh plugin add` 的 pnpm 构建拦截挡住）。FTS5 在开库时探测，缺失即切 JS 倒排索引。
- 插件**不在构建期依赖 dsh 的包**（`@deepseek-ai/dsh-tools` 依赖未发布的私有包）。所需接口以结构化类型写在 `packages/dsh-plugin/src/index.ts`，对照 npm 上 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-llm` 的 `.d.ts` 校准。
- 中文词法检索走 CJK 双字组，见 `packages/core/src/text.ts`。
- 核心库对模型只依赖 `LlmClient`（文本进文本出，可带 sessionId），对宿主事件只依赖 `HarvestEvent`；dsh 侧的映射在 `packages/dsh-plugin/src/session-events.ts` 与 `llm-client.ts`。测试用假 ctx 走整条链路，不 mock 内部。
- 插件的 `apply` 返回一个 handle（`idle()` / `defaultScope` / `scopeForSession()` / `memory` / `evolutionStats()`）供测试使用；Cordis 忽略返回值。
- 每个作用域一个 `Workspace`（store + harvester + evolution + queue），按会话的 `cwd` 解析，见 `packages/dsh-plugin/src/index.ts`。
- 词法 embedder 在小库上几乎召回全部条目（哈希碰撞产生伪相似度）。要构造「基线够不到」的检索场景，测试里注入一个正交的 embedder，见 `packages/core/tests/service-modes.test.ts` 的 `TopicEmbedder`。
- **不要给任何包加 `@huggingface/transformers` 依赖**（optional peer 也不行）：pnpm 默认安装可选 peer，会把 onnxruntime-node 与 sharp 拖进用户的 `dsh plugin add` 并撞上构建授权门槛。它只通过运行时动态 import 使用，装不上就回落词法向量。
- **一次性宿主（headless）里不要指望关闭阶段能完成 LLM 调用**：预算小则带推理的路由把预算耗光返回空文本，预算大则进程先退出。任何必须落盘的东西要么同步写，要么标记后由 `catchUp()` 续做。原始轮次同步落库就是这个原因。
- 后台队列是**串行**的。往里放长任务会把后面的任务饿死到进程退出为止，这一点在一次性宿主上是数据丢失，不只是延迟。

## 对外文案约束（作者要求，优先级最高）

README、包 README、代码注释、提交信息、npm 包描述都是给外人看的。**作者的内部判断一律不写进去**，包括但不限于：论文方法可能过拟合某个数据集、论文提示词偏简单、公开的记忆 benchmark 不适合本场景、"不以复现论文为目标"之类的表态。对外只讲工程事实：机制是什么、怎么降级、怎么配置。

这类内部判断只允许出现在本文件里。作者曾手动删过 README 里的此类措辞，不要再写回去。

## 第一原则：论文是参考，不是规格

（内部原则，不对外表述。）论文在多轮对话 benchmark 上验证，本插件面对的是编码 agent 会话：文件路径、报错栈、包名、命令行、工具输出。分布不同，论文的最优解不一定是这里的最优解。作者明确表示：暂不做真实语料验证，公开记忆 benchmark 不适合本场景，默认配置按工程判断定。

因此，任何来自论文的机制（GMM 关联、熵路由、PPR、LLM 过滤）在本仓库都必须满足以下两条：

1. **可降级**：它失效时系统退回一条不依赖它的普通路径，而不是崩溃或返回空结果。
2. **单调不劣化**：它只能补充或重排候选，不能把基线检索已经找到的结果挤出最终结果集。

每条增强机制要有开关、权重、超时和健康检查；测试里用构造用例证明它在目标形态（多跳、粒度选择）上确实补充了基线，且从不挤出基线。不要为了贴合论文叙事而牺牲真实效果。

## 工程约束

- **兜底优先于精巧**。每个高级阶段（GMM、路由、PPR、LLM 过滤、LLM 摘要）都要有开关、超时预算和失败回退路径。失败必须静默降级并记录，不能让一次记忆检索失败拖垮一个轮次。
- **基线永远在线**。词法检索（FTS5）与稠密向量 top-k 是永不关闭的两条通道。冷启动、模型没下载完、图太稀疏、LLM 不可用时，它们独立可用。
- **LLM 输出一律不可信**。所有 LLM 调用输出严格 JSON + schema 校验，失败重试一次后放弃本次记忆写入。畸形输出绝不入库。
- **写入可逆**。演化过程不做物理删除：更新走 supersede + 版本链，遗忘走 archive。物理删除只在用户显式 `/memory purge` 时发生。
- **可解释**。每条被取回的记忆要能说清是哪条通道、哪个粒度、什么分数带回来的（`/memory diag`）。无法归因的检索结果等于无法调试。
- **成本可控**。LLM 调用集中在后台任务，不进入轮次关键路径；每个后台过程有频率上限和 token 预算。

## 上游依赖

dsh 处于 developer preview，接口会有破坏性变更。实现时以当时的上游文档为准，不要照搬本文件里的接口记忆：

- `docs/architecture.zh.md` — 扩展点全景与事件分类
- `docs/cookbook/extension-cookbook.zh.md` — 各类插件形态，含「记忆 → section + 工具」的官方机制映射
- `docs/cookbook/adding-a-tool.zh.md` — 工具定义参考
- `docs/user/develop/basic/publish.zh.md` — bundle 打包与 `dsh plugin add` 安装链路
- `docs/subsystems/storage.zh.md` — 存储后端与领域 KV

## 其他约定

- 提示词自行设计，不移植论文附录模板（见 README「提示词策略」）。所有提示词版本化，记忆单元记录生成它的提示词版本。
- 中文优先：README、注释、提示词面向中英混合场景，记忆内容保留原语言不翻译。
- 工具链：Node 26、pnpm 11 已装。
