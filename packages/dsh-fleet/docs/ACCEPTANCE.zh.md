# 验收流程（真实使用级）

这份文档不是「跑一遍脚本看有没有报错」。它要求像用户一样**真的打开界面、真的在远程会话里
下指令**，然后**读回远程大脑自己的记录**逐条核对。每一步都写明：怎么触发、期望看到什么、
凭什么判断通过、失败了先看哪里。

脚本只是把下面的人工步骤固定下来；判断标准以本文档为准，不以脚本退出码为准。

## 一条命令跑完

```powershell
node packages/dsh-fleet/test/run-all.mjs
```

它会自己启动一个 `--profile fleettest` 的 Host、连上已记录的节点，按三层跑完全部 24 个套件，
每个套件一行结论，失败的附最后几行输出与完整日志路径。**任何一层失败都以非零退出**。

```powershell
node packages/dsh-fleet/test/run-all.mjs --list              # 打印矩阵，不跑
node packages/dsh-fleet/test/run-all.mjs --layer offline     # 秒级：纯逻辑 + 组合检查
node packages/dsh-fleet/test/run-all.mjs --layer contract    # 契约缝隙（用 Electron 的 Node 读 app.asar）
node packages/dsh-fleet/test/run-all.mjs --layer e2e         # 端到端：Host + 节点
node packages/dsh-fleet/test/run-all.mjs --skip artefact,browser --keep-host
node packages/dsh-fleet/test/run-all.mjs --host <base> --token <t>   # 复用已在跑的 Host
```

跑它需要两个外部条件，缺了就**报告 SKIP 并说明原因**，绝不写成通过：

| 条件 | 由谁提供 | 缺了会怎样 |
|---|---|---|
| 节点凭据 | `DSH_FLEET_TEST_HOST/USER/PASSWORD\|KEY_FILE` | 端到端全部 SKIP；若整层一个都没跑，命令以**退出码 1** 结束，因为"证明用户能干活"的那一层没有被检验 |
| Chrome 调试端口 | `DSH_BROWSER_DEBUG_PORT`（默认 9222，需以 `--remote-debugging-port` 启动） | 只有 `browser` 一个套件 SKIP |
| 节点上的 Release 制品 | 已发布的 `v<版本>` | 只有 `artefact` 一个套件 SKIP（可 `--skip artefact`） |

套件可以自己声明"这台部署跑不了"并退出码 3，runner 会把它记成 SKIP 而不是 PASS —— 目前用在三处：
`approval` 在节点被设成 `danger-full-access` 时根本不会发审批请求，硬跑只会是一串空断言；
`browser` 在没有 Chrome 调试端口时连不上页面，只会在抓取处抛 `ECONNREFUSED`；
`plugin-switch` 在本机没装任何第三方插件时没有可切换的对象。

## 0. 前置

| 项 | 要求 |
|---|---|
| 桌面端 | 用 `--profile fleettest` 启动的 Host，不是你正在用的那个 profile |
| 节点 | 一台 Linux 机器，Node ≥ 22，SSH 可达，能从 `https://git.yylx.win/` 下载 |
| 凭据 | 只从环境变量读：`DSH_FLEET_TEST_HOST/USER/PASSWORD/KEY_FILE/PORT` |
| 加速 | 节点侧确认 `curl -sS -o /dev/null -w '%{http_code}' https://git.yylx.win/` 返回 200 |

启动测试 Host（PowerShell，`DSH_HOME` 是你的真实 home，profile 是隔离的）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"; $env:DSH_HOME = "C:\Users\<你>\.dsh"
$cli = "D:\Program Files\DSH\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
Start-Process "D:\Program Files\DSH\DeepSeek Harness.exe" `
  -ArgumentList @("--expose-internals", "`"$cli`"", "--profile", "fleettest",
                  "--host", "127.0.0.1", "--port", "0", "--no-open") `
  -RedirectStandardOutput .scratch\host-test.log -RedirectStandardError .scratch\host-test.log.err
```

从 `.scratch\host-test.log` 里读 `dsh web: http://…` 那一行，`?token=` 后面是本次的启动令牌。
**每次重启 Host 令牌都会变，脚本必须重新读。**

## 1. 侧栏：远程工作区就在普通列表里

