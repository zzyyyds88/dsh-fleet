# DSHpl — 把远程 Linux 机器变成 DeepSeek Harness 里"像本地一样"的工作区

> 痛点一句话：**工具不可用**。
> 远程的目录接进桌面端之后，`grep`、`glob`、`git`、`read_image` 在那里全部失效。

这个仓库是我为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称
DSH）写的一套东西。核心是 `packages/dsh-fleet` 这个插件，配套 `packages/dsh-fleet-brain`
是节点侧的 DSH 组合。

```
packages/
  dsh-fleet/        插件：装在桌面端（Host 侧 + 浏览器侧）
  dsh-fleet-brain/  节点侧 bundle：只当远程大脑的 DSH 组合
docs/
  ARCHITECTURE.md   设计与取舍：每个决定否决了什么
reference/          上游源码（只读，不进版本库，见其 README）
```

---

## 一、痛处

DSH 的桌面端很好用，但它的**工具全部跑在本机**。当你需要另一台机器干活 —— 编译、
跑服务、GPU、只有它装了那套工具链 —— 麻烦就开始了：

| 你想做的事 | 实际发生 |
|---|---|
| `bash` 里敲 `ls /root/project` | 拿到的是**本机**的 `/root/project`，或者直接没有这个目录 |
| 代码在远端，agent 改文件 | 编辑器能读到远端内容，但 `edit`/`write` 落在本地，远端文件一动没动 |
| 远端有个截图/PDF 想看 | `read_image` 在本机找那个路径，报 "bytes do not decode" |
| `git log` | `fatal: not a git repository`（本地副本里没有 `.git`），或者更糟：关于错仓库的正确回答 |
| `grep` / `glob` | 搜的是本地那份副本，远端后来新增的文件永远搜不到 |

我先试过 `@artenx/dshb` 那条路（把远端目录镜像到本地），失败方式有五种，
全部写在 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 第九节。核心原因是结构性的：

**只要工具进程在本机，它读的就是本机的文件系统。** 路径翻译、argv 改写、
"把远端文件同步到本地再跑"都是在和这个事实对抗，补不完。

还有一条更隐蔽的诉求：手机端的 `ds-harness-remote`（P2P 端到端加密远控）
要能读到这些远端会话。如果远端会话只是"另一个窗口里的东西"，它读不到。

---

## 二、参考了谁

