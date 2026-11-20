# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

三条规则：

- **改了运行时行为 → minor**，**只改文档与元数据 → patch**，**破坏既有安装或身份语义 → major**。
- 每条都说清「谁受影响」，因为这套东西的读者是「装它的人」，不是写它的人。
- 与 `docs/ARCHITECTURE.md` 的章节对应，细节不去那边重复。

## [未发布]

### 变更（破坏性）

- **节点运行时改由本项目从 fork 编译，npm 兜底路线删除。** 节点跑的不再是上游 npm 发布版，
  而是本仓库对上游源码 fork 后编译、裁剪出来的树：删掉浏览器面（62 个 `dsh-client-ui-*`）、
  Office 引擎（339.5 MiB）、实验性 bundle 与 CUA，解包 **2014.6 MiB → 408.6 MiB**，归档
  **165 MiB → 87.6 MiB / 41 846 文件**。理由：组合层能决定加载哪些行，决定不了磁盘上有哪些包，
  也决定不了那些行里面的代码。见 [`docs/adr-0007`](docs/adr-0007-fork-node-runtime.zh.md)。
  **受影响**：所有人 —— 跟着上游从自动变成手动，上游发版后节点在新制品发出来之前连不上。
- **`npm install` 兜底整条删除，`RUNTIME_ROUTES` 常量、`runtime` 与 `registry` 配置项一起删。**
  那条兜底装的是上游发布版，却写同一枚 `{"build":N,"via":"npm"}` 的戳，于是一次网络抖动就会把
  节点永久钉在上游版本上，而界面显示「已就绪」。留着它比删掉它更危险，所以不是关掉开关。
  拿不到制品现在**报错**并逐条列出试过的 URL。「拿不到 ≠ 拿到的是坏的」不变：校验和/解包失败
  仍然回滚后抛错。**受影响**：所有配置里写过 `runtime:` / `registry:` 的人（键被忽略）。
- **`RUNTIME_BUILD` 3 → 4。** 树的内容变了（少了 500 MiB 包、多了 fork 的字节），版本号表达
  不了这件事。所有在用节点会在下一次连接时重装一次。
- **`mirrors` 配置项删除，`DEFAULT_MIRRORS` 退役成 `RETIRED_MIRRORS`。** 国内节点连不上
  GitHub，加速站的前提不成立；而且它们实测抖动 40 倍（0.2–9.6 MB/s）。`DEFAULT_SOURCES`
  现在只有 CNB 一条，`{kind:'prefix'}` 仍支持，所以接私有镜像是一个配置值。GitHub Release
  仍收到同一份字节作灾备与留档，节点不从那里取。**受影响**：设过 `mirrors` 的人。

### 新增

- **`build-fork-runtime.mjs`：一条命令完成 fork 编译、裁剪、打包、上传。** `--reuse` 复用
  已解包的树（只改裁剪规则时几十秒）；`--publish` 传 GitHub Release，`--cnb` 传 CNB。
  `trim-fork-runtime.mjs` 是裁剪规则的唯一来源（`DROP_RULES` 每条带理由），
  `ARTEFACT_RESIDUE` 也被 `publish-runtime.mjs` import，两份清单不会漂成两个字节。
  `test/fork-runtime-unit.mjs`（34 条断言）守着留什么、删什么、以及两条载重规则。
  **受影响**：维护者。
- **制品改从 CNB 下载，现在它是唯一的源。** `artefactUrls()` 的源是对象数组
  （`{kind:'template', template}` / `{kind:'prefix', prefix}`）。实测参考节点拉
  91 839 618 字节整档：CNB **17.6 s、重复测量抖动 <1%**。抖动才是问题：同样的节点同样的归档，
  有时半分钟有时一小时，读起来就是「连接卡住了」。**受影响**：所有人。
- **插件本体改由 CNB Release 的 tarball 分发。** `dsh plugin add -w https://…/*.tgz` 是 DSH
  安装器的原生形态（`install-spec.js` 对 http(s) tarball 有明确分支），所以不再依赖 npm 上还
  留着哪个版本。桌面端会话里的 `plugin_manager(action='install_bundle', target=<该 URL>)`
  走同一个安装器，所以「让 agent 装」不需要敲命令。**受影响**：新安装的人。
