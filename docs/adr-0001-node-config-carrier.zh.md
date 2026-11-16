# ADR 0001：节点配置的载体与同步时机

> 状态：已接受（2026-11-17）
> 取代：`~/.dsh-fleet/run/brain.patch.yml` + `--patch` 方案

## 问题

节点是**远程大脑**，模型名册和 API key 应该由**本地**决定。初版的做法是：连接时从本地 `configEditor` 复制模型行，写进节点上的 `~/.dsh-fleet/run/brain.patch.yml`，宿主用 `--patch` 加载它。

这有两个缺陷：

1. **只在 connect 那一刻同步。** 本地改了模型、换了 key，已经连上的节点还是旧的，必须手动重连。用户原话：**"节点那里只是远程大脑啊，具体配置应该在本地大脑读取啊？"**
2. **改配置要重启节点宿主。** `--patch` 传入的覆盖层**不在 HMR 的监视列表里** —— 上游 `app-boot` 只 watch 两个文件：`profile.patchPath` 与 `$DSH_HOME/cordis.patch.yml`。

## 实测依据

在节点（192.168.3.93，DSH 0.2.2-rc.3）上逐条验证，结论都不是推断：

| 实验 | 结果 |
|---|---|
| 往 `--patch` 的 overlay 里加一行指向不存在包的行 | 宿主进程不变、日志零新增 —— **overlay 不被 watch** |
| 往 `web` profile 的 `cordis.patch.yml` 写 3 个模型（原子 `mv`） | 8 秒后 `session/modelCatalog` 返回那 3 个模型，**PID 不变** —— 热重载生效 |
| 同上但用 `>` 原地改写 | 也生效（`dsh-hmr` 用 chokidar 且 `awaitWriteFinish: true`，两种写法都收得到） |
| 新建插件自有 profile（`~/.dsh/profiles/fleet/`，bundles = base + brain，无 `--patch`） | 正常启动并打印 `dsh web: …?token=…`，读取它自己的 `cordis.patch.yml`，热重载同样生效 |

## 决定

节点上有一个**插件完全自有的 profile**：

```
~/.dsh/profiles/fleet/
├── package.json          ← dsh.profile.bundles = [dsh-base, @local/dsh-fleet-brain]
├── cordis.patch.yml      ← 模型名册 + 权限预设（插件每次重写；HMR 监视的文件）
└── node_modules/@local/dsh-fleet-brain/   ← 嵌入的 brain bundle
```

启动命令不再带 `--patch`：

```
node <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile fleet --host 127.0.0.1 --port 0 --no-open
```

于是**一个 profile 只有一个主人**：组合（`package.json`）和配置（`cordis.patch.yml`）都由插件写，不再和节点本来的 `web` profile 抢同一批文件。

## 同步时机

本地 Host 有三个能改变"节点该拿什么配置"的信号，全部订阅：

| 信号 | 上游事件 | 含义 |
|---|---|---|
| 模型/权限配置变化 | `app-boot/config-reload` | `configEditor` 每次写配置后都会 emit（在 `recompute` 末尾） |
| API key 变化 | `credentials/reference-updated` | 凭据库写入后 emit |
| 连接建立 | `connect` 自己 | 首次下发 |

`syncConfig()` 对每个已连接节点：`plan()` → `writePatch()` → 若字节有变，**宿主的 HMR 自己会热重载，插件不重启它**。key 仍然经节点自己的 `credentials/set` 推送（用户确认：key 可以落在节点上）。

节点在配置变化期间掉线时的处理：`connect` 里本来就会重写一次，所以不需要给"离线期间的变更"做队列。

## 为什么不用 `$DSH_HOME/cordis.patch.yml`

它也在 HMR 列表里，但那是**节点整机的用户层**，属于这台机器上所有 profile。插件写它就会影响节点上别的东西（用户以后自己建的 profile）。自有 profile 的 patch 是等价的机制，作用域却是我们的。

## 后果

- 改模型/换 key **不再需要重连节点**，也不再重启节点宿主。
- 节点 profile 名从 `web` 变为 `fleet`。旧 `web` profile 里由本插件写入的 bundle 列表不再使用；插件不删它（那是用户的目录），但会在 connect 时报告"已改用 fleet profile"。
- `ensureServing` 的 `patchChanged` 参数只服务于 **brain bundle 内容变化**（那需要重启，因为模块要重新 import），配置变化不再走重启路径。
- 配置字节没变时不写盘，避免每次重连触发一次无意义的热重载。
