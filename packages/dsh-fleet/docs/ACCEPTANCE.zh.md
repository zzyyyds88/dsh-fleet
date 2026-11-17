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

### 2b. 同一件事，从界面做一遍（不碰 API）

脚本走的是协议；用户走的是界面。两者都要过，因为协议对了界面也可能没接上。这一步的
判据是**页面上看得见**，不是接口返回：

1. 侧栏里点远程工作区的「新建会话」→ 页面出现一个新的空会话，模型选择器旁显示的是
   **那个工作区**的名字（`fleet-relay-mwkiidoo`），不是本地某个工区；
2. 在输入框里真敲一条指令（不是脚本注入 `textContent`：编辑器的内部模型要收到真实的
   `insertText`，否则发送按钮不会亮）：
   `在 /root/<dir> 下用 write 工具创建 gui-<随机>.txt，内容只有一行 <随机>；然后用 bash
   工具运行 wc -c 那个文件并原样贴出输出；最后一行只回复 DONE。`
3. 发送 → 页面上依次出现「正在分析请求 / 深度求索中」→「已完成，用时 …秒」，正文里有
   代码块 `13 gui-<随机>.txt` 和 `DONE`；
4. **独立证据**：另开 SSH `cat` 那个文件，内容与 prompt 一致（实测 13 字节 = 12 字符 +
   换行）。
5. 会话标题是模型起的（实测「创建验收文件并统计字节」），说明标题那条 LLM 调用也发生在
   节点上，不是本地补的。

实测记录（2026-11-17 22:04，本地 Chrome 9222 驱动真实页面）：新建会话 → 输入 → 发送 →
18 秒完成 → `cat` 得到 `ACCEPT_956968`（13 字节）→ 节点日志
`--root-fleet-relay-mwkiidoo--/session-83de59a8-…` 里 `seq 20` 是 `tool/call` name=`write`、
`seq 26` 是 `tool/call` name=`bash`、`seq 36` 是 `turn/end {kind:completed}`。


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

人工：左侧栏「工作区」旁的点号 → 添加工作区…（或新建会话时的「选择工作区」→「添加工作区…」）。

期望与判据：

1. 弹出的是**本项目的**对话框，不是系统原生选择框。第一屏是**表单**，字段顺序固定为
   项目名称 → 设备 → 源文件夹；「新建会话」入口标题是「创建项目」、末按钮「创建」，
   侧栏入口标题是「选择工作区文件夹」、末按钮「加入工作区」，其余字段完全一样；
2. 项目/工作区名称留空就用文件夹名；填了就用手填的名字；
3. 设备下拉圆角自绘，选项是「本机」+ 每个节点（`名字 · 主机`），**最后一项是「添加远程设备…」**，
   选中它进新增节点表单（与设置页同一个表单），提交后回到第一屏且新节点已经在列表里；
4. 选节点后，设备下方多一行「这台设备上已有项目？添加到侧栏 ›」，点开列出**那台机器上已有**的工作区，
   点一条直接按那条路径建/选工作区，不必再浏览；
5. 「源文件夹」是虚线空态卡片（「选择文件夹 / Harness 可以读取和编辑这些文件夹」）；点它进第二屏
   浏览页，标题「选择文件夹」，左上「‹ 返回」，机器仍可切换；
6. 浏览页：选「本机」列的是本机目录、**盘符 chips 覆盖所有存在的盘**（不只 C:）；选节点列的是
   **节点上的**目录（`/root` 下的真实名字），上一级/打开/直接输路径都能用，路径栏显示节点绝对路径；
7. 「＋ 新建文件夹」在对话框内展开内联表单：自己命名 → 「创建」 → 目录列表跳进新目录；本机与节点
   走同一个手势，落到各自磁盘上；建好后点「选择此文件夹」回第一屏，源文件夹显示成
   `名字 + 绝对路径 + 更换`；
8. 点末按钮：侧栏立刻出现这个工区（标题就是第 2 步的名字），`/fleet/api/workspaces` 里有
   `fleet_<nodeId>_…` 行且 `path` 是节点路径；
9. 进那个工区新建会话，会话 `cwd` 是节点路径 —— 与本地工区的操作完全相同。

失败先看：`GET /fleet/api/browse?node=<id>&path=` 的返回；节点未连接时该接口报
`this node has no stored password` 之类的 SSH 原文，而不是空列表。新建文件夹失败返回
`node-not-found` 404 / `node-offline` 409 / `name-invalid` 与 `create-failed` 400，不编造成功。
名称非空时先建工作区再交接，失败会停在表单里报错、不交接 —— 否则就是「点了没反应」。

```powershell
node packages\dsh-fleet\test\workspace-browse.mjs <base> <token>
```

判据与脚本的对应关系（脚本只是固定手势，标准以本条为准）：

