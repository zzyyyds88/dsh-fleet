# ADR-0004 手机入口的四处适配：路径命名空间、选择器、节点控制、安装形态

> 状态：已定（2026-11-18）。上承 [ADR-0003](adr-0003-phone-control.zh.md)。
> 约束不变：**不改 DSH Go、不改中转插件**，全部工作落在 `packages/dsh-fleet` 与它的安装形态上。
> 每节写「决策 / 被否方案 / 理由」，被否的都是这次调研里真的考虑过、并且**有证据**才否掉的。

## 一、背景：四个卡点

ADR-0003 定下了链路（手机 → 中转 → 桌面 Host → 节点）。真按它做时，桌面这一端有四处接不上：

| # | 卡点 | 现状 |
|---|---|---|
| 1 | 手机的选择器说的是「本机绝对路径」，节点路径没有语法位置 | `directoryPicker/list` 被中转接管、fleet 的装饰根本调不到 |
| 2 | 手机在节点上建工作区会先在桌面造出幽灵目录 | 中转在 dispatch **之前** `mkdir -p` |
| 3 | 「节点控制模式」不存在 | fleet 既不 `provide` 服务，也不注册工具 |
| 4 | 插件没走官方安装形态 | `dsh.bundle.patch` 是字符串、`engines.dsh` 缺失、`meta.detail` 指向不存在的文件 |

## 二、路径命名空间 `/@fleet`

### 决策

节点路径在同一个路径语法里用前缀表达：

```
/@fleet                       → 节点列表（每个已连接节点一条）
/@fleet/<nodeId>/             → 那台节点的文件系统根
/@fleet/<nodeId>/root/proj    → 那台节点上的 /root/proj
```

`<nodeId>` 是 `n` + 12 位十六进制，与 `host/routing.js` 里 `NODE_ID` 同一个正则，因此解码无歧义。

### 被否方案

| 方案 | 为什么否 |
|---|---|
| `fleet://<nodeId>/<path>` | win32 上 `isAbsolute('fleet://x') === false`，中转的 `ensureHostWorkspaceDirectory` 会在 dispatch **之前**抛 `INVALID_MESSAGE`，fleet 根本收不到请求。实测：`resolve('fleet://n123/root')` = `D:\ProjectHub\DSHpl\fleet:\n123\root` |
| 逐个节点试（现有 `startsWith('/')` 逻辑） | 只能选已经存在的目录，节点新目录选不到；而且多台节点上有同名路径时先到先得，用户无法表达「我要的是这台」 |
| 在手机端加一个「远程节点」快捷入口 | 要改 DSH Go。ADR-0003 §2.4 已定这条线不走 |

### 理由

- `/@fleet` 以 `/` 开头，过得了 `askFolderPath` 的 `startsWith('/')` 校验，也过得了中转的 `isAbsolute`。
- 前缀里带 nodeId，解码是纯字符串操作，不查表、不会漂。
- 节点上真有一个 `/@fleet` 目录时，编码结果是 `/@fleet/n…/@fleet/…`，仍然可解 —— 命名空间不会自撞。

## 三、幽灵目录：精确清理，不是启发式

### 问题（实测）

中转 `remote-directory-browser.js` 的 `ensureHostWorkspaceDirectory` 在 dispatch 之前执行
`mkdir(path, {recursive:true})`。win32 上 `/@fleet/n1/root/proj` 是 drive-relative，
落点是 `resolve('/@fleet/n1/root/proj')` = `<当前盘>:\@fleet\n1\root\proj`。

### 决策

