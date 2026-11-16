# DSH 远程节点插件 · 架构（v0.3）

> 目标：让远程 Linux 机器上的工作区**在本地桌面端里像本地工作区一样使用**，同时顺便解决 `@artenx/dshb` 的痛点 —— **工具不可用**（grep/glob、git、read_image 在远程失效）。
>
> 参考实现：`zai-org/ZCode`。它远控好用的根本原因是**远端有大脑**：本地不发每条指令，只连过去用。本插件走同一条路。
>
> 两个包：`packages/dsh-fleet`（插件，装在桌面端）与 `packages/dsh-fleet-brain`（节点侧的 DSH 组合，只当大脑）。

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
| `session/control` | **合并** | Host 级、每连接一条，不是按 Session 路由：本地流 + 每个节点的投影块，并成一帧 baseline 再串增量 |
| `$events`（网关自有端点） | **中继** | 节点的 `api-session/*` 事件重新在本机 emit，身份包成本地形式；同一流上的 waterfall 用 `next` 答掉 |
| `workspace/follow` | **合并** | 一条流里同时推送本地 baseline 与每个节点 baseline；之后再串各自增量 |
| `workspace/create` | **按路径路由** | 绝对 POSIX 路径逐节点尝试（节点侧 `realpath` 校验必须通过） |
| `workspace/rename` 等变更 | **按 owner 转发** | 按 workspaceId 找节点 |
| `workspaceFiles/{list,stat,read,…}` | **路由** | 靠缝隙二解析出节点，payload 用 `workspaceFileScopeId` |
| `job/list`、`follow`、`kill` | **路由** | 按 Session id 找节点；`follow` 的 `sessionId` 是可选的（无主 job 谁都能看），没有它就不猜节点 |
| `terminal/list`、`watch` | **路由** | 让侧栏能报告远程 Session 的终端 |
| `terminal/create`、`attach` … | **保持本地** | 形参里是 `Agent` 对象，远程 Session 在本地没有 Agent |
| `session/modelCatalog`、`agentPresets/*`、`settings/*`、`pluginManager/*` | **保持本地** | 描述的是**这个安装**的模型与配置，与节点无关 |

`workspace/create` 的按路径路由有个现实理由：**本地目录选择器只能浏览本机**，永远选不到节点上的 `/root/project`。所以远程工作区从 `/fleet/api/workspaces` 加入（设置页节点行展开后的输入框），它在节点上 `workspace/create`，再把结果包装成本地身份还回来。

### 为什么"快照对"不等于"侧栏活"

上面这些合并回答的是**某一刻的状态**。侧栏不是靠快照重建的：上游客户端另有两路活流，本地 Session 天然在流里，远程 Session 不在 —— 只做合并的话，行会"在，但死着"。

| 活流 | 携带什么 | 不中继的症状 |
|---|---|---|
| `$events`（网关自有端点）→ `api-session/added`、`removed`、`status`、`activity`、`error` | 行的新增/消失、运行中的转圈、最近活动时间、agent 错误 | 新建的远程 Session 要等下一次整表拉取才出现；转圈永远不转 |
| `session/control` → 每个 Session 的投影块（`title`、`modelSelection`、`permissions`、`inbox`…） | 标题、选中模型、待处理的审批/提问标记 | 标题停在 "New Session"，节点上改的标题永远追不过来 |

两路都是 **Host 级、每连接一条**，不是按 Session 路由，所以处理方式不是转发而是**并流**：

- `session/control` 由 `RemoteControl` 持有每个节点一条，投影块合成一份 baseline（远程块的身份用本地包裹形式），每个本地消费者各拿一条合并流。**合并后的流只发一帧 baseline**：上游客户端把任何 baseline 都当"这就是全部"，先推远程再推本地会把远程块擦掉 —— 那处 bug 只在读第二帧时暴露，看起来像"远程投影从来没生效"。节点集合变化时用最后一份本地块重折一次再发，等价于上游重连。
- `$events` 由 `RemoteEvents` 每个节点开一条，把闭合白名单里的五个事件用 `Router.toLocal` 包一遍后在本机 `ctx.emit`。上游的 `api-remotes` 本来就会把这些事件转发给每个已连接客户端，所以**浏览器侧一行没改**，远程事件就走本地事件同一条管道。