| 判据 | 脚本里对应的断言 |
|---|---|
| 1 是本项目的对话框 | `client-bundle.mjs`：三个 `*.directoryFlow` 插槽都注册且渲染 |
| 2 可以自己命名 | `workspace-browse.mjs`：POST 带 `title` → 合并后的行 `title` 就是它，不带 `title` 时回落成文件夹名 |
| 3/4/5/6 设备与浏览 | 同脚本：下拉第一项 `''`＝本机，其余是节点（`名字 · 主机`）；节点那一路的 `nodeId` 就是被选中的节点、`home` 是节点上的 `/root`、`/` 没有上级、隐藏目录不出现、不存在的目录带 shell 原文；本机那一路的 `roots` 含非 `C:` 盘 |
| 7 能新建文件夹 | 同脚本：本机与节点各建一个目录，建完能列举到；重名与 `../escape` 各自 400 |
| 8 选中即落地 | 同脚本：POST 后返回 `fleet_<nodeId>_…` 身份 + 节点绝对 `path`，且出现在 `workspace/follow` 的合并 baseline 里 |
| 9 与本地操作相同 | 同脚本：同一目录再选一次是幂等的（同一个 workspaceId），相对路径被 400 拒绝 |

## 7c. 远程会话里那几处「和本地一样」

远程大脑的会话与本地会话在同一个侧栏，所以**本地能点的每个入口在远程会话里都得能用**，
或者给出一个说得通的拒绝。人工在**远程**工作区的会话里逐项过一遍：

| 入口 | 期望 | 凭什么判断 |
|---|---|---|
| 智能体协作开关 | 真的能开、能关 | 开关落到节点的 `agentTeams/setEnabled`；本机不报 `subagent tree access requires the exact live caller` |
| 子代理会话的历史 | 点开能读到那条子会话的记录 | 侧栏列出的子会话 id 是 `fleet_<nodeId>_<裸 uuid>`；`session/page` 返回 `cursor>0` 且含 `subagent/descriptor` |
| 产物卡片「在文件管理器中显示」 | 远程文件**不假装能开** | 点开得到 422，卡片显示「此文件没有可用的主机路径，请在侧边栏预览」；**不是**「无法在文件管理器中显示，请重试」那种让人反复重试的文案 |
| 产物卡片预览 | 能读到内容 | `/api/present.open` 先转发节点的 `session/page`，再被 `openVerified` 以 422 拒绝原生打开 —— 预览走的是另一条（`workspaceFiles/read`），照旧可用 |

两个 ID 判据的实测方法（不需要点界面）：

```powershell
# 子会话 id 是不是包裹形式
node -e "fetch('http://127.0.0.1:54720/fleet/api/nodes').then(r=>r.json()).then(console.log)"
# 产物卡片的原生打开状态码
node .scratch/verify-reveal.mjs <base> <token>
```


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

### 2026-11-17 · 一条命令跑完 24 个套件（第二次）

`node test/run-all.mjs --host … --token …`（复用已在跑的 `fleettest` Host、真节点 `probe-93`）：
**22 passed, 1 failed, 1 skipped in 1747.5s**。

| 层 | 结果 |
|---|---|
| offline（6） | 全过 |
| contract（3） | 全过 |
| e2e（15） | 13 过；`artefact` 1500 s 超时；`browser` 因未设 `DSH_BROWSER_DEBUG_PORT` 报 SKIP |

修完下面两条之后**重跑全绿**：`24 passed, 0 failed, 0 skipped in 1217.9s`
（`DSH_BROWSER_DEBUG_PORT=9222` 已设；`artefact` 单项 964.1 s）。

两个非绿项都不是功能坏了，但都要说明白：

1. **`artefact` 超时是一次真的缺陷暴露，已修。** 单独复跑 68 s 全过，说明装得上；慢的是
   下载这一步。实测两条候选 URL 的差距：加速地址 4 s 拉完 172 683 323 字节，直连 GitHub
   30 s 只拿到 925 295 字节（5 GB/s 级差距，不是抖动）。旧脚本对 curl 只有
   `--connect-timeout 15 --retry 2`，没有任何**传输**上限，于是加速地址一旦失败，直连那一路
   会以 ~30 KB/s 爬 170 MiB —— 一个多小时，对用户就是「连节点卡住、没有任何输出」。
   修法：`--speed-limit 4096 --speed-time 60`（低于 4 KB/s 持续 60 s 就放弃这一路）+
   `--max-time 1800`（慢但能用的线路仍有 100 KB/s 的完整预算），放弃后按已有的
   `ARTEFACT_UNAVAILABLE` 命名失败返回。`version-unit` 加了两条断言守这两个数字。
   同时把矩阵里这一项的预算从 1500 s 提到 2700 s：这套要**装两次**（第二次证明替换与回滚），
   每次都是一个 165 MiB 的下载，按脚本自己的 1800 s 上限算，45 分钟才是诚实的上界。
   修完实测：完整跑一次 **653 s**（加速地址那一路当时只有 ~260 KB/s），20 条断言全过；
   `version-unit` 全过。
