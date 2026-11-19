# ADR 0001：节点配置的载体与同步时机

> 状态：已接受（2026-11-17）
> 取代：`~/.dsh-fleet/run/brain.patch.yml` + `--patch` 方案
> 现在怎么工作：见 [ARCHITECTURE.md](ARCHITECTURE.md) §六之二「模型与凭据」、§六之三「凭据与状态存在哪」

## 问题

节点是远程大脑，模型名册与 API key 该由**本地**决定。初版在连接时从本地 `configEditor` 复制模型行，
写进节点的 `brain.patch.yml`，宿主用 `--patch` 加载。两个缺陷，用户原话是
**「节点那里只是远程大脑啊，具体配置应该在本地大脑读取啊？」**：

1. 只在 connect 那一刻同步 —— 本地改了模型、换了 key，已连上的节点还是旧的；
2. 改配置要重启节点宿主。

## 被否方案：`--patch` overlay（实测推翻了）

`--patch` 传入的覆盖层**不在 HMR 的监视列表里**。上游 `dsh-hmr` 只 watch 两个路径：
`profile.patchPath` 与 `$DSH_HOME/cordis.patch.yml`。节点上逐条验证：

| 实验 | 结果 |
|---|---|
| 往 overlay 里加一行指向不存在包的行 | 宿主进程不变、日志零新增 —— **确认不被 watch** |
| 往自有 profile 的 `cordis.patch.yml` 写 3 个模型（原子 `mv`） | 8 秒后 `session/modelCatalog` 返回它们，**PID 不变** |
| 同上但用 `>` 原地改写 | 同样生效（chokidar + `awaitWriteFinish`，两种写法都收得到） |
| 新建插件自有 profile（bundles = base + brain，无 `--patch`） | 正常启动并打印入口 URL，热重载同样生效 |

## 决定

节点上有一个**插件完全自有的 profile**（`~/.dsh/profiles/<profile>/`，profile 名按 `remoteRoot`
派生）：组合在 `package.json`，配置在 `cordis.patch.yml`（插件每次重写，是 HMR 监视的那个文件），
启动命令不带 `--patch`。于是**一个 profile 只有一个主人**，不再和节点本来的 `web` profile 抢文件。

同步时机订阅三个信号：`app-boot/config-reload`（模型/权限变了）、`credentials/reference-updated`
（key 变了）、连接建立（首次下发）。对每个已连接节点 `plan → writePatch`，字节有变才写盘；
**宿主自己热重载，插件不重启它**。key 走节点自己的 `credentials/set`。

## 为什么不用 `$DSH_HOME/cordis.patch.yml`

它也在 HMR 列表里，但那是**节点整机的用户层**，属于这台机器上所有 profile。插件写它就会影响
节点上别的东西；自有 profile 的 patch 是等价机制，作用域却是我们的。

## 后果

- 改模型/换 key 不再需要重连或重启节点宿主。
- 节点 profile 名从 `web` 变为 `fleet`（其它 root 派生 `fleet-<name>`）。旧 `web` profile 里由本插件
  写入的 bundle 列表不再使用；插件不删它（那是用户的目录）。
- `ensureServing` 的 `patchChanged` 现在只服务 **brain bundle 内容变化**（那需要重启，模块要重新
  import），配置变化不再走重启路径。
