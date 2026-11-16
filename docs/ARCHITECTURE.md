# DSH 远程节点插件 · 架构（v0.2）

> 目标：让远程 Linux 机器上的工作区**在本地桌面端里像本地工作区一样使用**，同时顺便解决 `@artenx/dshb` 的痛点 —— **工具不可用**（grep/glob、git、read_image 在远程失效）。
>
> 参考实现：`zai-org/ZCode`。它远控好用的根本原因是**远端有大脑**：本地不发每条指令，只连过去用。本插件走同一条路。

---

## 一、结论先行

**大脑留在节点上。** 每台机器跑一个完整的 DSH Host，`bash`、`grep`、`glob`、`git`、`read_image`、PTY、MCP 服务器、skills 全部在**那台机器自己的进程里**执行，用它的文件系统、它的二进制、它的 shell。本地只是**调度者**。

这不是"本地发指令、远端执行"的代理模型。代理模型有四个绕不过去的硬缺口，全部被本方案避开：

| 代理模型的缺口 | 证据 | 本方案 |
|---|---|---|
| MCP 服务器在**本机** spawn | `dsh-mcp-client/src/transport.ts` 用 MCP SDK 直连，不经 `ctx.subprocess`，无法重定向 | 远端 Host 自己 spawn 它自己的 MCP |
| skills 用 `node:fs` 扫**本机** | 各 skill 目录由本地进程枚举 | 远端 Host 扫它自己的 |
| bash/pwsh 方言按 `process.platform` 二选一 | 本地 Windows 会选 pwsh，转发到 Linux 必然 127 | 远端 Host 是 Linux，自然选 bash |
| 沙箱无法延伸到远端 | 本地 `DSH_PERMISSION_MODE` 管的是本地进程 | 远端 Host 用自己的权限模式 |

前三条正是 `dshb` 报 `code=127` / 工具找不到的根因；靠路径翻译、argv 改写、可执行文件解析去补，是补不完的。

**然后是混排。** 远程 Host 的会话与工作区必须作为**真实的行**出现在本地 Host 的 `session/list` 与 `workspace/follow` 里 —— 不是新开一个面板、也不是 iframe 另一个页面。理由有二：

1. 这样桌面端的侧栏、会话视图、文件查看器、审批、终端、job、goal 全部照常工作，因为它们看的本来就是这两个接口；
2. `ds-harness-remote` v0.6.5（P2P 端到端加密远控）的白名单里就是 `session/list` / `session/follow` / `session/prompt` / `session/page` / `workspace/follow` / `workspaceFiles/*`。本地网关多返回远程行，手机端就自然读得到，**它一行都不用改**。

---

## 二、形态

```
┌────────────────────── 本地 Windows · DSH Desktop ──────────────────────┐
│  Electron 窗口 (dsh-app://app/)                                        │
│    └─ 本地 Host 进程 (dsh --profile desktop)                           │
│         ├─ 官方 /api、/api/remote.mux    ← 原样不动                    │
│         │     └─ 本插件在**实例**上覆写若干方法：                       │
│         │        session/list、workspace/follow、session/follow …      │
│         │        → 本地行 + 每个已连接节点的行                          │
│         ├─ typert.lookups('workspaceFileScope')  ← 覆写，保留 delegate  │
│         └─ /fleet/api                    ← 节点管理 + 按路径加工作区    │
└────────────────────────────────────────────────────────────────────────┘
                              │ SSH :22（唯一入口，不开放端口）
                              ▼
┌──────────────────── 远端 Linux · 常驻大脑 ─────────────────────────────┐
│  ~/.dsh-fleet/runtime/node_modules/@deepseek-ai/dsh                    │
│    └─ dsh --profile web --host 127.0.0.1 --port 0 --no-open            │
│         ├─ 完整 DSH Host：rg / git / read_image / bash / PTY 原生执行   │
│         └─ 会话、工作区、审批、终端全部在远端，本地不复制                │
│  ~/.dsh-fleet/run/{status.json, pid, host.log}                         │
└────────────────────────────────────────────────────────────────────────┘
```