2. **`browser` 是环境 SKIP，不是通过。** 单独用 `DSH_BROWSER_DEBUG_PORT=9222` 复跑全过
   （10 条断言：侧栏渲染、合并 baseline 7/7 远程工区、三个远程工区标题可见、插件入口
   「远程节点」可达、结束仍绘制），截图 `.scratch/browser-acceptance.png`。

本轮同时修掉的两个「页面上看着正常、换了会话就废」的问题（都已在实际 GUI 上验证）：

1. **智能体协作打不开。** `agentTeams/setEnabled` 的形参是 `Agent`，Gateway 在方法体运行前
   就把 `agentId` 解成节点上的 Agent，而本地只有占位对象，上游 `TeamService` 第一行
   `ctx.subagents.rootOf(agent)` 要求 `agents.get(caller.id) === caller`，直接抛
   `subagent tree access requires the exact live caller`（`gateway/internal`）。改成装饰器先用
   `agent.id` 解节点再转发节点自己的形参。实测开/关成功。
2. **子代理会话历史「历史加载失败：subagent is unavailable（subagent/not-found）」。**
   子代理自己的 Session 在节点上是**裸 uuid**（父才是 `session-<uuid>`），`toLocal` 只按值匹配
   `session-<uuid>` 形状，于是侧栏列出的子会话 id 没被包裹。浏览器拿它拼
   `{kind:'subagent', parentSessionId, childSessionId}`，本机解不出节点，落到本地实现，本机没有
   那段日志 —— 于是 not-found。改成**按字段名**包装（`sessionId`/`childSessionId`/`parentSessionId`
   里的裸 uuid 一律包）。实测 5 个子会话 id 全是 `fleet_n00a5f7394401_<uuid>`，
   `session/page` 返回 `cursor=19` 且含 `subagent/descriptor`。

界面侧这轮补齐的两处（都在真实 Chrome 里点过）：

- **插件同步卡片**改成和官方「已安装插件」一致的排版：36×36 图标、标题、两行描述、右侧开关；
  没有自带图标的插件画一个中性方块图标（原先是一个彩色 emoji，混在真图标里像另一种东西）；
  中英文按浏览器语言各取一份（Host 两本字典都读，选哪本该由页面决定）。
- **目录对话框**：加了「工作区名称」输入框（留空用文件夹名）、圆角「在哪台机器上」下拉、
  「＋ 新建文件夹」内联表单（自己命名 → 创建 → 跳进新目录，本机与节点同一手势）、
  本机盘符 chips 覆盖所有存在的盘而不是只有 `C:`。真实 GUI 走查：
  切设备 → 新建文件夹 `accept-1794919839121` → 命名工作区「中继实验」→ 加入工作区，
  侧栏出现该工区（17 个工作区）。

### 2026-11-18 · 「创建项目」表单 + 六项功能真实用户验收

**这一轮的验收方式是用户视角**：下达一条真指令到节点，用界面点，再用独立 SSH 读磁盘核对。

一、全量矩阵（`node test/run-all.mjs`，`fleettest` Host + 真节点 `probe-93`）：

第一次跑 **23 passed, 1 failed, 0 skipped in 1557.8s**，唯一失败项是 `e2e/multi-node`：

- 现象：`probe-93:connected multi-…:failed` —— 第二个节点建得出来、连不上。
- 根因不在产品：这套测试给第二个记录写的是 `password: DSH_FLEET_TEST_PASSWORD`，而这台测试机
  只配了 `DSH_FLEET_TEST_KEY_FILE`（公开仓库不允许内置密码，key 是正常形态）。于是第二个记录
  没有可用凭据，`connect` 报「no stored credential」。`node.mjs` 一直两种凭据都支持，只有这套
  测试写死了 password。
- 修法：`multi-node-acceptance.mjs` 与 `node.mjs` 对齐——有 `DSH_FLEET_TEST_KEY_FILE` 就传
  `privateKey` 并把 `auth.kind` 设成 `key`，有密码才传密码。改完单跑 `--only multi-node`：
  **1 passed … in 10.3s**。

修完重跑全量：**24 passed, 0 failed, 0 skipped in 590.2s**（`artefact` 371.6 s、
`tool-parity` 58.4 s、`approval` 48.1 s、`session` 14.1 s、`multi-node` 10.2 s）。

二、第 6 项「创建项目」表单（真实 Chrome 9222，全部靠点击，不碰 API）：

