# dsh-memgas

DeepSeek Harness 记忆插件。安装后 agent 获得三个工具：

- `memory_search` — 检索本项目与全局记忆
- `memory_save` — 记录一条值得跨会话保留的事实
- `memory_status` — 查看记忆条数、向量模型与索引后端

## 安装

```sh
dsh plugin --profile web add dsh-memgas
```

bundle 自带 `cordis.patch.yml`，安装后自动注册，无需手动 insert。

## 配置

在 profile 的 `cordis.patch.yml` 中按 id 覆盖：

```yaml
- id: memgas
  config:
    dataDir: ~/.dsh        # 记忆库位置，默认 $DSH_HOME
    k: 8                   # 每次检索返回的记忆条数
```

## 设计

见仓库根 [README](../../README.md)。核心算法在 [`memgas-core`](../core)，本包只负责与 dsh 接线。