- **断线现在看得见，并且会自动重连。** SSH socket 掉了之后 `state` 原来一直是 `connected`：
  卡片是绿的、侧栏还列着那台机器的工作区，而任何调用都回 `fleet/node-offline` —— 一个界面上
  从未出现过的状态。现在 `close` 事件（排除 `invalidate`/`dispose` 这两条主动路径）上报给
  `Fleet`，状态落 `idle` 并记 `droppedAt`；重连是 2s/4s/8s 三档，之后每 2 分钟，直到成功或
  用户点断开。**受影响**：所有节点。
- **失败可归因：稳定错误码 + 一个动作 + 是否可重试。** `core/errors.js` 把每次失败分类成
  `{code, message, action, retryable, detail}`，判定顺序是「显式 code > SSH category > phase
  推断 > unknown」。密码错**不配重试按钮** —— 按了只会得到同一次失败。失败的 phase 也不再被
  清空，所以阶段列表停在出错的那一格。
- **每个节点自带最近 100 行连接日志**，写入即脱敏（`password=` / `token:` /
  `Authorization: Bearer` / 私钥块 / `ssh://user:pass@host`），路由
  `/fleet/api/nodes/<id>/log`，卡片上可展开、可复制。
- **主机密钥首次记录、之后每次都验。** `hostVerifier` 从写下的第一天起就在读
  `target.hostFingerprint`，但全仓库没有一处给它赋过值 —— 于是每次都走「首次」分支并
  `verify(true)`。这条链是死代码，中间人可以无条件接管连接。现在首次握手写进
  `NodeRecord.hostKey`，之后不符就拒绝并把两侧指纹写进日志。
- **手机端选择器首屏是设备层。** 手机调用 `directoryPicker/list` 不带 path，原来返回的是
  **桌面机自己的 home**，手机永远出不去本机；`/@fleet` 只有主动拼路径才到得了，而手机界面上
  没有入口。现在首屏是「此设备 + 各已连接节点」。
- **每台设备记住上次用的目录**，设备列表按最近连接排序，超过两台才给搜索框。

### 修复

- **拿不到 `.sha256` 不再等于「不校验就装」。** 原来的校验步骤是 `if fetch …; then`，镜像只要
  漏发边车文件，整个比较就被跳过，未经验证的字节直接解包 —— 正是校验和存在的理由。现在缺边车
  以退出码 6（`ARTEFACT_CHECKSUM_UNAVAILABLE`）失败并回滚，与「源没给」（码 3）、「字节坏了」
  （码 4）分开报。**受影响**：源上少发了 `.sha256` 的部署。
- **下载超时不再被 SSH 层提前掐断。** `curl --max-time` 是 30 分钟，而 `install` 那次 `exec`
  只等 15 分钟：慢线路上 curl 还在正常下载，Host 这边先 `KILL` 了 channel，而 `channel.close()`
  并不会收掉远端的 `curl`（`budget-recovery` 探针实测过）。现在 exec 超时跟随
  `FETCH_CEILING_SECONDS + 60s`。**受影响**：线路慢或归档大时的首次安装。
- **制品字节坏了仍然报错，不会被重试。** 校验和不符、解包失败、归档里没有
  `node_modules/@deepseek-ai/dsh/lib/bin.js`（退出码 4/5）一律回滚到 `runtime.previous` 后抛错：
  重试同一个坏源只会更慢、下载更多，还会把「哪个源坏了」掩盖掉。这条在删掉 npm 兜底之后仍然
  成立，而且更强 —— 现在根本没有第二条路可以「再来一次」。
- **构建戳必须写，否则每次连接重装。** `inspectRuntime` 会把无戳的树读成「早于构建戳」→
  `decideGate` 返回 `node-runtime-repack` → 重装，一分钟的安装变成一分钟的连接。`parseStamp`
  仍认旧格式的裸整数，现场节点的 `2` 不会因为换格式被判不可用；`npm` 这个 `via` 值也仍被读取
  （旧节点带着它），只是不再有代码写它。
- **归档里不再混进打包机的原生产物。** 包的 `install` 脚本按**打包机**的 `process.platform`
  跑，koffi 的 `cnoke` 于是在 Windows 上编出 `koffi/build/win32_x64`。实测那份 rc.5 归档里有
  48 个 `.exe`/`.cmd`/`.dll`/`.lib` 和 147 条 `koffi/build` 条目，全在一个 `linux-x64` 制品里。
  打包改为 `--ignore-scripts`（树里每个原生依赖都自带预编译平台包；实测 968.2 → 957.3 MiB，
  四个原生模块都在）。
