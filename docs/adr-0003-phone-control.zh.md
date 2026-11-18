# ADR-0003 手机控制：DSH Go → 中转 → 桌面 Host → 节点大脑

> 状态：提案（2026-11-18）。§一 是路线锚点，后续任何设计都要能对上它；对不上就是偏离。
> 实施前需要用户在 §六 的两个待决项上做出选择。

## 一、目的（路线锚点）

用户原来的工作方式（zcode）：

```
手机浏览器 → 网页版 zcode ──加密通道──> Windows 上的 zcode 客户端 ──SSH──> 开发机
```

四跳。人不在电脑前也能改代码，因为手机操作的是**Windows 那台已经连好开发机的客户端**，
手机自己不知道开发机在哪、也不需要开发机开端口。

要在 DSH 上搬同一套流程，等价形态是：

```
DSH Go（安卓） ──中转──> 桌面 DSH Host（装 dsh-fleet） ──SSH──> 节点大脑（Linux）
```

三条不可让步的约束：

1. **手机端不改 DSH Go。** 用户明确要求尽量不动这个客户端；这同时是下面所有取舍的前提。
2. **桌面那台必须开着且连着节点。** 这是 zcode 方案已有的代价，不是本方案新增的代价。
3. **节点不暴露公网端口、不需要公网 IP。** 与现有 dsh-fleet 的 SSH-only 语义一致。

验收的最终判据是一句话：**人离开电脑，用手机在节点上改代码、看结果、答审批，体验与在桌面端操作节点一致。**

## 二、为什么这条路成立（调研结论）

### 2.1 DSH Go 说的就是 ds-harness-remote 协议

`packages/dsh_remote` 的 pubspec 自述「Pure-Dart client for ds-harness-remote (liguobao, MIT)」，
实现是账号登录 + 设备身份 + Noise IK 加密通道 + WebRTC/中继，并把远端 Host 的 Harness API
包成与本地引擎同一个 `DshClient`。也就是说手机端与中转、与桌面 Host 的协议**已经对齐**。

### 2.2 两份 allowlist 完全对齐（实测，不是推断）

| 来源 | 条数 | 说明 |
|---|---|---|
| DSH Go `tunnel_carrier.dart` 的 `harnessRemoteAllowlist` | 99 | **客户端本地先拒**，不在表里的连发都不发 |
| 中转插件 `HARNESS_REMOTE_ALLOWLIST`（含 terminal 端点） | 111 | Host 侧再拒一次 |

逐条比对的结果：**DSH Go 的 99 条全部在中转的放行集合里**，一条不缺。中转多放行 12 条
（`job/kill`、`pluginManager` 的安装类、`schedule/create` 等），DSH Go 不通过隧道调用它们。

所以「手机能不能调到某个端点」不是协议问题，也不是中转白名单问题，**只取决于 Host 侧有没有
把这个端点的语义接对**。

### 2.3 混排已经做了，手机天然受益

dsh-fleet 把节点行并进 `session/list`、`workspace/follow`、`session/control`、`$events`。
这四个都在放行集合里。于是手机看到的是**一个**工区列表和一个会话列表，节点工区与桌面本地工区
并排 —— 与桌面端看到的完全一致，手机端一行代码都不用改。

### 2.4 手机上「加新能力」的硬边界

DSH Go 的 allowlist 是客户端里的 `const Set`（`tunnel_carrier.dart:24`），强制点只有两处：
unary `call` 之前（`:450`）和 `mux.open` 之前（`:944`）。不在那 99 条里的端点，手机连发都不发，
**Host 侧无论怎么改都到不了手机**。因此给手机加能力只有两条路：

- 用**已有的端点承载新语义**（例如 `workspace/create` 在 Host 侧本来就有 `mkdir -p`
  语义，可以顺带承担「手机上建目录」）；
- 或者放弃这个能力。

这也直接否定了一条看似合理的投入：**扩中转插件的 allowlist 对手机端无效**。用户界面调不到
的端点，放宽 Host 白名单没有意义。这条要写在这里，避免后续有人把时间花在错的地方。

### 2.5 三条链条已经通了（源码级确认，不是推断）

**终端。** 0.2.2-rc.3 的 terminal 控制器**只有** `terminal/attach`（duplex），没有
`follow`/`write`/`resize`。手机在无 uplink 的 carrier 上要后者三个
（`terminal_api.dart:552-562`）。中转插件用 `TerminalCarrierCompat` 把它们合成 `attach`
（`terminal-carrier-compat.ts:133` 原话：「Existing Remote follow/write/resize calls terminate
at the official attach stream」），而 fleet 的 `terminal/attach`（`host/decorators.js:571`）
已经把 duplex 流的 uplink 一并转给节点的 `attach`。于是：

