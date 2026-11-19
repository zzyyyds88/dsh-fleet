# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

三条规则：

- **改了运行时行为 → minor**，**只改文档与元数据 → patch**，**破坏既有安装或身份语义 → major**。
- 每条都说清「谁受影响」，因为这套东西的读者是「装它的人」，不是写它的人。
- 与 `docs/ARCHITECTURE.md` 的章节对应，细节不去那边重复。

## [未发布]

### 新增

- **制品拿不到时，节点自己构建运行时。** 上游 DSH 每发一版，所有节点原来都卡在「维护者还没
  构建并上传 165 MiB 制品」上 —— 而那件制品的内容本来就是在节点上跑一次
  `npm install --os/--cpu/--libc '@deepseek-ai/dsh@<版本>'` 能得到的东西。现在
  `RemoteHost.install` 有两条有序路线（`RUNTIME_ROUTES = ['artefact', 'npm']`）：先试制品，
  制品**拿不到**（所有源全挂、没有 `curl`/`wget`、`mirrors: []`、平台打不出标签）就让节点
  自己解析同一版本。实测参考节点：制品是 162 MiB 下载，自建是 26–33 s / 673 包。
  **受影响**：所有人。上游升级不再需要等任何人；最坏情况是一次慢一点的连接。
- **配置新增 `runtime: auto | artefact | npm`（默认 `auto`）与 `registry`。** 强制单条路线
  是为了让失败可归因，排查「节点自己的 registry 通不通」时直接 `runtime: 'npm'`。
  节点卡片会显示这一棵树是下载的还是自建的。
- **制品改从 CNB 主源下载，GitHub 加速站降为灾备。** `artefactUrls()` 原来只会给 GitHub 官方
  URL 加前缀，表达不了 CNB 的 `-/releases/download/<tag>/<file>` 形状；现在源是对象数组
  （`{kind:'template', template}` / `{kind:'prefix', prefix}`），`DEFAULT_SOURCES` 里 CNB 排第一。
  实测参考节点拉 170 092 405 字节整档：CNB **4 311 729 B/s、重复测量抖动 <1%**，同一时段
  `gh.inkchills.cn` 178 047 B/s，四个加速站历史区间 0.2–9.6 MB/s（**抖动 40 倍**）。抖动才是
  问题：同样的节点同样的归档，有时 34 s 有时一小时，读起来就是「连接卡住了」。
  **受影响**：所有人。`mirrors: string[]` 继续可用，`mirrors: []` 仍是「关掉制品路线」的写法。
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

- **制品字节坏了仍然报错，不会从 registry 再下一次。** 校验和不符、解包失败、归档里没有
  `node_modules/@deepseek-ai/dsh/lib/bin.js`（退出码 4/5）一律回滚到 `runtime.previous` 后抛错：
  同一份坏版本从 registry 再解析只会更慢、下载更多，还会把「哪个源坏了」掩盖掉。
  这次翻转只改「拿不到」，不改「拿到了是坏的」。
- **npm 路线原来不写构建戳，接成兜底后会变成每次连接重装。** `inspectRuntime` 会把无戳的树
  读成「早于构建戳」→ `decideGate` 返回 `node-runtime-repack` → 重装，一分钟的安装变成一分钟
  的连接。两条路现在写同一枚戳（`{"build":3,"via":"artefact"|"npm"}`）；`parseStamp` 仍认旧格式
  的裸整数，现场节点的 `2` 不会因为换格式被判不可用。
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

### 说明

- `RUNTIME_BUILD` 从 2 升到 3（打包规则与戳格式都变了），节点会在下一次连接时重装一次。
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