本地与节点之间只有**一条 SSH 连接**，上面同时跑 HTTP 与 WebSocket：`ssh2` 的 `forwardOut` 开一条 `direct-tcpip`，之后手写 HTTP/1.1 与 RFC 6455 都骑在这条字节流上。节点的 Host 只监听它自己的 loopback。

---

## 三、三条接入缝隙（各有测试）

插件**不替换任何上游 Loader 行**，也**不从 `app.asar` 里 import 任何东西**。全部接入点都在运行时：

### 缝隙一：实例上的 own property

`@Remote` 装饰器不是静态属性：它走 `context.addInitializer`，per-instance 执行 `mark(Object.getPrototypeOf(this), …)`，写在**类原型**上，key 是字符串 `'@deepseek-ai/dsh-typert-protocol/remote-methods'`。而 Gateway dispatch 走 `Reflect.get(view, name)` —— `receiverContext.extend({ invocation }).get(serviceKey)` 拿到的 view 会**优先读实例 own property**。

于是：在实例上装一个同名 own property，dispatch 命中它，而 discovery（`remoteMethods` / SRC claims）仍然读原型 → **声明面不变，实现换了**。`test/dispatch-seam.mjs` 实证了这点，并验证未标注端点在覆写后依然走原型。

还有一个必须守住的约束：Gateway 用 `Function.prototype.toString` 解析形参名（`methodParameterNames`），所以 overrider 的**形参名必须与上游签名一致**，否则 wire 字段对不上。

### 缝隙二：`typert.lookups.configure('workspaceFileScope', …)`

`workspaceFiles/*` 的第一个参数是 `workspaceFileScopeId`，Host 先用 lookup 把它解析成 `{sessionId, workspaceRoot}`。而 `fleet_<node>_<id>` 不是本地 Session，上游 lookups 会先返回 `not-found`，**根本轮不到装饰器**。

所以覆写这个 lookup：先取回上游 provider 的 resolve 做 delegate，本地 id 原样委托，`fleet_` id 合成 `{sessionId, workspaceRoot:'/'}`。`test/host-routing.mjs` 同时验证了**远程读到节点磁盘**和**本地仍然读到本地磁盘**。

### 缝隙三：SSH `direct-tcpip` 上的 HTTP 与 RFC 6455

`test/gateway-smoke.mjs` 证明 cookie 铸造、unary RPC、流载体 upgrade 都能在一条 SSH channel 上跑通。注意两点，都是自写客户端最容易踩的坑：

- Gateway 每 2 秒 ping 一次（`websocketHeartbeatIntervalMs` 默认 2000），**不应答就断**；
- 带字节的结果**不是 JSON**：Gateway 把每个 `Uint8Array` 换成 `null`、记下它的 JSON 路径，字节另走 `multipart/form-data` 分片。`workspaceFiles/readBytes` 就是这条路 —— 只会 `JSON.parse` 的客户端会拿到一个 `HTTP 200` 但解不开的响应体，很容易误判成"节点坏了"。`src/host/multipart.js` 专门负责还原它在正确的路径上（有 `test/multipart-unit.mjs` 守着）。

---

## 四、身份：一个字符串回答三个问题

远程身份过边界时是 `fleet_<nodeId>_<remoteId>`，例如

```
fleet_n0123456789ab_session-1dc98667-3f1e-4f47-9d5b-2a4e2b3d3f6a
└─ 5+13 字符 ──┘└─ 节点上原本的 session-<uuid> ──────────────┘
```

解出来既知道该发给哪个节点，也知道节点上原本是谁 —— **没有第二张路由表**可以和 UI 里已有的身份失同步。

一条必须遵守的规则：**只有完整匹配 Session 身份形状的字符串才重写**。松散的 `startsWith('session-')` 会把事件**类型** `session-log-deepseek/delivery-accepted` 也改写掉，于是客户端渲染的每一个事件都被静默污染。`test/host-routing.mjs` 有一条专门的断言守这个。

