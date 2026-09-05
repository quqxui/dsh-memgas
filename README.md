# dsh-memgas

[![npm](https://img.shields.io/npm/v/dsh-memgas?label=dsh-memgas)](https://www.npmjs.com/package/dsh-memgas)
[![npm](https://img.shields.io/npm/v/memgas-core?label=memgas-core)](https://www.npmjs.com/package/memgas-core)
[![CI](https://github.com/quqxui/dsh-memgas/actions/workflows/ci.yml/badge.svg)](https://github.com/quqxui/dsh-memgas/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-memgas)](./LICENSE)

中文 | [English](./README.en.md)

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的长期记忆插件。** 让 agent 跨会话记住这个项目的约定、决策和踩过的坑，并随着使用不断整理、更新、遗忘。

检索用的多粒度关联与自适应选择方法来自 ICLR 2026 论文 *[From Single to Multi-Granularity: Toward Long-Term Memory Association and Selection of Conversational Agents](https://github.com/Applied-Machine-Learning-Lab/ICLR2026_MemGAS)*（MemGAS）。

## 安装

```sh
dsh plugin --profile web add dsh-memgas              # 从 npm
dsh plugin --profile web add github:quqxui/dsh-memgas # 或直接从 GitHub
```

两种方式等价。仓库里带了打包好的单文件产物，从 GitHub 装不需要构建、不需要给 pnpm 构建授权、也不会拉任何运行时依赖——插件本身只用 Node 内置模块。

重启 dsh 即生效。插件自带 bundle 配置，不需要手动改 `cordis.patch.yml`。默认零配置：不需要 API key，不下载模型，不起额外进程。

## 它做什么

换一个会话，agent 自己就想起来了。下面是原始运行记录，两个独立的 dsh 进程（0.1.2-rc.1）：

```text
$ dsh --profile headless "请用 memory_save 工具记住：本项目的部署端口是 8080，依赖用 pnpm 管理。"

已完成记忆保存：
1. **环境**：本项目的部署端口是 8080。
2. **约定**：本项目依赖用 pnpm 管理（而非 npm/yarn）。

# ——— 进程退出，换一个全新会话，没有任何共享上下文 ———

$ dsh --profile headless "这个项目的部署端口是多少？依赖用什么管理？直接回答。"

根据长期记忆：
- **部署端口**：8080
- **依赖管理**：pnpm
```

第二个会话没有调用任何工具，也没被告知去查记忆——相关内容在模型请求发出之前就已经进了上下文。

这个例子里第一句明确要求了保存。实际使用中不需要：每轮对话结束后，插件会在后台把值得留下的内容蒸馏成事实、摘要和关键词自动入库。

## 检索

大多数记忆插件用一条通道：向量相似度或全文匹配。dsh-memgas 并行跑四条，再按排名融合：

| 通道 | 内容 | 擅长 | 可关闭 |
|---|---|---|---|
| 词法 | SQLite FTS5，标识符保原样 | 文件路径、包名、报错码、精确措辞 | 否 |
| 稠密 | 向量相似度 | 换一种说法问同一件事 | 否 |
| 多粒度 | 会话/轮次/摘要/关键词四个粒度分别检索，按熵路由分配权重 | 判断该看整段会话还是某一轮 | 是 |
| 图扩展 | 以前两条通道的命中为种子，在关联图上跑 Personalized PageRank | 跨会话的多跳关联 | 是 |

融合用 Reciprocal Rank Fusion，只看排名不看分数——各通道的分数量纲不可比，某条通道整体失准时不会污染其他通道的排序。

**基线保底。** 最终结果里至少一半席位留给词法和稠密两条通道，增强通道只能填充剩余席位与重排。最坏情况下的检索质量等于普通检索。

**自动降级。** 记忆太少就只跑基线两条；熵路由没有区分度就回落等权重；关联图太稀疏就跳过图通道，出现超级枢纽节点就截断它的边而不是关掉整条通道；任一通道抛异常或超时就跳过它，其余照常融合。整条路径有延迟预算，超时返回已完成通道的结果。检索失败从不影响正在进行的对话。

`/memory diag <关键词>` 会打印每条通道的原始结果和融合过程，每条记忆都能说清是哪条通道、排第几、什么分数带回来的。

## 记忆会演化

记忆不是只写不改的日志。六个后台过程持续整理，全部在队列里跑，不占对话的关键路径：

- **关联** — 新记忆入库时按相似度分布聚类，与真正相关的历史记忆建边
- **调和** — 重复的合并、过时的走版本链标记取代、矛盾的两条都留下并标注冲突
- **强化** — 被取回并真正用上的记忆权重上升，反复一起出现的记忆之间建立连接
- **衰减** — 长期无人问津的记忆归档（只归档，不删除，随时可恢复）
- **抽象** — 一组相关记忆积累到一定规模，综合成一条更高层的约定，来源保持可用
- **重关联** — 记忆库增长后刷新关联图，让它反映当前实际的分布

任何一个过程失败都不影响其他过程，也不影响对话。

## 工具与命令

agent 可以用三个工具：`memory_search`、`memory_save`、`memory_status`。

你可以用 `/memory`：

```text
/memory status              记忆条数、向量模型、索引与通道状态
/memory search <关键词>      检索并列出记忆卡片
/memory diag <关键词>        显示各通道的原始结果与融合过程
/memory list [数量]          按重要度列出本项目的记忆
/memory forget <id>         归档一条记忆（可恢复）
/memory restore <id>        恢复归档的记忆
/memory pin <id>            标记为常驻，不受自动衰减影响
/memory review              处理等待确认的记忆
/memory export              以 JSON 导出本项目的记忆
/memory purge --yes         物理删除本项目的全部记忆（不可恢复）
```

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖，全部字段可选：

```yaml
- id: memgas
  config:
    mode: hybrid             # lite（只跑基线两条通道）| hybrid | memgas（增强通道权重更高）
    k: 8                     # 每次检索返回的记忆条数
    harvest: true            # 自动从对话里收割记忆
    recall: true             # 轮次开始前主动注入相关记忆
    evolve: true             # 运行后台整理过程
    confirmWrites: false     # true 时自动收割的记忆先进 /memory review 队列
    localModel: null         # 见下方「向量模型」
```

完整字段见[设计文档](./docs/design.md#配置草案)。

## 隐私与存储

记忆库是本机的 SQLite 文件，按项目分开存放在 `$DSH_HOME/memgas/`，一个作用域一个文件，方便单独导出或删除。项目作用域按 git remote 归一化，同一个仓库在不同机器上克隆也是同一份记忆。

**不外发。** 摘要和整理复用 dsh 里你已经配好的模型，不需要额外的 API key，也不会把记忆发到任何第三方服务。写入前会拦截密钥、token、私钥形态的内容。

## 向量模型

默认使用不依赖任何下载的词法向量，装完即用。需要语义泛化能力时可以启用本地模型：

```sh
pnpm add @huggingface/transformers
```

```yaml
- id: memgas
  config:
    localModel:
      model: multilingual-e5-small
      mirror: https://hf-mirror.com   # 可选
```

模型在后台加载，加载期间和加载失败时都由词法向量顶替，就绪后自动为已有记忆补算向量。它不是本插件的依赖——`onnxruntime` 这类原生模块会让 `dsh plugin add` 撞上构建脚本授权，所以交给需要的人自行安装。

## 给其他 agent 用

[`memgas-mcp`](https://www.npmjs.com/package/memgas-mcp) 通过 MCP 暴露同一套记忆库，Claude Code、Codex 等宿主可以共用：

```json
{ "command": "npx", "args": ["-y", "memgas-mcp"] }
```

默认与插件共用 `$DSH_HOME/memgas/`。它没有自己的模型，`memory_ingest` 直接原文入库不做摘要，所以记忆质量低于插件侧，也没有自动收割和主动注入。

## 已知限制

- **本地向量模型未经真实模型验证。** ONNX 加载路径只用注入的假运行时测过，mean pooling 与维度处理没有跑过真实权重。默认关闭，不影响开箱使用。
- **`memgas-mcp` 没有和真实 MCP 客户端连过**，只验证了 JSON-RPC 协议层。
- **一次性模式下蒸馏滞后一个会话。** `dsh --profile headless` 跑完就退出，来不及做完模型抽取；原始对话始终同步落盘且可检索，蒸馏在下次会话开始时补做。常驻的 `dsh web` 没有这个问题。
- **多工作区。** 作用域按会话的工作目录解析，同一个 host 里不同工作区的会话各自归属正确的项目，但这一路径尚未在 `dsh web` 的多工作区场景下实测。
- 检索的默认权重与阈值是工程判断，没有针对特定数据集调过参。

## 开发

```sh
pnpm install
pnpm test        # vitest，263 个测试
pnpm run build   # tsc -b，兼做类型检查
```

`pnpm run build` 会先 `tsc -b`，再用 esbuild 把插件与 core 打成 `dist/index.js`。**这个产物随仓库提交**，改了插件代码要重新构建并一起提交，否则从 GitHub 安装的人拿到的还是旧版本。

源码分三个包：`packages/dsh-plugin`（dsh 接线）、[`memgas-core`](./packages/core)（存储、检索通道、演化，与 dsh 无关，单独发布在 npm）、[`memgas-mcp`](./packages/mcp)（MCP server）。

设计取舍、决策记录和未决问题都在[设计文档](./docs/design.md)里。

## 引用

```bibtex
@inproceedings{xu2026memgas,
  title     = {From Single to Multi-Granularity: Toward Long-Term Memory Association and Selection of Conversational Agents},
  author    = {Xu, Derong and Wen, Yi and Jia, Pengyue and Zhang, Yingyi and Zhang, Wenlin and Wang, Yichao and Guo, Huifeng and Tang, Ruiming and Zhao, Xiangyu and Chen, Enhong and Xu, Tong},
  booktitle = {International Conference on Learning Representations (ICLR)},
  year      = {2026}
}
```

## 许可证

[MIT](./LICENSE)