```
手机 terminal/follow → 中转 TerminalCarrierCompat → 本机 terminal/attach
                    → fleet 装饰器 → 节点 terminal/attach
```

四跳接力，fleet 这一环已实现并有测试。**这是整条链路能成立的最强证据** —— 中转的兼容层
正好落在 fleet 的 attach 上。

**审批与提问。** 节点 `approval/request` 作为 waterfall 从节点的 `$events` 出来 → fleet 的
`remote-events.js` 在本机 `pendingRemoteEvents` 里造 pending → 本机 `ctx.emit` →
`api-remotes` 转发 → 本机 `$events` 流。手机经中转连上后开 `$events`，
`api-gateway/lib/index.js:1042` 的 `answers: peer.principal.kind === "owner"` 为真，收到帧；
手机 `respondApproval` 走 `$events/result`，正中 fleet 手工插的那条 pending，结算节点 waterfall。
`remote-waterfall.js:220` 的「无活 owner client 就回 next」保护在手机连上时不触发。

**混排。** 见 §2.3。

## 三、形态

```
┌─ 手机 · DSH Go（不动）──────────────────────────────────────┐
│  中转 Host 列表 → 选中「我的电脑」→ 加密通道                 │
└───────────────────────┬─────────────────────────────────────┘
                        │ WSS（端到端加密，中转只转发密文）
┌───────────────────────▼─────────────────────────────────────┐
│ 中转 Server（自建于 192.168.3.91，公网 dsh.greatbaby.cc.cd） │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│ 桌面 Windows · DSH Host（desktop profile）                   │
│   ds-harness-remote (role=host)  ← 中转这一端的接入点        │
│   dsh-fleet                      ← 混排节点、按身份路由       │
│     实例上覆写 session/list、workspace/follow、session/follow │
│     等；两者共用同一个 typertGateway                          │
└───────────────────────┬─────────────────────────────────────┘
                        │ SSH :22
┌───────────────────────▼─────────────────────────────────────┐
│ 节点 Linux · dsh-fleet-brain（已有）                          │
└─────────────────────────────────────────────────────────────┘
```

**关键接缝**：中转插件的 `harness.remote.call` 最终走 `gateway.dispatch(endpoint, payload)`，
而 dsh-fleet 的装饰器装的是 **service 实例的 own property**，Gateway dispatch 用
`Reflect.get` 取值。所以中转的每一次调用都会**先经过 fleet 的装饰器** —— 混排与路由对手机
自动生效，两个插件不需要互相知道对方存在。这条是整条链路能成立的技术根据，也是第一个要实测的
（§五 P0-1）。

## 四、四个交付物

### 4.1 本地大脑操纵远程大脑（已完成）

`packages/dsh-fleet` + `packages/dsh-fleet-brain`。桌面端只做身份编码、转发、合并、还原；
大脑在节点。见 ARCHITECTURE。

### 4.2 远程大脑客户端（已完成，但手机侧覆盖面要核实）

桌面端 client 已覆盖工作区、会话、文件、终端、审批。手机端是 DSH Go 自己的 UI，走同一批端点。

### 4.3 中转：自建服务端 + 适配插件（本轮主要工作量）

**服务端现状（2026-11-18 实测 192.168.3.91）**：

| 项 | 实测值 |
|---|---|
| 容器 | `server-server-1`，镜像 `ghcr.io/liguobao/ds-harness-remote/server:latest`，构建于 2026-11-15T15:39Z |
| 容器内版本 | `@dsh-remote/server` **0.5.21**（镜像 tag 是 `latest`，会漂） |
| 前置 | `server-proxy-1`（`nginx:alpine`），`:6703 → 80`；nginx 把 `Origin` 归一化成公网域名 |
| 公网地址 | `DSH_SERVER_PUBLIC_URL=https://dsh.greatbaby.cc.cd` |
| 网络模式 | relay-only：`STUN_URLS` / `TURN_URLS` 全空，无 P2P 直连 |
| 部署目录 | `/root/dsh-deploy/server/{compose.yaml,nginx.conf,.env}`，数据卷 `server-data` |
| 已注册设备 | 5 个：桌面 host、桌面 client、安卓 client ×2、DSH App Android ×1（后者已 revoke） |
| 账号 | 单账号（.env 里配置，不记录在本仓库） |

要做的事：