人工：打开上面的 URL，看左侧栏。

- 期望：远程节点的工作区（目录名 + 真实远端路径）和本地工作区**排在同一个列表里**，没有单独
  「远程」入口，没有嵌套菜单。
- 判据：侧栏文本能读到远程工作区的标题；点进去能新建会话。
- 失败先看：`/fleet/api/nodes` 的 `state` 是不是 `connected`；`workspace/follow` 的 baseline
  里 `fleet_<nodeId>_` 前缀的行数。

```powershell
node packages\dsh-fleet\test\workspace-flow.mjs <base> <token>
```

## 2. 真实会话：下一条真指令，让节点自己动手

人工：在**远程**工作区里新建会话，输入：

```
在 <远端路径> 下做三件事，每件都用工具真做，不要只用文字回答：
1. 用 write 工具创建 acceptance-<随机>.txt，内容只有一行：ACCEPTANCE_<随机>
2. 用 bash 或 pwsh 工具运行 wc -c < 那个文件，并原样贴出输出
3. 用 grep 工具在文件里搜 ACCEPTANCE_<随机>
最后一行只回复 DONE。
```

期望与判据（缺一条不算过）：

1. 会话头 `cwd` 是**节点的路径**（`/root/...`），不是本地镜像路径；
2. `session/follow` 里出现三条 `tool/call`，名字分别命中 write / bash|pwsh / grep；
3. 三条都产生 `tool/result`，且没有 `isError`；
4. `turn/end` 的 reason 是 `{kind:'completed'}`；
5. 助手最后一条文本包含 `DONE`；
6. **独立证据**：另开一条 SSH 连接 `cat` 那个文件，字节内容等于 prompt 里给的那一行；
7. 会话出现在 `/fleet/api/nodes` 对应节点的 `session/list` 里，`updatedAt` 晚于下指令的时刻。

```powershell
node packages\dsh-fleet\test\session-acceptance.mjs <base> <token>
```

> 第 6 条是这套验收的关键：插件自己报告「我调用了 write」不算证据，节点文件系统上有那个字节
> 才算。脚本用 `test/node.mjs` 另建 SSH 连接读文件，不复用插件连接。

## 3. 终端：在远程会话里真开一个 PTY

人工：打开远程会话的终端面板，新建终端，输入 `echo MARKER_<随机>`。

期望与判据：

1. `terminal/environment` 返回节点的 `cwd`（`/` 开头）与 `maxInputBytes`；
2. `terminal/shells` 列出节点自己的 shell（实测 `bash,pwsh`）；
3. `terminal/create` 建出的终端 `state=running`，`cwd` 是节点目录；
4. attach 首帧是 `snapshot` 且 `writable=true`；
5. 写入 `echo …\r` 后能读到输出，且节点回了 `ack`（说明序号连续）；
6. `terminal/close` 之后它从节点花名册里消失。

```powershell
node packages\dsh-fleet\test\terminal-acceptance.mjs <base> <token>
```

## 4. 审批与提问：卡片必须真的弹在本地

人工：在远程会话里触发一次需要审批的工具调用（例如让 agent 写工作区外的文件），再触发一次
`ask_user_question`。

期望与判据：

1. 本地浏览器弹出**上游原生**的审批卡片（不是插件自绘的）；
2. 卡片的会话标题是那个远程会话，不是空白、不是本地同名会话；
3. 点「允许」后远程回合继续并最终完成；点「拒绝」后远程回合收到拒绝并继续收尾；
4. 提问卡片同样能弹出、能选、回答能回到节点（节点侧 `userQuestions.settled` 出现该条）。

```powershell
node packages\dsh-fleet\test\event-relay.mjs <base> <token>
node packages\dsh-fleet\test\waterfall-unit.mjs
```

## 5. 多节点：同时连两台，互不串号

人工：再添加一台节点（可以是同一台机器的另一个 `remoteRoot`），两台同时连接。

期望与判据：

1. 两台同时 `connected`；
2. 侧栏里两台的工作区都出现，workspaceId 全部唯一；
3. 各自新建的会话 id 前缀是各自的 nodeId，读回时落到正确的节点；
4. 两台会话在合并列表里是两行，不互相覆盖；
5. 移除其中一台，另一台的会话仍然在。

