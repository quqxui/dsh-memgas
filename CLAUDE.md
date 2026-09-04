# dsh-memgas — 给 agent 的项目说明

## 这是什么

DeepSeek Harness (dsh) 的长期记忆插件：存储 + 演化 + 检索利用。检索与关联算法的概念来自本项目作者的 ICLR 2026 论文 MemGAS。

**设计文档就是 `README.md`。改设计先改 README，再改代码。**

当前阶段：M2 完成，M3（增强通道）与 M4（演化）未开始。`packages/core` 有存储、双基线通道、RRF 融合、检索编排、后台队列、收割器、提示词与结构化输出校验、注入决策、画像段；`packages/dsh-plugin` 有三个工具、事件映射、LLM 客户端、pre-step 注入与 bundle 清单。动手前先读 README 的「设计原则」「路线图」「决策记录」「未决问题」。

```sh
pnpm test        # 全量测试，当前 137 个
pnpm run build   # tsc -b，兼做类型检查
```

集成验证方法在 README「在真实 dsh 里验证」；上次装好的 dsh 在会话临时目录，新会话要重装。

已定的实现约束：
- 存储用 Node 内置 `node:sqlite`，**不引入原生模块**（原生模块的 postinstall 会被 `dsh plugin add` 的 pnpm 构建拦截挡住）。FTS5 在开库时探测，缺失即切 JS 倒排索引。
- 插件**不在构建期依赖 dsh 的包**（`@deepseek-ai/dsh-tools` 依赖未发布的私有包）。所需接口以结构化类型写在 `packages/dsh-plugin/src/index.ts`，对照 npm 上 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-llm` 的 `.d.ts` 校准。
- 中文词法检索走 CJK 双字组，见 `packages/core/src/text.ts`。
- 核心库对模型只依赖 `LlmClient`（文本进文本出，可带 sessionId），对宿主事件只依赖 `HarvestEvent`；dsh 侧的映射在 `packages/dsh-plugin/src/session-events.ts` 与 `llm-client.ts`。测试用假 ctx 走整条链路，不 mock 内部。
- 插件的 `apply` 返回 `{ idle() }` 供测试等待后台队列排空；Cordis 忽略返回值。

## 第一原则：论文是参考，不是规格

论文的方法在四个长期记忆 benchmark 上验证过，但那些 benchmark 是多轮闲聊式对话，而本插件面对的是编码 agent 的真实会话：大量文件路径、报错栈、包名、命令行、工具输出。分布不同，论文的最优解不一定是这里的最优解，也可能存在对数据集的过拟合。

因此，任何来自论文的机制（GMM 关联、熵路由、PPR、LLM 过滤）在本仓库都必须满足以下三条，否则默认关闭：

1. **可降级**：它失效时系统退回一条不依赖它的普通路径，而不是崩溃或返回空结果。
2. **单调不劣化**：它只能补充或重排候选，不能把基线检索已经找到的结果挤出最终结果集。
3. **有证据**：在 `bench/` 上跑出它相对基线的增益数据，写进 README。跑不赢基线的机制，代码保留、默认关闭、README 如实说明。

不要为了贴合论文叙事而牺牲真实效果。README 里可以讲论文故事，代码里必须按工程标准判断。

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