1. **版本钉住**。`latest` 会在上游发版时静默变化，而客户端（DSH Go）是安装版、不可能跟着升。
   改成显式 tag（当前 `0.5.21`），并在升级前先看上游 `docs/compatibility.zh.md` 的 peer range。
2. **适配插件**。理由不是扩白名单（见 §2.4），而是 Host 侧的语义正确性，至少三条：
   - **`workspace/create` 会在 Windows 上造出垃圾目录。** 中转插件的 `ensureHostWorkspaceDirectory`
     在 dispatch 之前执行 `mkdir(path, {recursive:true})`。win32 实测：
     `isAbsolute('/root/foo') → true`、`resolve('/root/foo') → D:\root\foo`、
     `parse('/root/foo').root → '/'`，所以那道「非根目录」的检查拦不住。手机在节点工区里手输
     `/root/foo` 建工区 → 桌面 D 盘真的多出 `\root\foo` → 之后 fleet 才把请求路由到节点。
     功能看着正常，磁盘被污染。**只能在 fork 里修**，因为这段代码在 dispatch 之前，
     fleet 的装饰器还没被调到。
   - **`directoryPicker/list` 没被 fleet 路由**（下节）。手机在节点工区里浏览目录，看到的是桌面磁盘。
   - **失败要能解释。** 中转插件的错误原样透传，`WORKSPACE_PATH_DENIED` 之类对手机用户没有意义。
3. **是否 fork 成自有包**：见 §六 待决项 B。用户已定：**fork 研究**。

### 4.4 安卓端（结论：不拆 DSH Go）

用户最初的设想是「安卓端 app 直接从 DSH Go 上拆」。调研后**不建议拆**：

- DSH Go 已经在说这个协议，且 allowlist 100% 覆盖（§2.2）；拆一份 Flutter 代码（`app/lib` 1143
  个 dart 文件、421 MB 仓库）维护成本远高于复用；
- DSH Go 是 AGPL-3.0，`ASSETS.md` 明确要求修改版再发布时换掉名称与素材 —— 拆出来必然要重做品牌；
- 复用不损失能力：手机上缺的那些，根源是 DSH Go 的 allowlist 边界（§2.4），**拆一份自己的
  客户端才有意义**，而不是为了「能用」。

只有一种情况需要拆：用户要自己的品牌客户端。那是独立项目，不在本 ADR 范围。

## 五、实施顺序（每步都有可证伪的验收）

| 序 | 事项 | 验收 |
|---|---|---|
| P0-1 | **验证地基：中转 host 与 fleet 共存于同一个 profile** | 同一个 Host 里两个插件都激活；中转 dispatch 的 `session/list` 经过 fleet 装饰器（返回值里能看到节点行） |
| P0-2 | 用 DSH Go 真机（或模拟器）连到这台 Host，读侧栏 | 手机工区列表里**同时**有桌面本地工区和节点工区；打开节点会话能看到历史 |
| P0-3 | 手机在节点会话下发一条真指令 | 节点真的执行；独立 SSH 读到产物字节 |
| P0-4 | 手机的审批卡从节点到达 | 节点触发审批 → 手机弹出卡片 → 答复 → 节点继续 |
| P0-5 | 手机的终端连到节点 PTY | 手机开终端 → 四跳接力 → 在节点 shell 里 `hostname` 得到节点的名字 |
| P1-1 | fork 中转插件，修 `ensureHostWorkspaceDirectory` 的 Windows 误伤 | 手机手输 `/root/x` 建工区，桌面磁盘**不**出现 `\root\x`；节点上出现该工区 |
| P1-2 | fleet 路由 A 类 22 条（按 §2.2 表） | 每条一个断言：手机拿到的是节点答案，不是桌面答案 |
| P2-1 | 中转服务端版本钉住 | `docker inspect` 的镜像 tag 不再是 `latest`；重启后 DSH Go 仍能连 |
| P2-2 | 失败可解释 | 故意停掉节点，手机端得到的文案能指向「节点离线」而不是协议错误 |

P0 全部通过之前不写实现代码 —— 地基不成立的话，后面的修正都是白做。
P0-4/P0-5 之所以升到 P0：它们是「手机能不能真用」的分水岭，源码上已确认链路通（§2.5），
但**没跑过就不算过**。

## 六、待决项（需要用户选择）

### A. 「不改 DSH Go」的硬边界怎么处理

**源码核实后的准确清单**（不是猜的，见 .scratch/research/FINDINGS.md）：

真正做不到的只有 **2 项**：

