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

DSH Go 的 allowlist 是客户端里的 `const Set`。不在那 99 条里的端点，手机连发都不会发，
**Host 侧无论怎么改都到不了手机**。因此给手机加能力只有两条路：

- 用**已有的 99 个端点承载新语义**（例如 `workspace/create` 在 Host 侧本来就有 `mkdir -p`
  语义，可以顺带承担「手机上建目录」）；
- 或者放弃这个能力。

这也直接否定了一条看似合理的投入：**扩中转插件的 allowlist 对手机端无效**。用户界面调不到
的端点，放宽 Host 白名单没有意义。这条要写在这里，避免后续有人把时间花在错的地方。

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
     在 dispatch 之前执行 `mkdir(path, {recursive:true})`，而 `path.isAbsolute('/root/foo')` 在
     win32 上为真（指向当前盘根）。手机在节点工区里手输 `/root/foo` 建工区 → 桌面 D 盘真的多出
     `\root\foo` → 之后 fleet 才把请求路由到节点。功能看着正常，磁盘被污染。
   - **`directoryPicker/list` 没被 fleet 路由**（下节）。手机在节点工区里浏览目录，看到的是桌面磁盘。
   - **失败要能解释。** 中转插件的错误原样透传，`WORKSPACE_PATH_DENIED` 之类对手机用户没有意义。
3. **是否 fork 成自有包**：见 §六 待决项 B。

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
| P0-1 | **验证地基：中转 host 与 fleet 共存于同一个 profile** | 同一个 Host 里两个插件都激活；中转 dispatch 的 `session/list` 经过 fleet 装饰器（日志/返回值里能看到节点行） |
| P0-2 | 用 DSH Go 真机（或模拟器）连到这台 Host，读侧栏 | 手机工区列表里**同时**有桌面本地工区和节点工区；打开节点会话能看到历史 |
| P0-3 | 手机在节点会话下发一条真指令 | 节点真的执行；独立 SSH 读到产物字节 |
| P1-1 | 修 `ensureHostWorkspaceDirectory` 的 Windows 误伤 | 手机手输一个节点路径建工区，桌面磁盘**不**出现同名目录；节点上出现该工区 |
| P1-2 | fleet 路由 `directoryPicker/list` | 手机在节点工区浏览目录，列的是节点磁盘；桌面本地工区仍列本机 |
| P2-1 | 中转服务端版本钉住 | `docker inspect` 的镜像 tag 不再是 `latest`；重启后 DSH Go 仍能连 |
| P2-2 | 失败可解释 | 故意停掉节点，手机端得到的文案能指向「节点离线」而不是协议错误 |

P0 全部通过之前不写实现代码 —— 地基不成立的话，后面的修正都是白做。

## 六、待决项（需要用户选择）

### A. 「不改 DSH Go」的硬边界怎么处理

不改手机的代价是有些能力手机上**永远**没有（不是没做好，是物理上到不了）：

| 能力 | 为什么手机上没有 |
|---|---|
| 智能体协作开关 | `agentTeams/setEnabled` 不在 DSH Go 的 allowlist 里；它只读 `session/projections` 里的 `agentTeam` 快照 |
| 在节点上新建文件夹 | `directoryPicker/createDirectory` 不在 DSH Go 的隧道 allowlist 里（只有 `list`） |
| 节点上浏览目录 | fleet 未路由 `directoryPicker/list`；**这条可以修**（P1-2） |
| 节点模型目录 | `session/modelCatalog` 按设计保持本地；手机上会给节点会话列出桌面的模型 |
| goals / commands / skills 列表 | fleet 未路由；手机会拿到桌面的答案 |

可选方向：

1. **接受现状**，把上表写进使用说明。手机定位为「发指令、看结果、答审批」，不做配置管理。
2. **只在 fleet 侧能修的修**（P1-2、模型目录路由），需要动 DSH Go 的保持不做。
3. **允许给 DSH Go 打最小 patch**（比如只加 allowlist 几条），代价是要自己维护一份 Flutter 构建。

推荐 **2**。

### B. 中转插件 fork 与否

| 方案 | 代价 | 风险 |
|---|---|---|
| 保持官方 `ds-harness-remote@0.6.5`，把 Host 侧修正全放进 fleet | 不改第三方代码；但 §4.3 里三条属于中转插件的内部行为，fleet 拿不到执行点 | `ensureHostWorkspaceDirectory` 的 Windows 误伤**修不了**，只能靠文档提醒 |
| Fork 成自有包（MIT 允许），只改必要的三处 | 多一个需要跟随上游升级的仓库 | 上游改协议时要做合并 |

推荐 **fork**，但只 fork 插件、不动服务端（服务端协议无关，用官方镜像 + 钉版本即可）。

### C. 是否同时支持「手机直连节点」

节点上也能装中转 host（Linux、Node 22、有 `@roamhq/wrtc` 原生包），手机就能在**桌面不开机**时
直接连节点。代价是手机上多一个 Host 条目，而且看到的是节点原生工区（没有 fleet 混排）。

这不在用户描述的流程里，但成本很低。默认**不做**，留作可选。

