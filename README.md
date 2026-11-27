# fatfish-persona-assistant-context

`fatfish-persona-assistant`（大肥鱼助理）的配套上下文与预设包：

- 注册 `workspace-assistant`（「大肥鱼」）agent preset。
- 通过 `systemPrompt.context` 向模型注入全机工作区实时快照（`order: 127`），使用单次读取 + `mtime` 增量缓存与持久化快照加速冷启动。
- 长期核心记忆 `MEMORY.md`（`order: 126`）。
- 派活 cwd 硬规则（`order: 128`，可关）。

需与 [`fatfish-persona-assistant`](https://github.com/SouthernSibyl/fatfish-persona-assistant) 配合安装使用。

## 工具面

preset 的工具行写在 `cordis.patch.yml`，运行中的 `/health` 拿不到 preset 的 plugins，所以工具清单以源码为准：

```bash
node scripts/preset-tools.mjs   # 或 npm run tools
```

当前 20 行（2 个 group + 18 项）。其中 shell 跨平台：Windows 启 `tool-pwsh`，其它平台启 `tool-bash`（另一项 disabled）。已刻意不含 `workflow` / `plan-mode` / 插件市场 / `office` / `schedule`：助理的活按 persona 派给子代理，自己只留核实用的最小工具面。

## 配置

```yaml
- id: workspace-context
  name: 'fatfish-persona-assistant-context'
  config:
    delegationCwd: true   # 派活时是否向 prompt 注入「必须显式传 cwd」的硬规则
```

`delegationCwd: false` 时该 section 不注册，prompt 里不会出现 cwd 硬规则（persona 里也不再写死）。