Workspace 身份同理（`fleet_<nodeId>_<workspaceId>`），只是包装点不同（`workspaceId` / `workspaceIds` / `beforeWorkspaceId`）。

---

## 五、路由表

| 命名空间 | 路由 | 说明 |
|---|---|---|
| `session/list`、`search` | **合并** | 本地结果 + 每个可路由节点的结果，节点不可达时跳过而不是整体失败 |
| `session/create` | **路由** | 目标 workspace 是远程的 → 在节点上建 Session（节点上真的有 `~/.dsh/sessions/--root-<dir>--/`） |
| `session/prompt`、`cancel`、`rename`、`fork`、`attachment`、`page`、`events`、`state`、`wait`、`projections`、`selectModel`、`updateQueue` | **路由** | 按 `sessionId` / `address` 找到节点 |
| `session/follow`、`observeEvent`、`observeProjections`、`observeState` | **合并/桥接** | 流方法的第一个位置参数**就是** request 对象本身（不是 `{request}` 包装），转发时按节点形参名 `request` 重新包一层 |
| `workspace/follow` | **合并** | 一条流里同时推送本地 baseline 与每个节点 baseline；之后再串各自增量 |
| `workspace/create` | **按路径路由** | 绝对 POSIX 路径逐节点尝试（节点侧 `realpath` 校验必须通过） |
| `workspace/rename` 等变更 | **按 owner 转发** | 按 workspaceId 找节点 |
| `workspaceFiles/{list,stat,read,…}` | **路由** | 靠缝隙二解析出节点，payload 用 `workspaceFileScopeId` |
| `terminal/list`、`watch` | **路由** | 让侧栏能报告远程 Session 的终端 |
| `terminal/create`、`attach` … | **保持本地** | 形参里是 `Agent` 对象，远程 Session 在本地没有 Agent |
| `session/modelCatalog`、`agentPresets/*`、`settings/*`、`pluginManager/*` | **保持本地** | 描述的是**这个安装**的模型与配置，与节点无关 |

`workspace/create` 的按路径路由有个现实理由：**本地目录选择器只能浏览本机**，永远选不到节点上的 `/root/project`。所以远程工作区从 `/fleet/api/workspaces` 加入（设置页节点行展开后的输入框），它在节点上 `workspace/create`，再把结果包装成本地身份还回来。

---

## 六、包结构

```
D:\ProjectHub\DSHpl\packages\dsh-fleet\
  package.json          dsh.bundle.patch + dsh.client
  cordis.patch.yml      insert: dsh-fleet（单行；不禁用任何上游行）
  src/
    core/               nodes.json 注册表、凭据、HTTP 错误
    ssh/                ssh2 连接池、exec、forwardOut、错误分类
    remote/             远端守护：probe / install / start / verify（含 brain overlay 写入）
    host/
      ssh-http.js       把 SSH channel 当 socket 用，手写 HTTP/1.1
      ws.js             手写 RFC 6455 客户端（应答 ping、帧重组）
      remote-gateway.js cookie 铸造、unary call（401 自动重试一次）、逻辑流
      multipart.js      Gateway 的 multipart 应答解码（字节附件还原）
      provision.js      节点只当大脑：模型行复制、凭据下发、UI 行禁用、overlay 渲染
      routing.js        身份编解码、AsyncQueue、ChangeSignal、own-property 覆写
      router.js         toRemote / toLocal / toLocalWorkspace / call / 流
      remote-workspaces.js  每节点一条 workspace/follow，baseline 缓存与合并
      decorators.js     四个命名空间的路由装饰器
      lookups.js        workspaceFileScope lookup 覆写
      fleet.js          节点运行时状态机（probe → install → provision → start → verify）
    client/client.js    设置页 + 侧栏面板 + 主区页面
  locale/{en,zh}.json
  icon.svg  docs/DETAIL.zh.md  docs/UPGRADE.zh.md  README.md
  test/                  见下
```