白名单是闭合的：重发一个本机也会发的事件是安全的（客户端按身份合并），但重发一个需要本机 `Agent` 才能解释的事件不是。`test/event-relay.mjs` 用的判据是"在节点上直接建的 Session" —— 本机没发过那个调用，浏览器听到的一切只可能来自中继。

同一 `$events` 流上还有 `approval/request`、`user-questions/request` 两个 waterfall。它们被 `next` 答掉（节点的默认行为），因为本机没有对应的 Agent 可询问；**不应答的 waterfall 会一直挂着**，那会把远程回合卡死。这是当前真实功能上限：远程会话里的审批不会弹到本地界面。

---

## 六、包结构

```
D:\ProjectHub\DSHpl\
  README.md             仓库说明
  AGENTS.md             协作规则（本项目的硬约束）
  docs/ARCHITECTURE.md  本文档：设计与取舍
  packages/
    dsh-fleet/          插件：Host 侧 + 浏览器侧
    dsh-fleet-brain/    节点侧 bundle：只当大脑的 DSH 组合（生成物 + 生成脚本）
  reference/            上游源码（DSH / ZCode），独立克隆，不进版本库
```

```
packages/dsh-fleet/
  package.json          dsh.bundle.patch + dsh.client
  cordis.patch.yml      insert: dsh-fleet（单行；不禁用任何上游行）
  src/
    core/               nodes.json 注册表、凭据、HTTP 错误
    ssh/                ssh2 连接池、exec、forwardOut、错误分类
    remote/             远端守护：probe / install / 节点 profile / 配置 / start / verify
    host/
      ssh-http.js       把 SSH channel 当 socket 用，手写 HTTP/1.1
      ws.js             手写 RFC 6455 客户端（应答 ping、帧重组）
      remote-gateway.js cookie 铸造、unary call（401 自动重试一次）、逻辑流
      multipart.js      Gateway 的 multipart 应答解码（字节附件还原）
      provision.js      模型行复制、凭据下发、配置渲染
      brain-bundle.generated.js  节点组合（生成物，来自 dsh-fleet-brain）
      routing.js        身份编解码、AsyncQueue、ChangeSignal、own-property 覆写
      router.js         toRemote / toLocal / toLocalWorkspace / call / 流
      remote-workspaces.js  每节点一条 workspace/follow，baseline 缓存与合并
      remote-events.js  每节点一条 $events，把 api-session/* 中继进本机事件总线
      remote-control.js 每节点一条 session/control，投影块并流给每个客户端
      decorators.js     五个命名空间的路由装饰器（session / workspace / workspaceFiles / job / terminal）+ 合并后的 control 流
      lookups.js        workspaceFileScope lookup 覆写
      fleet.js          节点运行时状态机
    client/client.js    设置页 + 侧栏面板 + 主区页面
  locale/{en,zh}.json
  icon.svg  docs/UPGRADE.zh.md  README.md
  test/                  见下
```

```
packages/dsh-fleet-brain/
  package.json          dsh.bundle.patch（含 4 个 preset 层）
  cordis.patch.yml      生成物：98 行 upstream → 60 行大脑组合
  presets/*.yml         原样复制自 upstream
  src/runtime.js        手写：大脑自己的运行时胶水（打印入口 URL、提供 webApp）
  scripts/
    sync-from-upstream.mjs   从已安装 release 派生组合
    check-composition.mjs    断言结果仍然是个大脑
    embed-into-fleet.mjs     把整包嵌进插件
```

### 连接状态机

`probe → install（版本不符才装）→ provision（brain bundle + profile 清单 + 配置）→ start → verify`。最后一步是必须的：verify 会真的发一次 `session/list`，**只有它成功才报 connected**。少了这一步，"进程起来了但会话通道不通"会伪装成成功。

provision 阶段内部顺序也是语义的：**组合先于启动**（profile 必须已经指向 brain bundle）、**配置先于启动**（模型行必须已在盘上）、**凭据晚于启动**（只能通过节点自己的 Remote API 推，需要它已经在应答）。

---

## 六之二、节点侧：源码级定制节点组合

### 问题

节点的常驻宿主是一个**独立的 DSH 安装**（`npm i @deepseek-ai/dsh`），有自己的 `~/.dsh`：自己的 profile、自己的凭据库、自己的模型名册。这带来两件事：