[ZCode](https://github.com/zai-org/ZCode) 的远控之所以好用，根本原因是
**远端有大脑**：本地不发每条指令，只连过去用。这个观察定下了整个方案。

对比下来，"本地调度 + 远端执行"的代理模型有四个绕不过去的硬缺口：

| 缺口 | 为什么补不了 |
|---|---|
| MCP 服务器在**本机** spawn | MCP client 直连 SDK，不经可重定向的进程服务 |
| skills 用 `node:fs` 扫**本机** | 枚举发生在本地进程里 |
| `bash`/`pwsh` 按 `process.platform` 二选一 | 本地 Windows 选 pwsh，转发到 Linux 必然 `code=127` |
| 沙箱管不到远端 | 本地权限模式管的是本地进程 |

四条全部消失的办法只有一个：**让大脑长在远端**。

---

## 三、怎么做的

### 3.1 大脑在远端，本地只做三件事

```
┌────────────────── 你的 Windows 桌面端 ──────────────────┐
│  DSH Desktop（Electron）                                │
│    └─ 本地 Host 进程                                    │
│         ├─ 官方 /api、/api/remote.mux   ← 一行没改      │
│         │    └─ 插件在**服务实例上**覆写若干方法：       │
│         │       session/list、workspace/follow、…       │
│         │       → 本地行 + 每台节点自己的行             │
│         └─ /fleet/api   ← 节点管理 + 选机器/选目录 + 插件开关  │
└─────────────────────────────────────────────────────────┘
                    │  SSH :22（唯一入口，节点不开放端口）
                    ▼
┌──────────────── 远端 Linux · 常驻大脑 ───────────────────┐
│  dsh --profile fleet --host 127.0.0.1 --port 0 --no-open  │
│    ├─ 完整 DSH Host：rg / git / read_image / bash / PTY   │
│    └─ 会话、工作区、审批、终端全部在远端                   │
└─────────────────────────────────────────────────────────┘
```

本地只做三件事：**身份编码、请求转发、结果还原**。

- **身份编码**：远端的东西跨界时变成 `fleet_<nodeId>_<remoteId>`，
  比如 `fleet_n0123456789ab_session-1dc98667-…`。这一个字符串同时回答
  "这是本地的还是远端的""哪台机器""远端是谁"。
- **请求转发**：本地 `/api` 收到 `session/prompt`，是远端会话就转给节点自己的
  `/api`。
- **结果还原**：节点回来的 id 再套回 `fleet_…`，字节附件（图片预览）用
  `multipart/form-data` 解回来。

于是**工具层零改动**：`grep`/`git`/`read_image`/`bash` 在节点上就是本地的，
因为它们本来就是本地的。同时远端会话出现在**同一个侧栏**里，手机端自然也能读到 ——
对 Host 来说它们就是普通会话。

列表是快照，侧栏靠的是活流。上游客户端另外订阅两路，本地会话天然在流里，
远端会话不在 —— 只做合并的话行会"在，但死着"（标题停在 "New Session"、
运行中转圈不转、在节点上新建的会话要等下一次整表拉取才出现）。所以插件还并流
两件事：每个节点一条 `$events`（`api-session/*` 重发到本机事件总线）和一条
`session/control`（每会话的 `title`、`modelSelection`、待处理审批标记）。
两路都是 Host 级、每连接一条，所以是**并流**而不是转发 —— 浏览器侧同样一行没改。

### 3.2 五处运行时缝隙（而不是改上游代码）

插件**不 import 任何 `@deepseek-ai/*`**，唯一运行时依赖是 `ssh2`。
它站在五处 DSH 自己的实现细节上，每一处都有测试守着：

| 缝隙 | 是什么 |
|---|---|
| 实例上的 own property | Gateway 从**类原型**读 `@Remote` 描述符，但 dispatch 用 `Reflect.get(view, name)` —— 实例属性优先。所以在实例上覆写方法，端点表不变、实现换掉。 |
| `typert.lookups.configure('workspaceFileScope', …)` | `fleet_…` 不是本地 Session，Host 自己的 lookup 会先返回 not-found。覆写后本地 id 原样委派上游，包装 id 合成 scope。 |
| `typert.lookupStore.resolvers` 的 `agent` 项 | `agent: Agent` 形参在方法体之前就被解析掉，而公开的 `configure` 已被上游占用（同一 key 第二次调用直接抛错）。所以直接换 resolver 表里那一项。 |
| Gateway 的待处理事件表 | 上游唯一的「本地发起 waterfall」入口要求一个只有 `@deepseek-ai/dsh-scope` 能造的 carrier。改为自己造一条同形 pending 塞进 `pendingRemoteEvents`，投递与结算交给上游。 |
| `webServer.register('/fleet/api')` | 本地的目录选择器浏览的是**本机**，永远选不到节点的 `/root/project`。所以插件占用壳的 `*.directoryFlow` 插槽，换成一个"先选机器、再选目录"的对话框。 |

这五条是**实现细节，不是公开契约**。所以有 `test/dispatch-seam.mjs`：
DSH 升级后它先炸，而不是等你某天发现所有远端会话都点不开。

### 3.2b 手机入口：节点路径挤进同一套语法

手机端 `ds-harness-remote` 只会说「本机绝对路径」，节点路径必须有语法位置。用
`/@fleet/<nodeId>/…` 前缀（取舍见 [ADR-0004](docs/adr-0004-node-control-and-picker.zh.md) §二）。
两个硬理由：`fleet://` 在 win32 上过不了中转 dispatch 前的 `isAbsolute` 检查；
而 `/@fleet` 让中转那次 `mkdir -p` 的落点集中到 `<盘>:\@fleet\` 之下，fleet 在工作区
建好后自底向上 `rmdir` 空目录链 —— 能删的只会是刚被建出来的空链，不是启发式。

同样是手机入口的一部分：`directoryPicker/list` 与 `createDirectory` 由 fleet
**整体替换**而不是装饰 —— 桌面上 `directory-picker-auto` 解析成 native 后端，
原生 `list` 会 `requireCapability("browse")` 抛错，中转随即改用自己那份实现，
继承式的覆写永远调不到。

### 3.2c 节点控制模式：一个只有一种能力的会话

新会话可以选 `node-control` 预设。「除节点管理外一律拒绝」不是运行时判断，
而是**组合属性**：web 那层 patch 把宿主面的 agent 工具行全部 disable，所以一个预设的
`config.plugins` 就是那个会话的完整工具集，而这个预设只列了 `fleet_nodes` 一个工具。
密钥只收引用、拒绝内联粘贴，因为工具参数会写进会话日志。

被控节点不会得到这个能力：`NODE_NEVER_SYNC` 把本插件挡在节点之外（它是全开默认值里的
硬排除项），所以节点不会变成第二个能管理节点的入口。

### 3.3 节点只当大脑 —— 定制组合，不是 fork

节点上装的是一个**独立的 DSH 安装**，有自己的 `~/.dsh`。默认它装的是 Web 组合，
于是服务器上会加载一整套浏览器插件（56 个 `dsh-client-ui-*` 包、SPA dist 服务、
HMR 链、桌面遥测）—— 没有窗口的机器上要么空转，要么因为找不到 dist 直接报错。

上游发布的 6 个 bundle 里没有"大脑"这个形态：`base`（无 Host）、`web-app`
（带整个浏览器面）、`headless`（一次性任务，无 Host/HTTP）、`acp-app`、
`sdk-app`、`sdk-minimal`。

**我没有 fork。** DSH 是 Cordis 组合式架构 —— 一个插件是否存在于运行时，
完全由 profile 的组合层决定。所以节点 profile 现在组合：

```
@deepseek-ai/dsh-base + @local/dsh-fleet-brain      ← 现在
@deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app    ← 之前
```

`dsh-web-app` 那一层**根本不在组合里**，那些包连 `import` 都不会发生。
效果等价于删代码，但可逆、且跟着官方版本走。

`@local/dsh-fleet-brain` 的 patch 是**从已安装的那个 release 派生**的
（`scripts/sync-from-upstream.mjs`）：keep 全部 host-plane 行，drop 56 个 UI 行
加 9 个浏览器专属行（每个都写了理由），公式化复制 surface 值与 agent plane 的
disable。`scripts/check-composition.mjs` 断言结果"仍然是个大脑"。

> 第一版从 master 派生，多出一行 `authentication-token`。而 `0.2.2-rc.3` 根本没
> 发布那个包，节点启动报 `1 entry did not activate: Cannot find package …`。
> 组合必须描述它要**启动进去的那个运行时**，所以默认源改成"已安装的 release"。

### 3.4 节点仍然没有模型和密钥

组合决定"加载哪些插件"，不决定"用什么模型、用谁的 key"。这两件事每次 `connect`
同步，全部由本机驱动：

1. **配置**：本机活的 provider 路由、默认模型、权限预设写进节点的
   `~/.dsh/profiles/fleet/cordis.patch.yml`。这是节点**自有 profile** 的配置层，
   也正是节点宿主会热重载的文件之一 —— 改完立刻生效，**不重启、不断会话、不用重连**。
2. **凭据**：那些行点名的 key 在本机 `credentials.resolve()` 取值，通过节点自己的
   `credentials/set` 推进节点凭据库。
3. **跟随**：本机订阅自己的 `app-boot/config-reload` 与 `credentials/reference-updated`，
   本地一改配置或换 key，就给所有已连接节点重新下发一次。

> 早期版本用 `--patch` 传一份 overlay。实测发现它**不在 HMR 的监视列表里**
> （上游只 watch profile patch 和 home patch），所以改配置必须重启节点宿主，
> 而且只在连接时同步一次。换成节点自有 profile 的 patch 后，两个问题都消失。
> 实验记录见 [`docs/adr-0001-node-config-carrier.zh.md`](docs/adr-0001-node-config-carrier.zh.md)。

三步都幂等（内容摘要决定要不要重写）。只有 **brain bundle 的代码**变了才重启宿主 ——
模块要重新 import，那是唯一需要重启的情形。

---

## 四、证据

不是"应该能用"，是跑过。

**工具真的在节点上跑**（`test/tool-parity.mjs`）：agent 自己调用了
`read`×2 / `write` / `edit` / `grep` / `glob` / `bash`，全部打 `/root/fleet-second/…`
真实路径，无路径类失败，整份 transcript 里**没有任何 Windows 路径**。

**那三个当初必坏的工具**（`test/tool-git-image.mjs`）：

```
git log        → 2de1061 initial commit
read_image     → image/png image, 4x4 px, 75 bytes
grep           → 命中 module.exports
```

**节点确实是个大脑**（实测 192.168.x.x / DSH 0.2.2-rc.3）：

```
profile bundles : @deepseek-ai/dsh-base + @local/dsh-fleet-brain
composed rows   : 138    (top-level rows; presets add 108 nested rows)
dsh-client-ui-* : 0
web-runtime     : 0
```

**测试矩阵**：31 个套件，分三层，由 `test/run-all.mjs` 一次调度（`--list` 打印完整清单）。

| 层 | 数量 | 套件 | 需要什么 |
|---|---|---|---|
| `offline` | 11 | `routing`、`routing-extra`、`multipart`、`provision`、`waterfall`、`version`、`picker-paths`、`install`、`autoconnect`、`fleet-control`、`composition` | 其中 9 个只要 Node 22；`provision` 与 `composition` 要装好的 DSH（读 `app.asar`） |
| `contract` | 3 | `descriptor`、`dispatch`、`upstream` | 装好的 DSH，必须用它的 Electron Node 跑 |
| `e2e` | 18 | `gateway`、`host-routing`、`workspace-flow`、`workspace-browse`、`picker-flow`、`plugin-switch`、`tool-parity`、`tool-git-image`、`client-bundle`、`event-relay`、`session`、`terminal`、`multi-node`、`artefact`、`npm-install`、`approval`、`node-control`、`browser` | 运行中的 Host + SSH 可达的节点 |

```bash
node packages/dsh-fleet/test/run-all.mjs                     # 全部
node packages/dsh-fleet/test/run-all.mjs --layer offline,contract   # 不需要节点的那两层
```

端到端层里有两个套件真的在节点上装东西：

- `artefact` 从加速站下载一份 165 MiB 的运行时（候选只有 `DEFAULT_MIRRORS` 里的加速站，
  **不回退直连 GitHub**）；加速站全挂时它以 `ARTEFACT_UNAVAILABLE` 退出并被记成 SKIP。
- `npm-install` 让节点自己 `npm install` 同一版本，证明兜底路线留下的树带着构建戳、解析到了
  节点自己的原生包、且 `node-pty` 的 `spawn-helper` 可执行。节点连不上 registry 时退出码 3，
  同样记成 SKIP。实测参考节点 26–33 s。

换加速站改 `packages/dsh-fleet/src/remote/artefact.js` 的 `DEFAULT_MIRRORS`。`browser` 套件需要
一个带 `--remote-debugging-port` 的 Chrome，默认不跑。

---

## 五、怎么用

### 安装

```bash
# 1. 从 npm 装（推荐）
dsh plugin --profile desktop add -w @greatbaby/dsh-fleet

# 2. 或从打包好的 tarball 装（离线环境）
npm pack --pack-destination dist        # 在 packages/dsh-fleet 下执行
dsh plugin --profile desktop add -w ./dist/greatbaby-dsh-fleet-<version>.tgz

# 3. 或从源码目录装（开发时用，pnpm 会记成 link:）
dsh plugin --profile desktop add -w <本仓库的绝对路径>/packages/dsh-fleet
```

三种形态都由 DSH 自己的安装器支持；安装后 profile 的 `dsh.profile.bundles` 里必须把
本插件排在 `@deepseek-ai/dsh-base` 之后（桌面端还要排在 `dsh-web-app` 之后）。
`engines.dsh` 钉住了运行时范围，DSH 版本不匹配时安装会被直接拒绝，而不是只组合一半。

**从 0.5.0 之前的版本升级**：包名变了（`@local/dsh-fleet` → `@greatbaby/dsh-fleet`），
旧名已无法安装也不会再更新。先 `dsh plugin --profile <p> remove @local/dsh-fleet`，
再用新名安装，最后把 profile 的 `bundles` 里的旧名换掉。节点侧不需要做任何事。

### 加节点

在 DSH 的**设置 → Remote nodes**（或侧栏的 Remote nodes 面板）里加节点
（host / 端口 / 用户 / 密码或私钥），点连接。首次连接会自动在节点上装同版本 DSH、
装大脑组合、下发模型与密钥、启动，然后验证 `session/list` 真的能答 ——
只有它成功才报 connected。

节点要求：Node ≥ 22，以及 `curl`（或 `wget`）与 `npm` **至少有一个**。别的都由插件准备。

节点上的 DSH 有两条来路，按顺序试：先下 Release 制品（一次 165 MiB 下载，可离线复用），
拿不到就让节点自己 `npm install` 同版本（实测 26–33 s / 673 包）。所以上游发新版、制品还没打
时不会卡住，最坏是一次慢一点的连接。两条路都会把版本戳写进树里，下次连接认得出来；
**制品字节坏了**（校验和不符、归档里没有 CLI）仍然报错并回滚，不会从 registry 再下一次。
配置 `runtime: 'artefact'` 或 `'npm'` 可强制单条路线，排查时用。

### 在手机上用

装 `ds-harness-remote`，手机端连到这台桌面 Host。远程会话就是普通的
`session/list` 行，所以它们出现在同一个侧栏里；节点的文件系统挤进同一套路径语法：

```
/@fleet                       → 节点列表
/@fleet/<nodeId>/             → 那台机器的文件系统根
/@fleet/<nodeId>/root/proj    → 那台机器上的 /root/proj
```

`directoryPicker/list` 对两类机器都答，用这种路径调 `workspace/create` 会**在节点上**
建工作区。这个前缀是节点的保留命名空间，直接拿它建工作区会被拒绝。

手机端的 `harnessRemoteAllowlist` 是一份客户端常量，能发哪些端点由它决定 ——
Host 侧放宽没有用。已知的一个缺口：它放行 `subagents/interruptByParent`，而
0.2.2-rc.3 的真实端点是 `subagents/interruptByUser`，所以手机暂时无法中断子代理。

### 节点控制模式

新会话可以选 `node-control` 预设：那个预设的工具集只有 `fleet_nodes` 一个工具，
没有文件、shell、搜索、网络、子代理。用它可以增删节点、连接、查状态；
密钥只接受引用（`{"kind":"key","path":"~/.ssh/id_ed25519"}` 或 `{"kind":"password","env":"NAME"}`），
不接受内联粘贴 —— 工具参数会写进会话日志。

### 跑测试

测试要自己给节点（源码里**没有默认 IP 和默认密码**，这是公开仓库）：

```bash
export DSH_FLEET_TEST_HOST=192.0.2.10
export DSH_FLEET_TEST_USER=root
export DSH_FLEET_TEST_PASSWORD=...
node packages/dsh-fleet/test/run-all.mjs --layer e2e
```

---

## 六、文档

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 路线取舍、五处缝隙、身份编码、为什么"不做镜像"是功能 |
| [`docs/adr-0003-phone-control.zh.md`](docs/adr-0003-phone-control.zh.md) | 手机 → 中转 → 桌面 → 节点这条链路的调研与硬边界 |
| [`docs/adr-0004-node-control-and-picker.zh.md`](docs/adr-0004-node-control-and-picker.zh.md) | `/@fleet` 命名空间、选择器接管、节点控制、安装形态 |
| [`docs/adr-0005-release-and-maintenance.zh.md`](docs/adr-0005-release-and-maintenance.zh.md) | 包名依据、发布形态、三条升级链 |
| [`docs/adr-0006-node-runtime-supply.zh.md`](docs/adr-0006-node-runtime-supply.zh.md) | 节点运行时从哪来：制品优先、节点自建兜底，以及为什么拿不到不等于拿到了坏的 |
| [`packages/dsh-fleet/README.md`](packages/dsh-fleet/README.md) | 插件安装、接线、测试矩阵、已知限制 |
| [`packages/dsh-fleet-brain/README.md`](packages/dsh-fleet-brain/README.md) | 节点组合：怎么从官方 web-app 减出"只当大脑"的一层 |
| [`packages/dsh-fleet/docs/UPGRADE.zh.md`](packages/dsh-fleet/docs/UPGRADE.zh.md) | DSH / 中转 / DSH Go 三条升级链各自要重跑什么 |
| [`CHANGELOG.md`](CHANGELOG.md) | 每个版本改了什么、谁受影响 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 怎么跑测试、怎么自己构建节点运行时、改代码时的硬约束 |
| [`AGENTS.md`](AGENTS.md) | 本仓库的协作规则与硬约束 |

## 七、许可

[MIT](LICENSE)，Copyright (c) 2026 zzyyyds88。`reference/` 下的上游源码各归其原作者
（DSH 是 MIT，ZCode 见其仓库）。