### 连接状态机

`probe → install（版本不符才装）→ provision（下发模型与凭据）→ start → verify`。最后一步是必须的：verify 会真的发一次 `session/list`，**只有它成功才报 connected**。少了这一步，"进程起来了但会话通道不通"会伪装成成功。

---

## 六之二、节点侧：让它只当大脑（而不是 fork 一份 DSH）

节点的常驻宿主是一个**独立的 DSH 安装**（`npm i @deepseek-ai/dsh`），有自己的 `~/.dsh`：自己的 profile、自己的凭据库、自己的模型名册。所以新节点能启动、能答 `session/list`，然后**第一句话就失败** —— 那边没有 provider 路由、没有 API key。从桌面端看，这和"路由坏了"长得一模一样。

**为什么不去 fork 源码删掉 UI**：节点上装的是 npm 上的包，不是我们的 checkout。fork 意味着每次官方更新都要手工合一次，而且节点与本机版本从此对不齐 —— 而 Session 日志格式随版本走，版本不一致会以"能连上但会话显示错乱"这种最难查的方式失败。用 `--patch` 达到同样效果，且**升级后自动跟随**。

插件在每次 `connect` 时做三件事，全部通过它自己拥有的文件与节点自己的 Remote API完成，**不改节点的 profile**：

1. **写一份它拥有的 overlay**（`~/.dsh-fleet/run/brain.patch.yml`），在宿主启动**之前**落盘，用 `--patch` 传入。内容是：本机 provider 路由、默认模型、权限预设 —— 从活的 `configEditor.configuration()` 复制，所以它跟着你本地配置走，不需要手抄。
2. **把那些行点名的 key 推进节点的凭据库**：在本机 `credentials.resolve(ref)` 取值，通过节点的 `credentials/set` 写入。节点凭据库优先于它自己的环境变量，所以本机换 key，重连就同步。key 的 ref 不只从 `apiKeyEnv` 取 —— 那字段只有显式设置过才在组合后的 patch 里；没设时用 adapter 自己的默认值（`llm-deepseek-api-key` → `DEEPSEEK_API_KEY`），否则会得到一个"provider 加载成功但没有 key"的节点。
3. **关掉浏览器插件**：每个 `@deepseek-ai/dsh-client-ui-*` 行 `disabled: true`。这份清单是每次连接从**活的组合**现算的，不是写死的，所以升级新增的 UI 插件下次连接就会被丢掉。

overlay 幂等：字节没变就不重启节点宿主。`connect` 会在 `provision` 里报告 `rows` / `disabled` / `refs`。

实测（192.168.3.93）：202 行组合里关掉 56 个 UI 行，宿主常驻内存 375 MB → 331 MB。省的不算多（那些 UI 插件在无头宿主上本来就大半是空转），真正的收益是**少了一批没人浏览的客户端 bundle 和它们的连接状态**，以及节点配置完全由本机驱动。

---

## 七、测试