1. **它装的是 web-app 组合**，等于在服务器上加载一整套浏览器插件 —— 56 个 `dsh-client-ui-*` 包、SPA dist 服务、HMR 链、桌面 telemetry。没有窗口的机器上，这些要么空转，要么在缺 dist 时直接报错。
2. **它没有 provider 路由、没有 API key**，所以能启动、能答 `session/list`，然后**第一句话就失败**。从桌面端看，这和"路由坏了"长得一模一样。

### 决定：定制**组合**，不 fork **包**

这是本节的核心取舍，也是本轮否掉前一个方案的原因。

上游发布的 6 个 bundle 是：`base`（核心，无 Host）、`web-app`（核心 + 浏览器面）、`headless`（一次性任务，无 Host/HTTP）、`acp-app`、`sdk-app`、`sdk-minimal`。**没有一个是大脑**：唯一带 Host + HTTP + Remote API 的是 `web-app`，而它同时带着整个浏览器面。

两条路：

| | fork `@deepseek-ai/dsh-*` 源码删 UI | **定制组合层（采用）** |
|---|---|---|
| 节点上装什么 | 自己发布的 fork 包 | 官方包 + 一个本地 bundle |
| 上游升级 | 每次手工 merge，冲突要人判 | `npm i` 换版本即可 |
| 版本对齐 | 节点与本机版本从此可能不一致 | 天然一致（同版本官方包） |
| 删 UI 的彻底程度 | 物理删除 | 组合层不含该行 → **根本不加载** |
| 出问题的样子 | 编译错或运行期缺符号 | 组合缺行 → 启动时明确报 "entry did not activate" |

关键认识：**"删掉"不等于"物理删代码"**。DSH 是 Cordis 组合式架构，一个插件是否存在于运行时完全由 profile 的组合层决定。组合层里没有 `@deepseek-ai/dsh-client-ui-*` 这些行，那些包连 `import` 都不会发生 —— 效果等价于删除，但可逆、可跟随升级。

所以节点侧是一个新包 **`@local/dsh-fleet-brain`**，它是一个合法的 DSH bundle（声明 `dsh.bundle.patch`），内容是 `dsh-web-app` 减去浏览器面。节点 profile 组合：

```
@deepseek-ai/dsh-base + @local/dsh-fleet-brain      ← 现在是这个
@deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app    ← 之前是这个
```

`dsh-web-app` 这一层根本不出现在组合里，不是"加载后再 disable"。

### 怎么减：从**已安装的 release** 派生，不是从 master

98 行的 upstream patch 手抄会腐。所以 `packages/dsh-fleet-brain/scripts/sync-from-upstream.mjs` 做这个减法并生成 patch：

- **keep**：全部 host-plane 行 —— Remote 控制器（session/workspace/workspaceFiles/job/terminal/settings）、传输层（webserver、`/api`、launch token）、服务（workspace、schedule、mcp-manager、agent-preset-registry）、`web-startup`。
- **drop**：全部 `@deepseek-ai/dsh-client-ui-*` 包的行（节点没有窗口；按**包名**判断，共 56 行 —— 其中 `entry-customization` 的 id 不以 `ui-` 开头，只按 id 前缀过滤会漏掉它），加 9 个浏览器专属行，每个在脚本里写明理由：

  | 行 | 为什么大脑不要 |
  |---|---|
  | `web-runtime` | 挂 SPA dist、开桌面浏览器 —— 换成 `brain-runtime` |
  | `modules` | 组装 `window.__DSH_BOOT__`、serve `/plugins/*/client.js` |
  | `client-hmr` | 浏览器热更链 |
  | `harness-dev-context` | 提示词里写"你正在扩展这个 GUI" —— 没有 GUI |
  | `directory-picker` | 在节点的屏幕上弹原生目录框 |
  | `open-in-app` | 在节点上启动桌面应用 |
  | `session-log-download` | 浏览器下载对话框 |
  | `product-analytics` / `desktop-product-telemetry` | 桌面端遥测 |

- **公式化的两条**（不手抄，从上游读）：`system-prompt` 与 `session-query-sqlite` 两个 surface 值；以及 agent plane 的 22 条 `disabled: true`（大脑的 Session 和桌面一样通过 preset 挂工具，所以基础层的工具行必须同样让位）。后者是**真的 disable**，因为它指向的行都在 `dsh-base` 里存在 —— 与"disable 一个不存在的 UI 行"性质不同。