- **节点解包时补回 `spawn-helper` 的可执行位。** 实测 bsdtar 在 Windows 上给每个条目写
  `-rw-rw-rw-`，`chmodSync` 是空操作，`--owner/--group` 也改不了。Darwin 节点上
  `node-pty/prebuilds/*/spawn-helper` 因此不可执行，终端在**第一次打开时**才失败，错误信息
  一个字都不会提到这个文件。现在 `installScript` 解包后自己 `chmod 0755`。这一条同时修好
  已经发出去的归档。
- **节点掉线时工作区行不再消失。** `RemoteWorkspaces.sync()` 原来只要节点不在 `routable()`
  里就把整份 baseline 丢掉 —— 断线那一刻侧栏里整台机器的工作区消失，一分钟重连成功后又回来。
  现在只有**记录被删**才丢行，只是连不上时行留着并标 `offline`。
- **插件树不再塞进命令行，SSH 连接不再被 sshd 判损坏。** 节点 `auth.log` 里长期刷
  `Bad packet length 88734736.` + `Connection corrupted`，fleet 随即报节点掉线，端到端
  长期停在 `13 passed, 4 failed`。真因不是加密、并发或运行时，而是命令行的长度：ssh2 把一次
  `exec` 请求当成**一个** SSH 包发出去（`Protocol.js:1273`），OpenSSH 的 `PACKET_MAX_SIZE`
  是 256 KiB，超了之后服务端不回错误、而是流位置错乱。`writePluginBundle` 当时把整棵插件树
  base64 拼进命令行，`dsh-whale-widget` 在磁盘上 5.9 MB，拼出来 **7,923,386 字节**，与日志里
  那个 `7923616` 差 230 字节（脚本尾部）。单连接量出来的边界：命令行 262,000 字节干净、
  262,200 字节六条连接全坏，而同样内容走 stdin 不论多大都干净。两个 writer 的 payload 改走
  stdin，`SshConnection.exec` 另加 `MAX_COMMAND_BYTES = 128 KiB` 的本地闸门。
  **受影响**：所有在节点上开过插件的安装（本地 `link:` 插件尤其重，因为它的整棵树都要复制）。
  新增 `offline/packet` 套件守着。实测修完：全量 **34 passed, 0 failed, 1 skipped**，
  节点侧损坏计数跑前跑后都是 2024（+0）。
- **通道预算满时重连，而不是一直等。** 十次长 exec 会把一条连接的 `MaxSessions` 用满，而
  `channel.close()` 在远端命令还活着时并不归还名额 —— 实测那条连接在整个 40 s 观察窗口里
  一直拒绝新通道。现在先在同一条连接上短退避重试，仍不行才丢连接重新握手换一份空预算；
  后者不报掉线、不走重连阶梯，节点保持 `connected`。
- **凭据没变就不重建连接。** `NodeRuntime.adopt()` 原来每次把记录读回来都 `invalidate()`，
  于是刚连上的节点立刻被自己踢掉。现在只有 host / port / username / 认证方式真的变了才重置。
- **兜底的 `pkill` 不再杀掉自己。** `RemoteHost.stop()` 在没有 status 文件时跑
  `pkill -f '…/lib/bin.js'`，而执行它的 `sh -c` 自己的 argv 里就带着这个模式，于是把自己杀掉、
  channel 无退出码。实测普通模式 `{"out":"","code":null}`、`bin[.]js` 这种方括号写法
  `{"out":"SURVIVED","code":0}`，且仍然杀到了真正的 resident host（节点上 2 个变 1 个）。
- **空补丁写成 `[]` 而不是空文件。** 一个没有行的 patch 文件会让 Loader 报语法错，看起来像
  插件没装好。

### 说明

- `RUNTIME_BUILD` 从 2 升到 3（打包规则与戳格式都变了），节点会在下一次连接时重装一次。
- **发布侧补了两道闸门，都是「代码里写着、但只有一句注释挡着」的地方。**
  `publish-runtime.mjs` 不带 `--cnb-only` 时会用 `pack()` 现打一棵上游树（registry 解析、
  无 fork、无裁剪），而它和节点下载用的是同一个上传路径：同名、同版本、校验和自洽，
  换掉之后下载侧看不出来。现在 `assertPublishable()` 在两条上传路径前抛出，唯一出口是
  `--cnb-only`。另一道是 `releaseNotes()` 原来按 `--out` 目录里有什么就写什么，一个撤掉的
  平台只要本地还留着一份旧归档就会重新出现在发行说明里、还带一个看起来合法的 sha256；
  现在按 `PUBLISHED_PLATFORMS` 过滤。`test/fork-runtime-unit.mjs` 两条都守着。