| 脚本 | 验证什么 | 依赖 |
|---|---|---|
| `routing-unit.mjs` | 身份往返、流扇出、工作区合并、本地调用直达上游 | 无（假 fleet） |
| `gateway-smoke.mjs` | SSH 上的 cookie、unary RPC、流载体 upgrade | 真实节点 |
| `descriptor-smoke.mjs` | 上游包的 descriptor 与 `static inject` 可从 `app.asar` 读到 | Electron Node |
| `dispatch-seam.mjs` | Gateway 的 view 会读取实例 own property；声明端点集不变 | Electron Node |
| `upstream-smoke.mjs` | 上游控制器的 `static inject` 与导出可用 | Electron Node |
| `host-routing.mjs` | **每个**路由端点走本地 `/api`，以及该保持本地的端点仍然本地；含一次**二进制**读取（远端图片预览靠它） | 运行中的 Host + 已连接节点 |
| `workspace-flow.mjs` | 端到端手势：按路径加远程工作区 → 在里面建 Session → 发消息 → 节点 bash 真跑 → 文件真出现在节点磁盘 → 会话归入工作区 → 出现在 `session/list` 且 cwd 是节点绝对路径 | 同上 |
| `tool-parity.mjs` | 镜像方案过不了的那一关：agent 自己的 `read`/`write`/`edit`/`grep`/`glob` 打的是节点真实路径，没有路径类失败，整份 transcript 里没有 Windows 路径 | 同上 |
| `tool-git-image.mjs` | `git` 打真仓库、`read_image` 开真 PNG、`grep` 搜真文件 —— 三个在"工具在本地跑、只是对着镜像"时必然坏掉的工具 | 同上 |
| `multipart-unit.mjs` | Gateway 的 `multipart/form-data` 应答能解：字节附件在正确的 JSON 路径上还原成 `Uint8Array`，畸形分片被拒绝而不是静默读成 `null` | 无 |
| `provision-unit.mjs` | 下发给节点的东西是对的：provider 行复制而账号行不复制、行里没写 `apiKeyEnv` 时也能推断出 key ref、只禁用浏览器行、overlay 能过真 YAML 解析器 | Electron Node（解析器在 `app.asar` 里） |
| `client-bundle.mjs` | 桌面端真的 serve 了这份客户端代码；三个槽位注册且能渲染 | 运行中的 Host |

升级 DSH 之后该按什么顺序重跑、每个测试守的是哪条上游契约，见 [`packages/dsh-fleet/docs/UPGRADE.zh.md`](../packages/dsh-fleet/docs/UPGRADE.zh.md)。

`test/carrier.mjs` 是被后四个共用的最小测试客户端，含一条硬要求：**必须应答 Gateway 的 2 秒 ping**，否则两秒后流被静默关闭 —— 这会让路由 bug 伪装成传输 bug。

---

## 八、明确不做的事

- **不改 Electron 主进程**：窗口只连本地 Host 这条约束不动。
- **不接管 `/api` 或 `/api/remote.mux`**：它们已被 gateway 独占，`registerFallback` 也已被 static 占走。
- **不做本地镜像目录**：工作区路径就是节点上的真实路径。这正是工具能用的原因 —— 见下一节。
- **不碰上游 Loader 行**：`cordis.patch.yml` 只有一条 `insert`。
- **不 fork 任何上游包**。

---

## 九、为什么"不做镜像"是功能而不是省略

`@artenx/dshb` 的做法是把远端目录镜像到本地（`%USERPROFILE%\.dsh\dshb\mirrors\<node>\<path>`），然后把每条指令发过去执行。镜像带来的不是性能问题，是**工具不可用**：

| 现象 | 镜像下的原因 |
|---|---|
| `rg` / `git` / `python3` 报 `code=127` | 命令解析用的是**本机**的 PATH |
| `read` / `write` / `edit` 报 `ENOENT` | 这三个工具是本地 `node:fs` 调用，锚在 Session cwd 上，而那个 cwd 是个只在本机存在的镜像路径 |
| `read_image` 打不开远端截图 | 字节是从只在本机存在的路径读的 |
| `grep` / `glob` 漏掉远端文件 | 走的是镜像，不是节点 |
| MCP 服务器、skills、`bash` vs `pwsh` | 全部按本地进程解析 |

远端大脑把这一整类问题**消掉**而不是修好：工具就是节点的工具。

所以 `test/tool-parity.mjs` 的断言不是"命令跑通了"，而是：

- agent 自己的 `read`/`write`/`edit`/`grep`/`glob`/`bash` **每一个都被真的调用**（全部退化成 bash 也算不合格）；
- 没有任何文件工具因为**路径**失败；
- 整份 transcript 里**没有** `dshb/mirrors` 或真实 Windows 路径；
- 写出来的文件在节点上 `cat` 得到，且本地文件 API 读回同一份字节。