**为什么必须从已安装的 release 派生**：第一版从 master 生成，多出了一行 `authentication-token`。而 `0.2.2-rc.3` 根本没有发布 `dsh-host-authentication-token` 这个包，节点启动报 `1 entry did not activate: Cannot find package '@deepseek-ai/dsh-host-authentication-token'`。master 领先于发布版，组合必须描述它要**启动进去的那个运行时**。现在脚本默认读 `DSH_INSTALL_DIR`（已安装），checkout 只作为对照手段。

### 大脑自己的运行时胶水

`web-runtime` 被拿掉后，少了两件事，而它们都直接影响插件能否连上：

1. **打印入口 URL** —— 插件**解析端口和 launch token 的唯一来源**。
2. **认领 index fallback 座位** —— cookie 交换发生在这里。`/?token=…` 由 `connection.authorizeIndex` 换成一个 303 + `Set-Cookie`；没有这个座位，请求会落到一个**没有 fallback** 的 webserver 上，得到 404。

第 2 条是这块最容易被漏掉的一环，因为它失败的样子极具误导性：`/api` 本身完全正常，但任何一个"先拿 URL 再换 cookie"的客户端都会在第一步就拿到 404，看起来像"节点没有 Remote API"。

所以 `@local/dsh-fleet-brain/runtime` 做三件事：

- 提供 `webApp` 服务（Host 契约的一部分，其它行会读）；
- 等 Loader 组合完成后，用 `connection.authenticatedUrl()` 打印 `dsh web: <url>`，格式与本机桌面端解析的那一行完全一致；
- 用 `webServer.registerFallback` 认领 index 座位：入口路径走 `connection.authorizeIndex`，其余未匹配路径 404；
- **不挂** `frontend-static`（没有 dist 可服务）、**不开**浏览器。

还有一条 Cordis 的硬约束：`inject` 必须声明插件读取的每一个服务。漏了 `webServer` 会在插件体里抛 `cannot get property "webServer" without inject`，而如果抛出点在 promise 链里，症状是**宿主启动、端口在听、一行不打印** —— 就是这个模块第一次写完时的样子。

### 传送链路：生成物，不手改

```
packages/dsh-fleet-brain/
  cordis.patch.yml            ← 生成物（98 行上游 → 60 行大脑）
  presets/*.patch.yml         ← 原样复制（大脑的 Session 也要有 standard preset）
  src/runtime.js              ← 手写：唯一的大脑专属代码
  scripts/sync-from-upstream.mjs   ← 做减法并生成上面两者
  scripts/check-composition.mjs    ← 断言结果"仍然是个大脑"
  scripts/embed-into-fleet.mjs     ← 把整包嵌进插件
        ↓
packages/dsh-fleet/src/host/brain-bundle.generated.js   ← 生成物（字符串常量）
```

**为什么嵌进插件而不是运行时读路径**：插件跑在 DSH 自己的安装里（桌面构建里是 `app.asar` 内部），不能假设 `dsh-fleet-brain` 这个包在同一块盘上。嵌入后没有运行时路径假设。

节点上落到 `~/.dsh/profiles/fleet/node_modules/@local/dsh-fleet-brain/` —— **profile 自己的 `node_modules`**，因为 Loader 解析一行 `name` 时的 profile 拦截层就是它。

### 幂等与顺序

`connect` 的 provision 阶段现在做四件事，前三个都在宿主启动**之前**：

1. `writeBrainBundle` — 按 path+content 的 sha256 判断是否要重写；一致就跳过（实测第二次返回 `{changed:false}`）。
2. `writeProfileBundles` — 只在 bundle 列表不同时写 profile manifest。
3. `writePatch` — 模型行 + 权限预设，写进节点自有 profile 的 patch（下节）。
4. 启动，`patchChanged = 任一为真` 时重启。

### 职责切分：谁拥有什么

这一节是上一轮返工的直接产物 —— 三个地方曾经各写一半，导致"哪份才生效"要靠猜。

| 关注点 | 唯一拥有者 | 载体 |
|---|---|---|
| 节点跑哪些插件 | `packages/dsh-fleet-brain` | profile 的 `dsh.profile.bundles` |
| 节点的模型名册与权限预设 | `host/provision.js` | `~/.dsh/profiles/fleet/cordis.patch.yml` |
| 节点的 API key | `host/provision.js` | 节点凭据库（经节点 `credentials/set`） |
| 节点上的 DSH 版本 | `remote/daemon.js` | `npm i @deepseek-ai/dsh@<本机版本>` |