- **节点不升 Node 24，`MINIMUM_NODE_MAJOR` 保持 22。** 上游 `engines.node` 写的是
  `>=24.9.0`，但 305 个依赖包里真正的 Node 24 API（`Promise.try` / `RegExp.escape` /
  `Float16Array` / `node:sqlite`）是 **0 处**，唯一的 `await using` 命中是 acorn 解析器里的
  字符串字面量；`workflow-ptc` 在节点组合里是 `disabled: true`，加载不到。抬高门槛的唯一
  后果是一部分现场机器连不上。依据见 `docs/adr-0006-node-runtime-supply.zh.md` §四-2。
- **节点上装插件时，npm 不再顺手把 DSH 自己拉下来。** 第三方 bundle 的
  `peerDependencies` 写的是 `@deepseek-ai/dsh-*` 的区间（`^0.2.0-rc.1` 之类），
  npm 满足 peer 的办法是把那个包**装进节点的 profile**，而 profile 的
  `node_modules/@deepseek-ai/` 解析顺序在运行时树之前。实测：节点运行时是
  `0.2.2-rc.3`，装一个插件后被塞进 `dsh-session@0.2.0-rc.2`、`dsh-agent@0.2.0-rc.2`
  等 32 个包，常驻 host 报 `2 required plugins did not activate`、不打 URL，
  `connect` 只报一段日志尾巴。`RemoteHost.installPlugins` 现在固定带
  `--legacy-peer-deps`：运行时树是这些包的唯一来源，插件不许把 DSH 一起带来。
  **受影响**：所有在节点上打开过插件的安装。已坏掉的节点重连一次即可自愈
  （下一次 `npm install` 会把多出来的 `@deepseek-ai/*` 剪掉）。
- **一个新 profile 必须先由 DSH 自己创建。** DSH 创建 profile 时会写全
  `package.json` + `cordis.patch.yml` + `pnpm-workspace.yaml` 三件套；手搓一个只有
  `package.json` 的目录会得到一个看起来像 profile 的空壳，`pnpm add -w` 报
  `--workspace-root may only be used inside a workspace`，DSH 把它当成安装失败。实测撞过。
- **DSH 0.2.2-rc.3 → rc.5 已核实，零改动。** 从已安装的 rc.5 重新派生节点组合后
  `git diff` 为空（上游只删了 `authentication-token` 与 `ui-session-status` 两行，都在被丢掉的
  那一侧），契约层 3 个套件全过，手机端那个端点名 `subagents/interruptByUser` 在 rc.5 里也
  没变。**受影响**：无需动作，节点在下一次连接时自己装 rc.5。
- **测试矩阵从 31 个套件变成 35 个**（`offline` 11 → 14，新增 `fleet-lifecycle`、`errors`、
  `packet`）。`e2e/gateway` 的依赖声明从 `needs: 'node'` 改成 `'host'`：它读的
  `status.json` 只在**本机 Host 连上节点**之后才指向一个活着的进程，声明成 `'node'` 会让它
  在冷启动时第一个跑、读到上一轮留下的死 pid。

## [0.5.1] — 2026-11-18

**只改发布元数据，运行时行为与 0.5.0 相同。** 0.5.0 已经发到 registry，同号不能再发，
所以命名空间更正随这个 patch 版本出。

### 修复

- **包名从 `@zzyyyds88/dsh-fleet` 改为 `@greatbaby/dsh-fleet`。** 原计划的 scope
  是照着 GitHub 用户名取的，但 npm 的 scope 只认**账号名或组织名**，而发布账号叫
  `greatbaby`：`npm access list packages '@zzyyyds88'` 返回 `404 Scope not found`，
  发布时报 403。`@greatbaby` 是账号自己的 scope，注册即得，不必另建组织。
  GitHub 仓库地址（`github.com/zzyyyds88/dsh-fleet`）不受影响，那是另一件事。

### 说明

- 0.5.0 在 registry 上是一个**未被引用的历史版本**（发布时名字还叫 `@zzyyyds88/...`，
  而那个 scope 不属于本账号，所以它从未真正可安装）。以 0.5.1 为准。
- registry 上还有一个 `0.0.0-stage` 占位版本，是 npm 暂存发布流程自动建的，不是本项目发的。

## [0.5.0] — 2026-11-18