| 判据 | 实测 |
|---|---|
| 新建会话入口是「创建项目」，字段序 项目名称 → 设备 → 源文件夹 | 通过：`aria-label="创建项目"`，正文 `创建项目 \| 项目名称 \| 设备 \| 本机 \| probe-93 · 192.168.3.93 \| 添加远程设备… \| 源文件夹 \| 📁 选择文件夹 \| Harness 可以读取和编辑这些文件夹 \| 取消 \| 创建`（截图 `.scratch/final-project-form.png`） |
| 侧栏入口说「选择工作区文件夹 / 工作区名称 / 加入工作区」 | 通过：同一组件在 `sidebar.workspaces.directoryFlow` 下报另一套词（截图 `.scratch/form-sidebar.png`） |
| 设备选节点后出现「这台设备上已有项目？添加到侧栏 ›」 | 通过：切到 `probe-93` 后该行出现 |
| 点它能列出**那台机器上已有**的工作区 | 通过：`aria-label="添加到侧栏"` 的页里 8 行，与 `/fleet/api/workspaces` 的 8 条远程行一一对应（`验收项目`、`fleet-relay-mwkiidoo`、`SCIdream`、`111`、`FuDaiZuJian`、`grouptest`、`fleet-second`、`fleet-brain-test`） |
| 点一条直接交接，不必再浏览 | 通过：点「验收项目」→ 对话框关闭 → 进入该工区的新会话页（源文件夹/浏览页都没经过） |
| 源文件夹是虚线空态卡片 | 通过：截图里 `📁 选择文件夹 / Harness 可以读取和编辑这些文件夹` 是虚线卡 |
| 第二页「选择文件夹」可返回、机器仍可切 | 通过：正文首行 `‹ 返回`，下拉仍在且值仍是节点 |

三、同一个对话框真的建出一个远程工区（用户在界面里做，不看接口）：

1. 表单里填名称 `验收项目`；
2. 设备选 `probe-93`；
3. 点源文件夹 → 第二页 → 「＋ 新建文件夹」→ 命名 `accept-project-1` → 「创建」→ 列表跳进
   `/root/accept-project-1`；
4. 「选择此文件夹」→ 回第一屏，源文件夹显示 `accept-project-1 / /root/accept-project-1 / 更换`；
5. 「创建」→ 对话框关闭，侧栏出现「验收项目」。
6. 接口核对：`/fleet/api/workspaces` 从 7 条变 8 条，多出
   `验收项目 | /root/accept-project-1 | fleet_n00a5f7394401_ef149cfe-…`。

四、像真实用户一样给远程大脑下达任务（验收的核心，不是跑脚本）：

在「验收项目」工区新建会话，用真实 `Input.insertText` 敲入并点 `aria-label="发送消息"`：

> 在 /root/accept-project-1 下做三件事，每件都用工具真做：1. 用 write 工具创建
> task-ACCEPT_540623.txt，内容只有一行 ACCEPT_540623；2. 用 bash 工具运行
> wc -c task-ACCEPT_540623.txt 并原样贴出输出；3. 用 bash 工具运行 hostname 并原样贴出输出。
> 最后一行只回复 DONE。

页面回读：**「已完成，用时 14秒」**，正文三段——`已用 write 工具创建
/root/accept-project-1/task-ACCEPT_540623.txt`、代码块 `14 task-ACCEPT_540623.txt`、
代码块 `Develop`、末行 `DONE`；用量算 `1 轮 4 步 · 256 tok/s`。

**独立证据**（另开一条 SSH，不复用插件的连接）：

```
$ cat /root/accept-project-1/task-ACCEPT_540623.txt   →  ACCEPT_540623
$ wc -c …                                             →  14 /root/accept-project-1/task-ACCEPT_540623.txt
$ hostname                                            →  Develop
```

节点的 `hostname` 是 `Develop`，本地不是——这条比任何日志都直接地说明工具真的在节点上跑。

再验证界面里的产物入口：点会话里 `aria-label="在侧边栏打开 …/task-ACCEPT_540623.txt"`，
右侧预览直接显示 `ACCEPT_540623` —— 远程产物的预览走 `workspaceFiles/read`，和本地一样能用。

五、这一轮动到的代码与文档：

- `packages/dsh-fleet/src/client/client.js`：`WorkspaceFolderFlow` 从「一个文件浏览器」改成
  「表单 + 浏览 + 加设备 + 已有项目」四页；两套词按插槽名（注册时塞进 props 的 `origin`）选；
  新增 15 个文案键（中英各一份）。
- `docs/ARCHITECTURE.md` §六之六：补「一个对话框，两页，第三种叫法」。
- `packages/dsh-fleet/test/multi-node-acceptance.mjs`：第二个节点支持 key 认证。