**overlay 里不再出现 `disabled: true`。** 它曾经写过 56 条禁用浏览器行的 patch，但组合层已经把那些行全部去掉了 —— 于是这 56 条指向不存在 id 的 patch 是纯空转。更糟的是它掩盖信号：如果哪天某个 UI 行真的出现在节点组合里，正确反应是"组合错了"，而不是"悄悄把它关掉"。实测确认 `applyPatches` 对不存在的 id 只发一条 `ctx.logger.warn("patch: entry %C not found")` 然后跳过 —— 也就是说这类空转 patch **在正常输出里根本看不见**，是纯粹的静默噪音。

真正需要 `disabled: true` 的只有 agent plane 的 22 条，它们在 `dsh-base` 里确实存在；那份清单属于组合层，不属于 overlay。

### 模型与凭据：节点自有 profile 的 patch + Remote API

组合层决定"有哪些插件"，但不决定"模型是什么、key 是哪把"。这两件事由本机驱动，并且**不只是连接那一刻**：

1. **配置**（`~/.dsh/profiles/fleet/cordis.patch.yml`）：从活的 `configEditor.configuration()` 复制 provider 路由、默认模型、权限预设。账号登录型 provider 不复制（那是本机的登录态）。这是**插件自有 profile** 的配置层，节点宿主会热重载它 —— 改配置不需要重启宿主。
2. **凭据**：那些行点名的 `apiKeyEnv` 在本机 `credentials.resolve()` 取值，通过节点自己的 `credentials/set` 写入节点凭据库。key 的 ref 不只从 `apiKeyEnv` 取 —— 那字段只有显式设置过才在组合后的 patch 里；没设时用 adapter 默认值（`llm-deepseek-api-key` → `DEEPSEEK_API_KEY`），否则会得到"provider 加载成功但没有 key"的节点。
3. **跟随**：本机订阅自己的 `app-boot/config-reload`（`configEditor` 每次写配置后 emit）与 `credentials/reference-updated`，把 `syncConfig()` 派给所有已连接节点。两次事件可能连续来，所以合并到 250ms 的定时器上，避免读到只应用了一半的组合。

`connect` 在 `provision` 里报告：`rows` / `refs` / `composition{bundle, files, changed}`。

#### 为什么不是 `--patch` overlay（实测过一次，推翻了原来的设计）

`--patch` 传入的覆盖层**不在 HMR 的监视列表里**。上游 `dsh-hmr` 只 watch 两个路径：`profile.patchPath` 与 `$DSH_HOME/cordis.patch.yml`。所以 overlay 方案有两个无法回避的缺陷：改配置要重启宿主、且只在连接时同步。

节点上逐条验证过（`docs/adr-0001`）：

| 实验 | 结果 |
|---|---|
| 往 overlay 里加一行指向不存在包的行 | 进程不变、日志零新增 —— 确认不被 watch |
| 往 `profiles/fleet/cordis.patch.yml` 写 3 个模型（原子 `mv`） | 8 秒后 `session/modelCatalog` 返回它们，**PID 不变** |
| 用 `>` 原地改写同一个文件 | 同样生效（chokidar + `awaitWriteFinish` 两种写法都收得到） |

换到自有 profile 还顺手解决了一个所有权问题：`web` 是上游的 profile，插件不该和别的东西抢同一个 `cordis.patch.yml`。现在 `~/.dsh/profiles/fleet` 完全属于这个插件。

同期验证了真实链路：本地把 `reasoningEffort: high` 改成 `max` → 8 秒内节点 profile patch 里就是 `max`，节点 PID 不变；改回 `high` 同样跟着回来。

### 验证

- `scripts/check-composition.mjs`：断言 7 个 Remote 控制器行在、4 个传输行在（`webserver` / `connection` / `api-remotes` / `web-startup`）、`brain-runtime` 在、`web-runtime` 不在、没有任何 `dsh-client-ui-*`、6 条 agent-plane disable 在、4 个 preset 文件都存在且被声明、整份 YAML 能解析。
- 实测（192.168.x.x，DSH 0.2.2-rc.3）：`base + brain` 组合启动成功并打印 `dsh web: http://127.0.0.1:…?token=…`，五个端到端测试全绿。