```powershell
node packages\dsh-fleet\test\multi-node-acceptance.mjs <base> <token>
```

## 6. 版本闸门与节点运行时

人工：把节点上的 `~/.dsh-fleet/runtime` 删掉（或换成别的版本），然后点「连接」。

期望与判据：

1. 节点自动下载 `dsh-<version>-<platform>.tar.gz`（走 `git.yylx.win`），校验 sha256，解压后
   替换 `runtime`，旧树留成 `runtime.previous`；
2. 装完 `node …/lib/bin.js --version` 等于桌面版本；
3. **原生包必须是节点的平台**：`sherpa-onnx-linux-x64`、`@img/sharp-linux-x64`，不能出现
   `win-x64`；
4. 节点比桌面**新**时拒绝连接，并说明原因（不是静默降级）；
5. 同一个版本但打包规则不同（`.fleet-artefact.json` 的 build 号不一致）时**重装**，不只比版本。

```powershell
node packages\dsh-fleet\test\artefact-acceptance.mjs
node packages\dsh-fleet\test\version-unit.mjs
```

发布新制品（会写 GitHub Release，需要用户确认）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\Program Files\DSH\DeepSeek Harness.exe" packages\dsh-fleet\scripts\publish-runtime.mjs `
    --platform linux-x64 --publish