| 能力 | 为什么做不到 |
|---|---|
| 手机上**新建**目录 | `directoryPicker/createDirectory` 不在 DSH Go 的 allowlist；`workspaces_api.dart:115` 的 `canCreateDirectories` 在 relay 上恒为 false，UI 直接隐藏入口 |
| 节点专属**模型目录** | `session/modelCatalog` 的上游 descriptor 无身份参数（`parameters: []`），且 fleet 已注释决定保持本地；手机给节点会话列的是桌面模型 |

**可以修、只是还没接的（22 条，属于 A 类）**：goals 六个、messageFeedback 三个、
`subagents/{prompt,interruptByParent}`、`commands/execute`、`fileReferences/list`、
`sessionReferenceResolver/candidates`、`schedule/{catalog,history,update,delete}`、
`directoryPicker/list`、`pluginInventory/list`、`userQuestions/{answer,attachWait}`。

**应当保持本地（18 条）**：`agentPresets/*`、`credentials/*`、`llm/listProviders`、
`permissionPresets/catalog`、`pluginManager/*`、`settings/*`、`skills/list`、`officeToPdf/render` ——
它们描述的是**这台桌面安装**，路由到节点反而是错的。

**智能体协作不需要 `agentTeams/setEnabled`。** 早前担心它是硬边界，源码核实后是误判：
手机端的开关走的是 **bundle 开关** `pluginManager/setBundleEnabled`（`installed_plugins.dart:420`、
`agents_state.dart:285` 的 `agentTeamBundleProvider`），读的是 `session/projections` 里的
`agentTeam` 快照。这俩都在 allowlist 里、也都已路由/应保持本地。手机团队页读成员消息用的是
`session/follow` 快照（`agents_state.dart:420` 的 `_recentEvents`），也已路由。

可选方向：

1. **接受现状**，把上表写进使用说明。手机定位为「发指令、看结果、答审批」，不做配置管理。
2. **把 A 类 22 条补上路由**（其中有几条与桌面端共用的验收脚本可以直接复用），
   模型目录单独讨论。需要动 DSH Go 的保持不做。
3. **允许给 DSH Go 打最小 patch**，代价是要自己维护一份 Flutter 构建。

推荐 **2**。

### B. 中转插件 fork 与否

**用户已定：fork，只做研究用途。**

| 方案 | 代价 | 风险 |
|---|---|---|
| 保持官方 `ds-harness-remote@0.6.5`，把 Host 侧修正全放进 fleet | 不改第三方代码；但 §4.3 里三条属于中转插件的内部行为，fleet 拿不到执行点 | `ensureHostWorkspaceDirectory` 的 Windows 误伤**修不了**，只能靠文档提醒 |
| Fork 成自有包（MIT 允许），只改必要的三处 | 多一个需要跟随上游升级的仓库 | 上游改协议时要做合并 |

只 fork 插件、不动服务端（服务端协议与实现无关，用官方镜像 + 钉版本即可）。

### C. 是否同时支持「手机直连节点」

**用户已明确：不需要。** 保持「手机只能经桌面 Host 进入」这一条路径，节点上不装中转 host。
好处是手机上只有一个 Host 条目，看到的永远是混排后的统一视图。

## 七、调研方式（可复现）

两份源码都是拉下来读的，不是靠文档推断：

```powershell
git -c http.proxy= -c https.proxy= clone --depth 1 `
  https://git.yylx.win/https://github.com/liguobao/ds-harness-remote.git .scratch/research/remote
git -c http.proxy= -c https.proxy= clone --depth 1 `
  https://git.yylx.win/https://github.com/ccch1mneyyy/dsh-go.git .scratch/research/dshgo
```

关键文件：

| 文件 | 读它做什么 |
|---|---|
| `dshgo/packages/dsh_remote/lib/src/carrier/tunnel_carrier.dart` | 手机的 allowlist 与强制点 |
| `dshgo/packages/dsh_client/lib/src/carrier.dart` | `allowsEndpoint` 契约 |
| `dshgo/packages/dsh_client/lib/src/workspaces_api.dart` | `canCreateDirectories` 为什么在 relay 上恒 false |
| `remote/packages/plugin/src/harness-remote-bridge.ts:114` | 中转的 allowlist |
| `remote/packages/plugin/src/remote-directory-browser.js` | Windows 误伤那一处 |
| `remote/packages/plugin/src/terminal-carrier-compat.ts` | 终端四跳接力的中间那一跳 |
| `dshgo/app/lib/state/agents_state.dart` / `ui/agents/team_page.dart` | 手机「智能体协作」真正走 bundle 开关 |

完整证据与逐条比对在 `.scratch/research/FINDINGS.md`（不进版本管理）。