`check-composition` 里的传输行**故意只列 4 条而不是 5 条**：早期版本断言过 `authentication-token`，而 `0.2.2-rc.3` 没有发布那个包 —— 一个契约测试必须测**这个 release 的契约**，不能测记忆里的契约。launch token 由 `connection.authenticatedUrl()` 提供，所以 `connection` 那条才是必须的。

### 遗留的一处真实风险

组合层的行 id 是上游的内部命名（`session-controller`、`workspace-files` …）。上游重命名一行，本包的 patch 就会指向一个不存在的 id。

**上游对此是静默的**：`applyPatches`（`@deepseek-ai/cordis-plugin-include`）在 `entryMap.get(id)` 落空时只调 `warn("patch: entry %C not found", id)`，然后 `continue`；该 warn 走 `ctx.logger.warn`，正常启动输出里看不到。所以"组合少了一行"不会以任何显眼方式失败，节点会照常启动、照常答 `session/list`，只是那个端点不存在。

这就是 `check-composition.mjs` 存在的理由：把它变成**启动前的显式断言**，而不是靠运行期发现。

---

## 六之三、运行时契约与失败形态

### `/fleet/api` 的鉴权边界

`/fleet/api` 用 `kind: 'prefix'` 注册，**没有写 `auth` 字段** —— 而 webserver 的默认策略是 `auth ?? 'required'`，`required` 又要求 `webserver/authorize` 的 bail 给出 `allow` + 一个 Peer。这个 bail 由 `dsh-client-connection` 的 Host 半边实现：它检查 Host/Origin fence，再验 cookie。

所以这组管理端点和 `/api` **同一把锁**：没有 `?token=` 换来的 cookie 就是 401/403。这一点必须写下来，因为"我自己注册的 prefix 默认是不是开放的"是那种想当然就会错的问题。

### 凭据与状态存在哪

| 数据 | 位置 | 说明 |
|---|---|---|
| 节点记录（host/port/user/名） | `$DSH_HOME/fleet/nodes.json` | 插件自己的目录，不动 desktop profile 的任何文件 |
| 节点密码/私钥 | DSH 凭据库的 record：`dsh-fleet/n<id>` | 走 `ctx.credentials.modifyRecord`，序列化的读-改-写，所以"只换密码、保留私钥"是安全的 |
| 节点的模型配置 | 节点 `~/.dsh/profiles/fleet/cordis.patch.yml` | 插件拥有；每次连接重写，本地一改就重新下发（宿主热重载，不重启） |
| 节点的 brain bundle | 节点 `~/.dsh/profiles/fleet/node_modules/@local/dsh-fleet-brain/` | profile 自己的 `node_modules`（Loader 的 profile 拦截层） |

### 并发、超时、失败

- **每节点串行**：`Fleet.serial(runtime, action)` 把同一台机器的所有生命周期动作排在一条 promise 链上。两个并发 `connect` 不会各起一个宿主。
- **SSH 重试**：`MAX_RETRIES = 3`，指数退避从 `BASE_DELAY_MS = 400` 起；只对可重试分类重试（连接类），认证失败直接抛。
- **握手超时**：`READY_TIMEOUT_MS = 20 000`。
- **Gateway 401**：`RemoteGateway.call` 捕获一次 401 → 丢掉缓存的 cookie、重新铸造 → 重试一次。之后再 401 就报 `GATEWAY_FAILURE.AUTH`，不再循环。
- **节点不可达时**：`session/list` 等合并类端点**跳过**该节点而不是整体失败；侧栏少几行，而不是一条错误把整个列表干掉。

---

## 七、测试