```

## 7. 插件同步开关

人工：打开 设置 → 远程节点 → 插件同步。

期望与判据：

1. 列表的单位是**你自己装的插件**，不是内部行：`@local/dsh-rhino-mode`、`dsh-pet`、
   `dsh-whale-widget`、`ds-harness-remote`、`@artenx/dshb` 之类，一行一个，行里带版本/范围、
   它贡献多少行、以及「本机已加载」还是「本机已安装但不在组合里」；
2. `@deepseek-ai/*` 与大脑 bundle 不出现 —— 它们是产品本身，不是选项；
3. 默认**全部关闭**：节点是另一台机器，仅仅因为本机装了就把插件发过去，等于没有决定；
4. 打开一个开关后，那一行必须真的落地，四条都要成立：
   - 节点 `~/.dsh/profiles/fleet/package.json` 的 `dependencies` 多出这个包，
     `node_modules/<包>` 真的存在；
   - `dsh.profile.bundles` 变成 **base → 你打开的插件 → `@local/dsh-fleet-brain`**；
   - 常驻 host 被重启且 `session/list` 还能答（切换后 `/fleet/api/workspaces` 仍有远程工区）；
   - 接口返回里带每个节点的原文结果，节点没接受就带 `warning`，页面把节点的话显示出来；
5. 关掉开关：包从 bundle 列表移除，节点重启，工区照旧；
6. 把开关拨回默认值，profile 目录里的 `fleet-plugins.json` 那条记录被删掉，而不是存成同值
   （存 `$DSH_HOME` 会让 `desktop` 与 `fleettest` 互相影响，所以现在的路径是 **profile 内**）；
7. 页面本身能滚动：整页高于窗口时出现滚动条。实测过 `mainPanel` 1026px 高、内容 10658px，
   而 `centerCol` 是 `overflow: hidden` —— 页面必须自己持有滚动条，否则最下面那段永远看不到。

```powershell
node packages\dsh-fleet\test\version-unit.mjs       # 开关语义（哪些算第三方、默认关、顺序、容错）
node packages\dsh-fleet\test\run-all.mjs --layer e2e --only plugin-switch  # 真的落到节点并重启
```

## 7b. 加工作区：先选机器，再选目录

人工：左侧栏「工作区」旁的点号 → 添加工作区；或在会话里新建会话。

期望与判据：

1. 弹出的是**本项目的**目录对话框（标题「选择工作区文件夹」），不是系统的原生选择框；
2. 第一个下拉是「在哪台机器上」，选项是「本机」+ 每个节点（名字 · 主机）；
3. 选「本机」列的是本机目录；选节点列的是**节点上的**目录（`/root` 下的真实名字），
   上一级/打开/直接输路径都能用，路径栏显示的是节点上的绝对路径；
4. 选中后点「加入工作区」，侧栏立刻出现这个工区，`/fleet/api/workspaces` 里有
   `fleet_<nodeId>_…` 行且 `path` 是节点路径；
5. 进那个工区新建会话，会话 `cwd` 是节点路径 —— 与本地工区的操作完全相同。

失败先看：`GET /fleet/api/browse?node=<id>&path=` 的返回；节点未连接时该接口报
`this node has no stored password` 之类的 SSH 原文，而不是空列表。

```powershell
node packages\dsh-fleet\test\workspace-browse.mjs <base> <token>
```

判据与脚本的对应关系（脚本只是固定手势，标准以本条为准）：

| 判据 | 脚本里对应的断言 |
|---|---|
| 1 是本项目的对话框 | `client-bundle.mjs`：三个 `*.directoryFlow` 插槽都注册且渲染 |
| 2 先选机器 | 下拉第一项 `''`＝本机，其余是节点（`名字 · 主机`） |
| 3 列的是节点的盘 | `workspace-browse.mjs`：节点那一路的 `nodeId` 就是被选中的节点、`home` 是节点上的 `/root`、`/` 没有上级、隐藏目录不出现、不存在的目录带 shell 原文 |
| 4 选中即落地 | 同脚本：POST 后返回 `fleet_<nodeId>_…` 身份 + 节点绝对 `path`，且出现在 `workspace/follow` 的合并 baseline 里 |
| 5 与本地操作相同 | 同脚本：同一目录再选一次是幂等的（同一个 workspaceId），相对路径被 400 拒绝 |

## 8. 纯逻辑与契约层（每次改代码都要跑）

```powershell
node packages\dsh-fleet\test\routing-unit.mjs
node packages\dsh-fleet\test\multipart-unit.mjs
node packages\dsh-fleet\test\provision-unit.mjs
node packages\dsh-fleet\test\waterfall-unit.mjs
node packages\dsh-fleet\test\version-unit.mjs
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\Program Files\DSH\DeepSeek Harness.exe" packages\dsh-fleet\test\dispatch-seam.mjs
& "D:\Program Files\DSH\DeepSeek Harness.exe" packages\dsh-fleet\test\upstream-smoke.mjs
```

## 9. 端到端（需要运行中的 Host + 连上的节点；也可交给 `run-all.mjs --layer e2e`）

```powershell
node packages\dsh-fleet\test\host-routing.mjs    <base> <token>
node packages\dsh-fleet\test\workspace-flow.mjs  <base> <token>
node packages\dsh-fleet\test\tool-parity.mjs     <base> <token>
node packages\dsh-fleet\test\tool-git-image.mjs  <base> <token>
node packages\dsh-fleet\test\client-bundle.mjs   <base> <token>
node packages\dsh-fleet\test\gateway-smoke.mjs   <base> <token>
node packages\dsh-fleet\test\session-acceptance.mjs   <base> <token>
node packages\dsh-fleet\test\terminal-acceptance.mjs  <base> <token>
node packages\dsh-fleet\test\multi-node-acceptance.mjs <base> <token>
```

## 判定

- 第 1–7b 节全部通过才算「能用」。任何一条失败都要先复现、留证据、写出可证伪的假设，再改。
- 退出码 0 只证明那一层；构建通过不代表界面正确，单测通过不代表端到端可用。
- 跑不了的项必须写明原因与替代证据，不许隐瞒。
- 每轮验收后把失败项、修复、重跑结果追加到本文档末尾的「验收记录」。

## 验收记录

### 2026-11-17 · DSH 0.2.2-rc.3 · 节点 linux-x64

| 节 | 结果 | 证据 |
|---|---|---|
| 1 侧栏 | 通过 | 真实 Chrome 读 DOM：`grouptest`、`fleet-second`、`fleet-brain-test` 三个远程工区与本地工区在同一列表（`.scratch/browser-acceptance.png`） |
| 2 会话 | 通过 | 真下指令 → 节点真跑 write/bash/grep → `turn/end={kind:completed}` → 助手说 DONE → 独立 SSH 读到 `acceptance-*.txt` 字节与 prompt 一致（20 字节） |
| 3 终端 | 通过 | `environment` 返回 `/root/grouptest` + 65536；shells 为 `bash,pwsh`；attach 首帧 snapshot 且 writable；echo 命令收到 2 次回显；节点 ack；close 后花名册为空 |
| 4 审批/提问 | 通过 | `waterfall-unit` 7 段全过（允许的才转发、拒绝/超时各自结算、断线取消卡片、问题按自己名字转发）；`approval-acceptance` 在真节点上走完整条链：节点 `approval/asked` → 本机 `waterfall` 帧带着包裹后的 agentId → 答复 `$events/result` → 节点 `approval/decided=allowed-once` → 文件真的写出来；第二次改成拒绝，节点记 `rejected` 且文件不存在；`ask_user_question` 用 `{answers:[{id,selected}]}` 批量答复，节点的工具结果原样回带 `red` |
| 5 多节点 | 通过 | 同一机器两个 `remoteRoot` 同时 connected；两边工区 id 唯一；各建 Session 前缀各自 nodeId、读回落到正确节点；合并列表两行；移除一台不影响另一台 |
| 6 版本闸门 | 通过 | `version-unit` 全过；`artefact-acceptance` 在真节点 8 秒装完 832MiB、原生包 `sherpa-onnx-linux-x64`/`sharp-linux-x64`（无 win-x64）、二次安装与回滚均通过；实测一台 3.9GB 的旧树被替换成 832MiB |
| 7 插件开关 | **已被取代** | 当时的设计是"把节点组合里 133 行逐行做成开关"；实际用不了 —— 用户要的是"我自己装的第三方插件可选"，不是看内部行。现设计见下一节的记录与 §7 判据：单位是 bundle，默认全关 |
| 8 纯逻辑 | 通过 | routing-unit / multipart-unit / provision-unit / waterfall-unit / version-unit / dispatch-seam / upstream-smoke / descriptor-smoke |
| 9 端到端 | 通过 | workspace-flow / host-routing / tool-parity / tool-git-image / client-bundle / event-relay / gateway-smoke / session / terminal / multi-node / artefact / browser / approval |

本轮修掉的问题：①`REMOTE_LAYOUT` 是常量，第二个节点复用第一个的 runtime（多节点验收第一次
就抓到）；②制品裁剪规则误删 `yaml/dist/doc/directives.js`，节点启动即 `MODULE_NOT_FOUND` 而
版本闸门说"已是最新"，为此加了 `.fleet-artefact.json` 打包戳；③把 `connection`/`web-startup`
当浏览器行关掉导致节点没有 HTTP 服务，为此加了 `STRUCTURAL_ROWS` + 从已安装 `dsh-base` 解析
必需行；④浏览器验收固定采样一次会撞上侧栏重绘，改成有界轮询（截图超时不再算失败、CDP 定时器成功即清）；⑤插件开关第一版按名字猜默认值、把 `connection`/`web-startup` 当浏览器行、并给 59 行节点从不加载的行写了 disabled —— 三处都实测炸过，现在默认值取节点实际组合、结构行实测收敛、只对节点真有的行写 disabled。

### 2026-11-17 · 一条命令跑完 22 个套件

`node test/run-all.mjs` 在 `fleettest` + 真节点上跑出 **22 passed, 0 failed, 0 skipped in 250s**：

| 层 | 套件 |
|---|---|
| offline（6） | routing / multipart / provision / waterfall / version / composition |
| contract（3） | descriptor / dispatch / upstream（都走 Electron 的 Node 读 `app.asar`） |
| e2e（13） | gateway / host-routing / workspace-flow / tool-parity / tool-git-image / client-bundle / event-relay / session / terminal / multi-node / artefact / approval / browser |

runner 自己的三条硬约束（都实测过会踩）：

- **退出码要真的表示结论。** 七个套件原本 `process.exitCode = 1` 后又 `process.exit(0)`，
  失败被吞掉；runner 会把它读成通过。全部改成按 `failures.length` 退出。
- **没跑 ≠ 通过。** 请求 `--layer e2e` 却一个都没能跑时，命令以退出码 1 结束，并明说
  "the layer that proves a user can work was not exercised"。
- **SKIP 必须带原因。** 缺节点凭据、缺 Chrome 端口、节点无 Release 制品、节点被设成
  `danger-full-access` 不会发审批请求 —— 四种都报告原因，不写成通过。

### 2026-11-17 · 一条命令跑完 24 个套件

`node test/run-all.mjs` 在 `fleettest` + 真节点（`probe-93`，linux-x64）上跑出
**24 passed, 0 failed, 0 skipped in 247.5s**：

| 层 | 套件 |
|---|---|
| offline（6） | routing / multipart / provision / waterfall / version / composition |
| contract（3） | descriptor / dispatch / upstream（都走 Electron 的 Node 读 `app.asar`） |
| e2e（15） | gateway / host-routing / workspace-flow / workspace-browse / plugin-switch / tool-parity / tool-git-image / client-bundle / event-relay / session / terminal / multi-node / artefact / approval / browser |

本轮新增的两个套件（§7 与 §7b 的判据各有一份）：

- `workspace-browse.mjs`：本机与节点用同一形状回答、节点列的是节点的盘（`/` 没有上级、
  隐藏目录不列、不存在的目录带 shell 原文）、选中的节点目录变成带包裹身份的工区、同一
  目录再选一次幂等、相对路径 400。
- `plugin-switch.mjs`：单个开关真的落到节点（包被安装或复制、bundle 列表排在脑 bundle
  之前、包真的存在），**并且重启之后浏览器那一路流还活着** —— 这条是补上的，理由见下。

本轮修掉的问题（都是"页面看着正常、实际已经不工作"，只有真实会话能抓到）：

1. **插件开关把大脑 bundle 剪掉了。** `npm install` 会剪掉 profile `dependencies` 里没有的
   包，而脑 bundle 是复制进去的、不在 `dependencies` 里。实测症状：节点报
   `cannot resolve profile bundle "@local/dsh-fleet-brain"`，宿主起不来。改成两家都写：先
   `npm install`（发布型插件），再写脑 bundle，最后写 bundle 列表。同一处还有第二半 ——
   本地 `link:` 插件根本没有 registry 条目，`npm install @local/x` 在节点上必然 404，所以
   它走"逐文件复制到 profile"，且必须在 npm **之后**，否则会被下一次安装剪掉。
2. **重启之后本机以为节点还有事件流。** 常驻 host 一重启（插件开关必然重启它），网关的
   载体和所有逻辑流一起断，但 `RemoteEvents` / `RemoteControl` / `RemoteWorkspaces` 里的
   节点条目还在 Map 里；`sync()` 只判断"这个节点在不在 Map 里"，于是永远不重开。更隐蔽的
   是那条死 socket **仍然可写**：`session/follow` 打开成功、一帧都收不到，比报错更像"节点
   没输出"。实测症状：`tool-parity` 等一个已经跑完的回合等了 7 分钟（`0 frames`）、
   `event-relay` 收不到任何 `api-session/*`、审批卡在本机点了通过而节点从没收到答案。
   修法是三层：重启方调 `gateway.reset()`（作废载体与逻辑流，并用代号让旧 socket 迟到的
   `close` 不再清掉新载体）；每条流 `onEnd`/失败时调 `gateway.revive()`（延迟 1 秒、最多 8
   次）；升级被 401 拒绝时重新换 cookie（重启后的宿主发新 cookie）。
3. **审批答复在重启后被丢弃。** `NodeWaterfalls.closed` 一旦置位就再没复位，重开的流虽然
   通过 `ready(clientId)` 送来了新的 generation，`relay()` 里的 `if (this.closed) return` 仍然
   把答复吞掉 —— 表现为"本机接受了答复、节点没记录"。`ready()` 现在会清掉 `closed`。
4. **远程投影块只活到节点重启。** 节点 `session/control` 的 baseline 取的是它**内存里活着的**
   Session；远程会话在节点上不常驻，重启后 baseline 就是 `{}`，转发它等于"远程投影消失"。
   `RemoteControl` 改成自己攒一份：首帧见到某个 Session 就建块、按 `changes` 逐键合并、
   `asOfSeq` 跟着 `seq` 走。`event-relay` 判据也随之改成"**之后**连上的客户端能在
   baseline 里看到这个会话"，而不是"开流那一帧里必须有它" —— 后者取决于拍快照的瞬间节点
   内存里有什么，与中继正确性无关。
5. **没有 Chrome 时 `browser` 套件抛 `ECONNREFUSED`。** 它本该是 SKIP（退出码 3 + 原因），
   现在连不上调试端口就报 SKIP 并给出启动命令，而不是把一次成功的全量验收变成红。
