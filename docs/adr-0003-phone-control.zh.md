# ADR-0003 手机控制：DSH Go → 中转 → 桌面 Host → 节点大脑

> 状态：已采纳（2026-11-18）。
> 现在怎么工作：见 [ARCHITECTURE.md](ARCHITECTURE.md) §一（结论先行）、§三（五条缝隙）、§五（路由表）。
> 升级要看什么：见 [`packages/dsh-remote-node-harness/docs/UPGRADE.zh.md`](../packages/dsh-remote-node-harness/docs/UPGRADE.zh.md) §七、§八。
> 本文只记**路线锚点、调研证据、被否方案**。

## 一、路线锚点

用户原来的工作方式（zcode）是四跳：手机浏览器 → 网页版 zcode ──加密通道──> Windows 上的 zcode
客户端 ──SSH──> 开发机。人不在电脑前也能改代码，因为手机操作的是**那台已经连好开发机的客户端**。

要在 DSH 上搬同一套流程，等价形态是：

```
DSH Go（安卓） ──中转──> 桌面 DSH Host（装 dsh-remote-node-harness） ──SSH──> 节点大脑（Linux）
```

三条不可让步的约束，**后续任何设计都要能对上它们，对不上就是偏离**：

1. **手机端不改 DSH Go。** 用户明确要求尽量不动这个客户端；这同时是下面所有取舍的前提。
2. **桌面那台必须开着且连着节点。** 这是 zcode 方案已有的代价，不是本方案新增的代价。
3. **节点不暴露公网端口、不需要公网 IP。** 与现有 SSH-only 语义一致。

验收的最终判据是一句话：**人离开电脑，用手机在节点上改代码、看结果、答审批，体验与在桌面端
操作节点一致。**

## 二、调研结论（源码级，不是推断）

两份源码都拉下来读过（`git clone` 走加速站），不是靠文档推断。

### 2.1 协议已经对齐

`packages/dsh_remote` 的 pubspec 自述「Pure-Dart client for ds-harness-remote」，
实现是账号登录 + 设备身份 + Noise IK 加密通道 + WebRTC/中继，并把远端 Host 的 Harness API
包成与本地引擎同一个 `DshClient`。手机端与中转、与桌面 Host 的协议**已经对齐**。

### 2.2 两份 allowlist 完全对齐

| 来源 | 条数 | 说明 |
|---|---|---|
| DSH Go `tunnel_carrier.dart` 的 `harnessRemoteAllowlist` | 99 | **客户端本地先拒**，不在表里的连发都不发 |
| 中转插件 `HARNESS_REMOTE_ALLOWLIST`（含 terminal 端点） | 111 | Host 侧再拒一次 |

逐条比对：**DSH Go 的 99 条全部在中转的放行集合里**，一条不缺。中转多放行 12 条，手机不调。
所以「手机能不能调到某个端点」不是协议问题，也不是白名单问题，**只取决于 Host 侧有没有把这个
端点的语义接对**。

### 2.3 手机上「加新能力」的硬边界

allowlist 是客户端里的 `const Set`，强制点只有两处：unary `call` 之前和 `mux.open` 之前。
不在那 99 条里的端点，手机连发都不发，**Host 侧无论怎么改都到不了手机**。因此给手机加能力只有
两条路：用**已有端点承载新语义**，或者放弃这个能力。

这条直接否定了一条看似合理的投入：**扩中转插件的 allowlist 对手机端无效**。写在这里，
避免后续有人把时间花在错的地方。

### 2.4 终端那条四跳接力是最强证据

0.2.2-rc.3 的 terminal 控制器**只有** `terminal/attach`（duplex），没有 `follow`/`write`/`resize`；
手机要后三个。中转用 `TerminalCarrierCompat` 把它们合成 `attach`，而 rnh 的 `terminal/attach`
已经把 duplex 流的 uplink 一并转给节点。于是：

```
手机 terminal/follow → 中转 TerminalCarrierCompat → 本机 terminal/attach
                    → rnh 装饰器 → 节点 terminal/attach
```

中转的兼容层**正好落在 rnh 的 attach 上**，这是整条链路能成立的最强证据。

### 2.5 中转服务端部署（2026-11-18 实测）

| 项 | 实测值 |
|---|---|
| 镜像 | `ghcr.io/liguobao/ds-harness-remote/server:latest`（构建于 2026-11-15T15:39Z） |
| 容器内版本 | `@dsh-remote/server` **0.5.21**（镜像 tag 是 `latest`，会漂） |
| 网络模式 | relay-only：`STUN_URLS` / `TURN_URLS` 全空，无 P2P 直连 |
| 已注册设备 | 5 个（桌面 host、桌面 client、安卓 client ×2、DSH App Android ×1 已 revoke） |