| 脚本 | 验证什么 | 依赖 |
|---|---|---|
| `routing-unit.mjs` | 身份往返、流扇出、工作区合并、本地调用直达上游、job 三个端点、control 只发一帧 baseline | 无（假 fleet） |
| `gateway-smoke.mjs` | SSH 上的 cookie、unary RPC、流载体 upgrade | 真实节点 |
| `descriptor-smoke.mjs` | 上游包的 descriptor 与 `static inject` 可从 `app.asar` 读到 | Electron Node |
| `dispatch-seam.mjs` | Gateway 的 view 会读取实例 own property；声明端点集不变 | Electron Node |
| `upstream-smoke.mjs` | 上游控制器的 `static inject` 与导出可用 | Electron Node |
| `host-routing.mjs` | **每个**路由端点走本地 `/api`，以及该保持本地的端点仍然本地；含一次**二进制**读取（远端图片预览靠它） | 运行中的 Host + 已连接节点 |
| `workspace-flow.mjs` | 端到端手势：按路径加远程工作区 → 在里面建 Session → 发消息 → 节点 bash 真跑 → 文件真出现在节点磁盘 → 会话归入工作区 → 出现在 `session/list` 且 cwd 是节点绝对路径 | 同上 |
| `tool-parity.mjs` | 镜像方案过不了的那一关：agent 自己的 `read`/`write`/`edit`/`grep`/`glob` 打的是节点真实路径，没有路径类失败，整份 transcript 里没有 Windows 路径 | 同上 |
| `tool-git-image.mjs` | `git` 打真仓库、`read_image` 开真 PNG、`grep` 搜真文件 —— 三个在"工具在本地跑、只是对着镜像"时必然坏掉的工具 | 同上 |
| `multipart-unit.mjs` | Gateway 的 `multipart/form-data` 应答能解：字节附件在正确的 JSON 路径上还原成 `Uint8Array`，畸形分片被拒绝而不是静默读成 `null` | 无 |
| `provision-unit.mjs` | 下发给节点的东西是对的：provider 行复制而账号行不复制、行里没写 `apiKeyEnv` 时也能推断出 key ref、配置能过真 YAML 解析器 | Electron Node（解析器在 `app.asar` 里） |
| `dsh-fleet-brain/scripts/check-composition.mjs` | 节点组合仍然是个**大脑**：7 个 Remote 控制器行在、5 个传输行在、`web-runtime` 不在、没有任何 `dsh-client-ui-*`、6 条 agent-plane disable 在、preset 文件齐全且已声明、YAML 可解析 | Electron Node（借用安装里的 YAML 解析器） |
| `dsh-fleet-brain/scripts/sync-from-upstream.mjs` | 组合可重新生成（幂等；生成后与已提交版本一致即说明没有手改生成物） | 已安装的 DSH release |
| `client-bundle.mjs` | 桌面端真的 serve 了这份客户端代码；三个槽位注册且能渲染 | 运行中的 Host |
| `event-relay.mjs` | 在**节点上直接建**的 Session 能到达浏览器：`api-session/*` 列表事件与 `session/control` 投影帧都带着包裹后的身份到达；baseline 里有远程投影块；没有任何裸的节点 Session id 泄漏 | 运行中的 Host + 已连接节点 |

升级 DSH 之后该按什么顺序重跑、每个测试守的是哪条上游契约，见 [`packages/dsh-fleet/docs/UPGRADE.zh.md`](../packages/dsh-fleet/docs/UPGRADE.zh.md)。

`test/carrier.mjs` 是被后五个共用的最小测试客户端，含一条硬要求：**必须应答 Gateway 的 2 秒 ping**，否则两秒后流被静默关闭 —— 这会让路由 bug 伪装成传输 bug。

`host-routing.mjs` 自己建 fixture：在远程工作区里建一个 Session、改名、并在节点上写一个 4×4 PNG 和一份文本。它曾经借用"最新一条远程 Session"和别的测试留下的 `git-image/` 目录 —— 那种写法会让结果取决于测试顺序，而一次因为目录空而失败的运行看起来和路由坏了完全一样。

---

## 八、明确不做的事

- **不改 Electron 主进程**：窗口只连本地 Host 这条约束不动。
- **不接管 `/api` 或 `/api/remote.mux`**：它们已被 gateway 独占，**本机**的 `registerFallback` 也已被 `frontend-static` 占走（节点上则相反：大脑没有 static，那个座位空着，由 `brain-runtime` 认领）。
- **不做本地镜像目录**：工作区路径就是节点上的真实路径。这正是工具能用的原因 —— 见下一节。
- **不碰上游 Loader 行**：插件自己的 `cordis.patch.yml` 只有一条 `insert`。
- **不 fork 任何上游包**。节点侧改的是**组合层**，官方包一个字节没动。
- **不做 per-node 组合定制**：所有节点共用同一份 `@local/dsh-fleet-brain`。某台机器要不同插件集时再讨论，不预留空壳配置。

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
