# ADR-0002 审批/提问回传、终端转发、版本闸门与插件同步开关

> 状态：已采纳（2026-11-17）。取代 ARCHITECTURE「两个真实上限」一节里关于审批与 terminal 的结论。

## 背景

ARCHITECTURE 里记过两条真实上限：远程会话的 `approval/request` / `user-questions/request` 只被答 `next`，终端 `create`/`attach`/`close` 不路由。用户要求消掉。

同时新增四项要求：节点大脑制品从 GitHub Release 拉取（走 `git.yylx.win` 加速）、插件与节点版本必须对应且本地更高时自动升级、每个插件单独一个「是否同步到节点」开关、其他本地插件要能像读本地会话一样读远程会话。

## 决策一：waterfall 走 Gateway 的待处理事件表，不 import 上游 scope

中转一次 waterfall 需要**本地发起**一次 `approval/request`，且 `agentId` 是包裹后的 `fleet_…`。上游唯一的发起入口是 `api-remotes` 的监听器，它要求 dispatch 的 `this` 是 `scopeTarget(agent, agent)` 造出的 carrier（模块私有 WeakMap，只有 `scopeTarget` 能注册）。

两条可选路线：

| 路线 | 代价 | 结论 |
|---|---|---|
| `import { scopeTarget } from '@deepseek-ai/dsh-scope'` | 打破「插件零上游 import」的硬规则 | 否 |
| 直接用 Gateway 的 `pendingRemoteEvents` / `deliverRemoteEvent` / `cancelRemoteEvent` | 新增一条运行时缝隙 | **采纳** |

理由：浏览器侧本来就由上游 `ClientRemoteEvents` 完成 dispatch——它用 `scopeOf(Context)` 而不是 carrier，所以**远程会话合成的 scope 天然可用**，`ui-approval` / `ui-user-questions` 收到帧就按本地会话一样渲染原生卡片，客户端一行不用改。缺的只有「Host 怎么把帧塞进投递队列」，那三个字段/方法都是实例上的普通属性。

于是 `startRemoteEvent` 那条完整校验（`projectRemoteEventRequest` 的 `request.agent === subject`、`agent.ctx.effect` 的 pending 生命周期）全部绕开：我们自己构造 `pending`，`source.resolve/reject` 由我们提供，语义仍然只有三态：

- 浏览器返回哨兵 → 回节点 `{kind:'next'}`（节点的默认值原样生效，approval 是 `'unavailable'`）
- 浏览器返回真实值 → 回节点 `{kind:'result', value}`
- 节点发来 `{type:'cancel'}` → 本地 `cancelRemoteEvent` 让卡片消失，**不回结果**（节点侧已结算）

三条硬约束（都有上游源码依据）：

1. `agentId` 必须用 `router.toLocal` 包成 `fleet_…`，否则浏览器合成的 scope 用裸 id，卡片进不了那张会话。
2. `frame.request` 里不能有 `agent` / `signal` / 显式 `undefined`——浏览器自己补 `agent` 与 `signal`。
3. 没有活的 owner 客户端（`typertGateway.hasLiveClient()` 为假）时立刻回 `next`，否则 pending 永挂，会把远程回合卡死。

安全阀：pending 超过 `WATERFALL_TTL_MS`（默认 10 分钟）自动 `next`。上游的 approval 默认本来就是 `unavailable`，所以这是一种**降级回原状**，不是新增失败模式。

## 决策二：terminal 靠 `agent` lookup 的 resolver 表转发

`terminal` 九个端点里六个吃 `Agent` 形参，由 Gateway 在方法体之前用 `agent` lookup 从 wire 的 `agentId` 解析。`lookups.configure('agent', …)` 已被 `@deepseek-ai/dsh-api-session-controller` 占用（`configure` 对同一 key 第二次调用直接抛错），所以只能替换 `ctx.typert.lookupStore.resolvers` 里的那一项：`fleet_` 前缀合成占位 Agent（`{ id, ctx }`，`ctx` 用插件自己的长命 Context），其余 id 原样委派给被替换掉的 resolver。