**待办：版本钉住。** `latest` 会在上游发版时静默变化，而 DSH Go 是安装版、不可能跟着升。
改成显式 tag（当前 `0.5.21`），升级前先看上游 `docs/compatibility.zh.md` 的 peer range。

## 三、被否方案

### A. 「不改 DSH Go」的硬边界怎么处理

源码核实后**真正做不到的只有 1 项**：

| 能力 | 为什么做不到 |
|---|---|
| 手机上**新建**目录 | `directoryPicker/createDirectory` 不在 allowlist；`workspaces_api.dart` 的 `canCreateDirectories` 在 relay 上恒为 false，UI 直接隐藏入口 |

早前列为硬边界的三项都是**误判**，源码核实后不成立：

- **节点专属模型目录**：provisioning 把桌面的 `llm-*` 行复制成节点自己的 patch overlay，两侧名册
  同源，手机看到的就是节点真在用的模型。真正要补的是 `session/selectModel`（请求里带
  `sessionId`），已路由。
- **`agentTeams/setEnabled`**：手机的开关走的是 **bundle 开关** `pluginManager/setBundleEnabled`，
  读 `session/projections` 里的 `agentTeam` 快照，两者都已处理。
- **`schedule/update`**：手机在 0.2.2 上根本不走它（`create` 总会写 target，于是
  `usesTargetProtocol` 恒为 true，手机调的是 `schedule/edit`），上游也没有这个端点。

可选方向有三个：接受现状 / 把 A 类端点补上路由 / 允许给 DSH Go 打最小 patch。
**已按第二个执行**：路由清单与断言见 ARCHITECTURE §五，离线层 `routing-extra-unit.mjs`
逐形状断言，端到端在 `host-routing.mjs` 里对真节点核对。

### B. 中转插件 fork 与否

**用户已定：fork，只做研究用途。** 但当前**不需要 fork**：原本以为只能在 fork 里修的那处
（幽灵目录），换一个路径形式（`/@rnh` 命名空间）就落进了 rnh 能管的位置。
只 fork 插件、不动服务端（服务端用官方镜像 + 钉版本）。

### C. 是否同时支持「手机直连节点」

**用户已明确：不需要。** 保持「手机只能经桌面 Host 进入」这一条路径，节点上不装中转 host。
好处是手机上只有一个 Host 条目，看到的永远是混排后的统一视图。

### D. 安卓端要不要从 DSH Go 拆一份

**不建议拆。** DSH Go 已经在说这个协议且 allowlist 100% 覆盖；拆一份 Flutter 代码（`app/lib`
1143 个 dart 文件、421 MB 仓库）维护成本远高于复用。DSH Go 是 AGPL-3.0，`ASSETS.md` 明确要求
修改版再发布时换掉名称与素材 —— 拆出来必然要重做品牌。复用不损失能力：手机上缺的那些，根源是
allowlist 边界，**拆一份自己的客户端才有意义**，而不是为了「能用」。

只有一种情况需要拆：用户要自己的品牌客户端。那是独立项目，不在本 ADR 范围。

## 四、实施顺序（当时的计划，已完成）

| 序 | 事项 | 验收 |
|---|---|---|
| P0-1 | 验证地基：中转 host 与 rnh 共存于同一个 profile | 中转 dispatch 的 `session/list` 经过 rnh 装饰器 |
| P0-2 | DSH Go 真机连到这台 Host，读侧栏 | 手机同时看到桌面本地工区与节点工区 |
| P0-3 | 手机在节点会话下发一条真指令 | 节点真执行；独立 SSH 读到产物字节 |
| P0-4 | 手机的审批卡从节点到达 | 节点触发审批 → 手机弹卡 → 答复 → 节点继续 |
| P0-5 | 手机的终端连到节点 PTY | 四跳接力 → 在节点 shell 里 `hostname` 得到节点名字 |
| P1-1 | 在 rnh 里消掉 `ensureHostWorkspaceDirectory` 的 Windows 误伤 | 手机建工区后桌面 `\@rnh` 不存在；节点上出现该工区 |
| P1-2 | rnh 路由 A 类端点 | 每条一个断言；离线层 `routing-extra-unit.mjs`，端到端 `host-routing.mjs` |
| P2-1 | 中转服务端版本钉住 | 镜像 tag 不再是 `latest`；重启后 DSH Go 仍能连 |
| P2-2 | 失败可解释 | 停掉节点时手机得到的文案指向「节点离线」而不是协议错误 |

P0 全部通过之前不写实现代码 —— 地基不成立的话，后面的修正都是白做。P0-4/P0-5 升到 P0，
因为它们是「手机能不能真用」的分水岭：源码上已确认链路通，但**没跑过就不算过**。