**发布形态变更，已安装的用户要重装一次。** 包名从 `@local/dsh-fleet` 改为
`@greatbaby/dsh-fleet`：`local` 这个 npm 作用域属于他人的组织，`dsh-fleet` 这个包名
已被人占用。旧名已无法安装，也不会有更新。替换命令见下。

### 变更

- **包名改为 `@greatbaby/dsh-fleet`**，并发布到 npm。安装不再需要先 clone 仓库：
  `dsh plugin --profile <p> add -w @greatbaby/dsh-fleet`。
  从旧名迁移：先 `dsh plugin --profile <p> remove @local/dsh-fleet`，再用新名安装，
  最后把 profile 的 `dsh.profile.bundles` 里的旧名换成新名。
- 客户端插件 id 与包名同步（DSH 要求二者相等），因此浏览器半会重新注册一次。
- 本包不再是 `private`，补齐 `repository` / `license` / `keywords` 等 npm 元数据。

### 移除

- 被跟踪却早已过期的 `packages/dsh-fleet/package-lock.json`（写的是 0.1.0）。
  profile 的依赖一直由 pnpm 管理，这份 lock 从未参与任何安装。

### 文档

- 新增 `LICENSE`（MIT）。
- 新增 `docs/adr-0005-release-and-maintenance.zh.md`：包名依据、发布形态、三条升级链。
- `UPGRADE.zh.md` 补中转插件与 DSH Go 两条升级链 —— 此前只覆盖 DSH 本身，
  而这两条是无声失效的来源。
- 根 `README.md` 修掉五处与代码不符的表述，安装章节改为 npm 优先。

## [0.4.0] — 2026-11-18

### 新增

- **节点控制模式**：agent preset `node-control` + `fleetControl` 服务 + 只注册一个工具的
  `./node-control` 入口。该预设的工具集就是它的 `config.plugins`，因此「除节点管理外一律拒绝」
  是组合属性，不是运行时判断。密钥只收引用、拒绝内联，因为工具参数会写进会话日志。
- **`/@fleet/<nodeId>/…` 路径命名空间**：手机用同一套「本机绝对路径」语法就能浏览与选择
  节点目录。中转在 dispatch 前会 `mkdir -p`，这个前缀把它的落点限制在 `<盘>:\@fleet\` 之下，
  fleet 在工作区建好后自底向上 `rmdir` 空目录链 —— 精确清理，不是启发式。
- **目录选择器由 fleet 整体替换**（不是装饰）：桌面上 `directory-picker-auto` 解析成 native
  后端，原生 `list` 会 `requireCapability("browse")` 抛错，中转随即改用自己那份实现，
  继承式的装饰永远调不到。
- **A 类端点补路由**：`goals`、`userQuestions`、`subagents`、`commands`、`messageFeedback`、
  `sessionReferenceResolver`、`fileReferences`、`schedule`。这批的共同形态是「不路由不报错，
  只是回答这台 Host 的」—— 目标条消失、斜杠命令列本机的、`@` 补全给 Windows 路径。
- **插件下发默认全开**，另加 `NODE_NEVER_SYNC` 硬排除清单（本插件、brain bundle、中转插件）。
  理由：装了插件又连了节点的人要的是一套工作环境，不是一个悄悄不同的第二套；
  而「哪些绝不能被送到节点」必须逐条列举，不能靠命名空间推断。

### 变更

- `dsh.bundle.patch` 从字符串改为有序数组，新增 `presets/node-control.patch.yml` 一层。
- 补 `engines.dsh`（`>=0.2.2-rc.3 <0.3.0`）：不满足范围的 DSH 直接拒装，而不是半组合。
- `files` 补上 `presets/*.patch.yml`，并补上此前一直缺失的 `docs/DETAIL*.md` 与 `preview.svg`
  （`meta.detail` 指向不存在的文件时，详情页会显示失败而不是回退到 README）。

### 修复

- 已跟踪文档里的真实内网地址与公网域名换成占位符（本仓库是公开的），`install-unit` 现在会拦。

## [0.3.0] — 2026-11-16

### 新增

- 节点侧组合 `@local/dsh-fleet-brain`：从官方 `dsh-web-app` 派生，减去浏览器面，
  节点 profile 只组合 `dsh-base` + brain，浏览器面**根本不加载**（不是加载后禁用）。
  派生而非手写的理由：`web-app` 有 621 行且每个 release 都在变，手抄会腐烂。
- 插件同步单位从「节点组合里的行」改为「用户安装的 bundle」。

### 说明

首个正式插件版本。此前是原型阶段，没有对外安装形态，不列。
