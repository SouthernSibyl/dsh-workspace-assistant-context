# dsh-workspace-assistant-context

`dsh-workspace-assistant`（大肥鱼助理）的配套上下文与预设包：

- 注册 `workspace-assistant`（「大肥鱼」）agent preset。
- 通过 `systemPrompt.context`（`order: 125`）向模型注入全机工作区实时快照，使用单次读取 + `mtime` 增量缓存与持久化快照加速冷启动。

需与 [`dsh-workspace-assistant`](https://github.com/SouthernSibyl/dsh-workspace-assistant) 配合安装使用。