`attach` 是 `mode: 'stream'` 且真用 uplink，所以 `RemoteGateway` 必须补上行：

- `openStream(endpoint, args, handlers, { uplink })` 增加发送 `{type:'item', streamId, value}` / `{type:'end', streamId}` 的能力
- 关闭一条流时发 `{type:'cancel', streamId}`（现在是直接不发）
- decorator 整段替换 `attach`：本地 `ctx.invocation.uplink()` 取一次接到节点；节点的下行帧逐帧 `router.toLocal` 后 yield

`readScreen` / `inspectActivity` / `openForAgent` 不是 `@Remote`，浏览器调不到，保持不转发。

## 决策三：版本闸门用 Release 制品，不用节点 npm install

现状：连接时若节点版本不同就 `npm i @deepseek-ai/dsh@<version>`，1.3GB、几分钟、依赖节点能访问 npm。

改为：

1. **制品**：发布时把 `@deepseek-ai/dsh@<version>` 的安装树打成 `dsh-<version>.tar.zst`（或 `.tar.gz`），连同 `dsh-fleet-brain` 一起发布到 GitHub Release `<repo>/releases/download/v<pluginVersion>/`。
2. **下载**：节点上 `curl -fL https://git.yylx.win/https://github.com/<repo>/releases/download/v<v>/dsh-<v>.tar.gz | tar -xz -C <runtime>`，带 `sha256` 校验文件。加速地址可配置（`$DSH_FLEET_MIRROR`），失败自动回官方。
3. **闸门**：连接时比较 `pluginVersion` 与节点 `status.json` 里记录的 `fleetVersion`：
   - 节点缺 → 全量安装（Release 制品，fallback npm）
   - 节点低 → 自动升级（下载新制品，原子替换 `runtime/`，重启宿主）
   - 节点高 → **拒绝连接**并说明原因，不静默降级（会话格式可能不兼容）
   - 相等 → 直接复用
4. **回滚**：替换前把旧 `runtime` 重命名为 `runtime.prev`，新制品解压失败或宿主起不来则回滚并报告。

## 决策四：每插件同步开关

节点组合是生成物（`packages/dsh-fleet-brain/cordis.patch.yml`），开关只能作用在**下发**这一步：

- 开关存在插件自己的目录 `$DSH_HOME/fleet/plugins.json`，`{ "<rowId>": { sync: boolean } }`
- 默认值来自一行判定：`@deepseek-ai/dsh-client-*` / `dsh-web*` / 明显 UI 行默认 **不同步**；工具、模型、会话、工作区、终端类默认 **同步**
- 关掉的行以 `disabled: true` 写进节点 profile patch——**不是**加载后禁用，那行根本不激活
- 设置界面里每行一个开关，显示「默认/已开/已关」与实际是否在节点组合里

## 决策五：其他插件读远程会话

远程会话已经进入 `session/list`、`session/control`、`$events`、`session/follow`，所以**任何只走 Remote API 的插件天然能读**（`dsh-whale-widget` 读会话列表、`ds-harness-remote` 直接代理浏览器到本机 Host）。真正会让插件坏掉的是 `agent` 型参的端点（决策二解决了主要部分）和 `session/state` / `session/wait` 这类按 id 查本地 Agent 的端点——它们已经路由。

因此这一项**不需要新机制**，只需要验收覆盖：在验收里断言「另一个本地插件视角下能读到远程会话行与投影」。

## 后果

- 新增一条运行时缝隙（Gateway 待处理事件表）与一条内部补丁（lookup resolver 表），都必须在 `dispatch-seam.mjs` 里钉住形状，DSH 升级要重跑。
- 审批/提问从「永远 unavailable」变成「本地可回答」，节点侧仍是同一套默认值兜底。
- 节点安装从 npm 变制品下载，离线/受限网络下首次连接更快，但增加了一条「制品是否发布」的前置依赖。