1. **只让落点集中在一个位置。** 用 `/@fleet` 前缀而不是任意 POSIX 路径，于是所有幽灵目录都在
   `<盘>:\@fleet\` 之下，且 `\<nodeId>\` 是第二层 —— 与用户数据物理隔离。
2. **fleet 在 `workspace/create` 成功后自底向上 `rmdir`。** 从最深一层开始，逐级 `rmdir`（**非递归**），
   一旦 `ENOTEMPTY` 立刻停。删掉的一定是 `mkdir -p` 刚建出来的空链，不可能碰到有内容的目录。
3. `resolve()` 在**同一个进程**里算，与被装饰的 `mkdir` 得到同一个路径 —— 不需要时间窗、mtime 或「空」判定。
4. fleet 拒绝把本地工作区建在 `/@fleet` 命名空间里（`fleet/path-reserved`），保证这个前缀永远归 fleet。

### 被否方案

| 方案 | 为什么否 |
|---|---|
| 「mtime 在 120 秒内且为空才删」 | 是启发式：窗口内别的程序建的空目录也会被删。用 `/@fleet` 之后不再需要 |
| fork 中转插件把 `mkdir` 拦掉 | ADR-0003 §六 B 已定：fork 只做研究。而且它挡不住「其他客户端也不该在那个位置 mkdir」 |
| 事后扫全盘删空目录 | 破坏性不可控 |

### 边界

- 清理失败只记日志，不影响节点的成功结果（节点那边工作区是好的）。
- Host 不是 Windows 时，`/@fleet` 在 `/` 下是真实路径，同样的 `rmdir` 规则仍然成立。

## 四、选择器：fleet 自给自足

### 问题（实测）

桌面上 `directory-picker-auto` 解析后端：有显示器、不是 SSH 启动 → 选 **native**。
`DirectoryPickerController.list` 会 `requireCapability("browse")` 抛错，中转的 `needsDirectoryFallback`
命中后**改用中转自己的 `listRemoteDirectory`**。也就是说：**fleet 只在 `list` 上做「装饰」是永远不会被调用的。**

### 决策

fleet **整体替换** `directoryPickerController.list` 与 `.createDirectory` 两个方法（装成实例 own property，
`requireCapability` 不再执行），自己出结果：

| 端点 | 行为 |
|---|---|
| `list(path)` | `/@fleet` → 节点列表；`/@fleet/<id>…` → `listRemote(runtime.connection, remotePath)`，把 `path`/`home`/`crumbs[].path`/`entries[].path` 全部加前缀，`home` 固定为 `/@fleet`；其它 → `listLocal(path)` 并补 `crumbs` |
| `createDirectory(path, name)` | 父路径解码到节点 → `makeRemoteDirectory`，回带前缀的绝对路径；否则 `makeLocalDirectory` |

`browse.js` 的 `listLocal` 增加 `crumbs` 字段（纯增量，`/fleet/api/browse` 的消费者不受影响）。

### 被否方案

| 方案 | 为什么否 |
|---|---|
| 在 profile patch 里把 `directory-picker` 钉成 `-browse` 后端 | 能让 `requireCapability` 通过，但那是**改用户 profile 的组合**去迁就插件，且桌面 GUI 的原生选择器会一起变；插件应当能在默认组合上工作 |
| 只装饰 `list`，靠中转的 fallback | fallback 用的是中转自己的实现，fleet 拿不到执行点（见上） |

### 边界

- 手机端「新建文件夹」按钮**永远不出现**：`directoryPicker/createDirectory` 不在 DSH Go 的
  `harnessRemoteAllowlist` 里，`allowsEndpoint` 是纯本地判定，在发出之前就 `METHOD_NOT_ALLOWED`。
  这是 DSH Go 的硬边界，见 §六。
- 节点离线时 `/@fleet/<id>` 的 `list` 抛 `fleet/node-offline`，手机看到错误而不是空列表。

## 五、节点控制模式

### 决策

「模式」= 一个 **agent preset**，不是新的会话类型。

三个部件：

1. **`fleetControl` 服务**（host 平面）：`ctx.provide('fleetControl', …)`，方法
   `list / add / update / remove / connect / disconnect / status`，复用现有 `NodeRegistry`、
   `SecretStore`、`Fleet.connect/disconnect`。输出不含任何密钥字段。
2. **`fleet_nodes` 工具**（preset 平面）：新子路径 `@local/dsh-fleet/node-control`，只注册一个工具，
   参数 `action: list|add|update|remove|connect|disconnect`。工具**不 import 任何 `@deepseek-ai/*`**，
   靠 `inject = ['tools','fleetControl']` 拿服务。
3. **`preset-node-control` 声明**：`presets/node-control.patch.yml`，`config.plugins` 只有
   `persona` + `fleet-nodes`。

### 「其他拒绝」为什么是构造保证

web-app 的 patch 把 `tool-bash` / `tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-subagent*` /
`tool-web` / `tool-workflow` / `tool-jobs` / `tool-skill` / `tool-goal` / `tool-todo` /
`tool-plugin-manager` 在 host 平面全部 `disabled: true`，agent 平面的工具**只由 preset 的
`config.plugins` 供给**。本 preset 只列 `fleet-nodes`，这个会话就没有别的工具。

**不加 `ctx.tools.restrict`**：加了就是第二份清单，两份清单迟早不一致，而「preset 即能力全集」
本身就是这个仓库的组合语义。

### 密钥为什么不能作为工具参数

会话日志会原样记录工具参数。在聊天里贴密码等于写进历史文件。所以 `add` 只接受两种来源：

- `{ kind: 'key', path: '~/.ssh/id_ed25519' }` —— Host 上的私钥文件，读取后写入 `ctx.credentials`，
  路径与内容都不回显；
- `{ kind: 'password', env: 'DSH_FLEET_NODE_PW' }` —— Host 上的环境变量名。

内联 `password` / `privateKey` **不支持**。要在桌面设置页里填。

## 六、被控节点的插件清单

### 决策

1. 第三方 bundle **默认下发**（`resolvePlugins` 的 `sync` 默认值从 `false` 改为 `true`）。
2. 硬排除清单 `NODE_NEVER_SYNC`：`@local/dsh-fleet`、`@local/dsh-fleet-brain`、`ds-harness-remote`、
   `@dsh-remote/plugin`。在 `installedPlugins` 里**直接过滤**，不靠前缀规则推断。
3. 节点永远只组合 `dsh-base` + `@local/dsh-fleet-brain` 打底，第三方通过 profile 的 bundle 列表进；
   `dsh-fleet-brain` 的组合里**不含** `preset-node-control`。

### 理由

- `@local/dsh-fleet` 是桌面端的插件：节点装它没有意义，而且它的 preset 里含节点控制工具 ——
  被控节点能控制别的节点，正是用户明确否定的「被控节点再去控制其他节点」。
- `ds-harness-remote` 会让节点变成第二个中转 Host，暴露一个额外入口。
- 用户已定：第三方默认全开，别的不改，只加硬排除。

`isThirdParty` 的 `@deepseek-ai/*` 规则保留 —— 它回答的是「这是不是产品本身」，
与 `NODE_NEVER_SYNC` 回答的「这个不能进节点」是两件事，注释里写清。

## 七、安装形态

### 决策

`plugin_manager` 的 `install_bundle` 两种 target 都要能装上：

| 项 | 值 |
|---|---|
| `dsh.bundle.patch` | 数组 `["./cordis.patch.yml", "./presets/node-control.patch.yml"]`（上游 `bundlePatchFiles` 明确支持 string 或有序数组） |
| `engines.dsh` | 显式范围；具体值以真实 `install_bundle` 通过为准，不靠推断写死 |
| `files` | 加 `presets/*.patch.yml` |
| `locale.meta.detail` | 指向真实存在的 `docs/DETAIL.zh.md`（现在指向一个不存在的文件） |
| tarball | `scripts.pack = npm pack --pack-destination dist` + `postpack` 校验包内清单；`private: true` 保留 |

新增 `test/install-unit.mjs`（离线层）：`dsh.bundle.patch` 每个文件存在、`engines.dsh` 是合法 range、
`files` 覆盖所有运行物、`meta.detail` 指向真实文件。

### 理由

`meta.detail` 指向不存在的文件时，详情页在用户眼里是空白的，而这不会被任何测试发现 ——
清单自洽必须是可执行的断言，不能靠人看。

## 八、A 类端点补路由

ADR-0003 §六 A 列出 22 条「手机能发、中转放行、fleet 没路由」的端点。分两批：

**批次一（有身份，直接解码）**：`goals/*`（6）、`userQuestions/{answer,attachWait}`、
`messageFeedback/*`（3）、`subagents/{prompt,interruptByParent}`、`session/selectModel`、
`commands/execute`、`fileReferences/list`、`sessionReferenceResolver/candidates`。

**批次二（Host 级列表，合并 + id 包装）**：`schedule/catalog`、`schedule/list`、`schedule/history`
合并各节点并把 id 包成 `fleet_<nodeId>_<id>`；`schedule/view|edit|run|delete|deleteInactive`
按 id 解包路由；`schedule/create` 按 `sessionId` 解包。

**明确不路由**：`settings/*`、`agentPresets/*`、`credentials/*`、`llm/*`、`pluginManager/*`、
`pluginInventory/list`、`skills/list`、`session/modelCatalog` —— 它们描述的是**这台桌面安装**。

### 为什么 `session/modelCatalog` 保持本地是对的

provisioning 把桌面的 `llm-*` 行与 `agent-default-model` 复制成节点的 patch overlay，
所以两侧的名册同源（已在节点上核对：`llm-deepseek` 的 baseURL 与模型完全一致）。
手机给节点会话看到的就是节点真在用的模型 —— 路由到节点反而可能列出不一样的东西。

真正要补的是 `session/selectModel`：它的请求里有 `sessionId`，不路由的话给节点会话换模型
会打到本地一个不存在的会话上。

### `schedule/update` 不需要实现

手机在 0.2.2 上根本不走它：`usesTargetProtocol => target != null`，而 `create` 总会
`resolveTarget(request.target ?? { kind: 'new_once' })` 写入 target，所以对 0.2.2 建的任务恒为 true，
手机调的是 `schedule/edit`。上游也没有 `schedule/update` 这个端点（已核：`schedule/*` 只有
catalog / create / deleteInactive / deliveryLimits / edit / history / list / run / view）。

## 九、明确做不到的（不改手机、不改中转的硬边界）

| 做不到 | 原因 | 补偿 |
|---|---|---|
| 手机里点「新建文件夹」给节点建目录 | `directoryPicker/createDirectory` 不在 DSH Go 的 allowlist，本地就拒 | 节点上的 agent 自己能建；`workspace/create` 在节点侧 `mkdir -p`，路径存在即可一步建工作区；桌面端可建 |
| 手机浏览时上溯到本地盘 | 节点用 `/@fleet` 命名空间，与本地路径体系是两个树 | `/@fleet` 下自成树，`home='/@fleet'`，面包屑不越界 |
| 手输一个节点上不存在的路径建工作区 | 手输路径会先进浏览器（`canBrowse=true`），浏览器要列目录 | 先让 agent 建目录；或桌面端建 |

这三条不是缺陷，是 DSH Go 的 `const Set` 决定的。写在这里，避免以后反复排查。

## 十、影响面

| 文件 | 变化 |
|---|---|
| `src/host/picker-paths.js` | 新增：编码/解码/影子路径/清理 |
| `src/host/decorators.js` | 新增 `decorateDirectoryPickerController`；`workspace/create` 改路由与清理 |
| `src/host/browse.js` | `listLocal` 补 `crumbs`；新增 `ensureRemoteDirectory` |
| `src/host/decorators-extra.js` | 新增：A 类端点 |
| `src/host/fleet-control.js` | 新增：`fleetControl` 服务 |
| `src/node-control/index.js` | 新增：`fleet_nodes` 工具 |
| `src/core/plugin-sync.js` | 默认全开 + `NODE_NEVER_SYNC` |
| `src/index.js` | 挂上述装饰与服务 |
| `presets/node-control.patch.yml` | 新增 |
| `package.json` | patch 数组、`engines.dsh`、`files`、`exports["./node-control"]`、version 0.4.0 |
| `docs/DETAIL.zh.md`、`docs/DETAIL.md`、`docs/preview.svg` | 新增 |
| `test/picker-paths-unit.mjs`、`test/install-unit.mjs` | 新增 |
| `test/routing-unit.mjs`、`test/plugin-switch.mjs` | 补断言 |
