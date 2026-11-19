# ADR-0002 审批/提问回传、终端转发、版本闸门与插件同步开关

> 状态：已采纳（2026-11-17）。取代 ARCHITECTURE 旧版「两个真实上限」里关于审批与 terminal 的结论。
> 现在怎么工作：见 [ARCHITECTURE.md](ARCHITECTURE.md) §三缝隙四/缝隙五、§六之四（版本与制品）、
> §六之五（插件开关）。本文只记**当时否掉了什么、为什么**。

## 背景

ARCHITECTURE 里记过两条真实上限：远程会话的 `approval/request` / `user-questions/request`
只被答 `next`，终端 `create`/`attach`/`close` 不路由。用户要求消掉，同时提出四项新要求：
节点大脑制品从 GitHub Release 拉取、插件与节点版本必须对应且本地更高时自动升级、
每个插件单独一个「是否同步到节点」开关、其他本地插件要能像读本地会话一样读远程会话。

## 决策一：waterfall 走 Gateway 的待处理事件表，不 import 上游 scope

中转一次 waterfall 需要**本地发起**一次 `approval/request`，而唯一入口要求 `this` 是
`scopeTarget(agent, agent)` 造的 carrier（模块私有 WeakMap，只有 `@deepseek-ai/dsh-scope` 能注册）。

| 路线 | 代价 | 结论 |
|---|---|---|
| `import { scopeTarget } from '@deepseek-ai/dsh-scope'` | 打破「插件零上游 import」的硬规则 | 否 |
| 直接用 Gateway 的 `pendingRemoteEvents` / `deliverRemoteEvent` / `cancelRemoteEvent` | 新增一条运行时缝隙 | **采纳** |

浏览器侧本来就由上游 `ClientRemoteEvents` 完成 dispatch —— 它用 `scopeOf(Context)` 而不是 carrier，
所以**远程会话合成的 scope 天然可用**，`ui-approval` / `ui-user-questions` 收到帧就按本地会话一样
渲染原生卡片，客户端一行不用改。缺的只有「Host 怎么把帧塞进投递队列」，那三个都是实例上的普通属性。

于是 `startRemoteEvent` 的完整校验全部绕开：pending 自己构造，`source.resolve/reject` 自己提供，
语义仍只有三态（`next` / `result` / `cancel`）。安全阀是 `WATERFALL_TTL_MS`（10 分钟）——
上游 approval 默认本来就是 `'unavailable'`，所以过期是**降级回原状**，不是新增失败模式。

## 决策二：terminal 靠 `agent` lookup 的 resolver 表转发

`terminal` 九个端点里六个吃 `Agent` 形参，由 Gateway 在方法体之前解析。公开的
`lookups.configure('agent', …)` 已被 `@deepseek-ai/dsh-api-session-controller` 占用
（同一 key 第二次 `configure` 直接抛错），所以只能替换 `lookupStore.resolvers` 里那一项：
`fleet_` 前缀合成占位 Agent，其余 id 原样委派给被替换掉的 resolver。

`attach` 是 `mode: 'stream'` 且真用 uplink，所以 `RemoteGateway` 补了上行
（`openStream(…, { uplink })` 的 `send` / `endUplink`，关闭时发 `{type:'cancel'}`），
decorator 整段替换 `attach`：本地取一次 `ctx.invocation.uplink()` 接到节点，节点的下行帧逐帧
`router.toLocal` 后 yield。

`readScreen` / `inspectActivity` / `openForAgent` 不是 `@Remote`，浏览器调不到，保持不转发。

## 决策三：版本闸门用 Release 制品，不用节点 npm install

现状是连接时 `npm i @deepseek-ai/dsh@<version>`：1.3 GB、几分钟、依赖节点能访问 npm。

改为：发布时把安装树打成 `dsh-<version>-<platform>.tar.gz` 挂 GitHub Release，节点下载 + 校验
sha256 + 解压替换 `runtime/`。闸门比较 `pluginVersion` 与节点 `status.json` 的版本：

| 情形 | 动作 |
|---|---|
| 节点缺 | 全量安装（制品） |
| 节点低 | 自动升级，原子替换 `runtime/`，重启宿主 |
| 节点高 | **拒绝连接**并说明原因，不静默降级（会话格式可能不兼容） |
| 相等 | 直接复用 |

回滚：替换前把旧树改名 `runtime.previous`，解压失败或宿主起不来则回滚并报告。

**当时写的是「加速地址可配置（`$DSH_FLEET_MIRROR`），失败自动回官方」。这两点后来都被推翻了**：
现在是 `DEFAULT_MIRRORS` 列表依次试、**不回退直连 GitHub、也不回退 npm**（理由与实测见
ARCHITECTURE §六之四）。本 ADR 保留这句是为了说明演进，不是当前行为。

## 决策四：每插件同步开关

节点组合是生成物，开关只能作用在**下发**这一步：开关存在**profile 目录**里
（`fleet-plugins.json`，不是 `$DSH_HOME` —— 否则 `desktop` 与 `fleettest` 会互相影响），
关掉的行以 `disabled: true` 写进节点 profile patch —— 不是加载后禁用，那行根本不激活。

**默认值后来从「全关」翻成了「全开」**（用户要求：装在这里、连了节点就是同一个工作环境），
硬排除清单 `NODE_NEVER_SYNC` 仍然守着五个名字。当前语义见 ARCHITECTURE §六之五。

## 决策五：其他插件读远程会话

远程会话已经进入 `session/list`、`session/control`、`$events`、`session/follow`，所以
**任何只走 Remote API 的插件天然能读**。真正会让插件坏掉的是 `agent` 型参的端点（决策二解决了
主要部分）和 `session/state` / `session/wait` 这类按 id 查本地 Agent 的端点 —— 它们已经路由。
因此这一项**不需要新机制**，只需要验收覆盖。

## 后果

- 新增两条运行时缝隙（Gateway 待处理事件表、lookup resolver 表），都必须在 `dispatch-seam.mjs`
  与 `routing-extra-unit.mjs` 里钉住形状，DSH 升级要重跑。
- 审批/提问从「永远 unavailable」变成「本地可回答」，节点侧仍是同一套默认值兜底。
- 节点安装从 npm 变制品下载，离线/受限网络下首次连接更快，但增加了一条「制品是否发布」的前置依赖。
