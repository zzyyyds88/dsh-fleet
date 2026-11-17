# 验收流程（真实使用级）

这份文档不是「跑一遍脚本看有没有报错」。它要求像用户一样**真的打开界面、真的在远程会话里
下指令**，然后**读回远程大脑自己的记录**逐条核对。每一步都写明：怎么触发、期望看到什么、
凭什么判断通过、失败了先看哪里。

脚本只是把下面的人工步骤固定下来；判断标准以本文档为准，不以脚本退出码为准。

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

1. 每个插件一行，显示开关状态和**来源**（默认开 / 默认关 / 手动开 / 手动关 / 结构行锁定）；
2. 关掉一个纯工具插件，已连接节点的 profile patch 立刻多出对应的 `- id:` + `disabled: true`；
3. 节点组合里必须存在的行（`web`、`webserver`、`web-startup`、`brain-runtime`）**不可关**，
   手动关掉它们会让节点起不来或没有 HTTP 服务（实测）；
4. 把开关拨回默认值，`$DSH_HOME/fleet/plugins.json` 里那条记录被删掉，而不是存成同值。

```powershell
node packages\dsh-fleet\test\version-unit.mjs
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

## 9. 端到端（需要运行中的 Host + 连上的节点）

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

- 第 1–7 节全部通过才算「能用」。任何一条失败都要先复现、留证据、写出可证伪的假设，再改。
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
| 4 审批/提问 | 通过 | `waterfall-unit` 7 段全过（允许的才转发、拒绝/超时各自结算、断线取消卡片、问题按自己名字转发） |
| 5 多节点 | 通过 | 同一机器两个 `remoteRoot` 同时 connected；两边工区 id 唯一；各建 Session 前缀各自 nodeId、读回落到正确节点；合并列表两行；移除一台不影响另一台 |
| 6 版本闸门 | 通过 | `version-unit` 全过；`artefact-acceptance` 在真节点 8 秒装完 832MiB、原生包 `sherpa-onnx-linux-x64`/`sharp-linux-x64`（无 win-x64）、二次安装与回滚均通过；实测一台 3.9GB 的旧树被替换成 832MiB |
| 7 插件开关 | 通过 | 207 行中，节点组合里真的有的 133 行默认开、其余 74 行标为「节点不加载」且不可开关；把 `plan-mode` 关掉后节点 patch 出现对应 disabled 条目、拨回默认即消失；14 个结构行（HTTP 服务 + Remote API 控制器/传输）不可关闭 —— 实测关掉要么 `1 required plugin did not activate`，要么节点活着但 `session/list` 不存在 |
| 8 纯逻辑 | 通过 | routing-unit / multipart-unit / provision-unit / waterfall-unit / version-unit / dispatch-seam / upstream-smoke / descriptor-smoke |
| 9 端到端 | 通过 | workspace-flow / host-routing / tool-parity / tool-git-image / client-bundle / event-relay / gateway-smoke / session / terminal / multi-node / browser |

本轮修掉的问题：①`REMOTE_LAYOUT` 是常量，第二个节点复用第一个的 runtime（多节点验收第一次
就抓到）；②制品裁剪规则误删 `yaml/dist/doc/directives.js`，节点启动即 `MODULE_NOT_FOUND` 而
版本闸门说"已是最新"，为此加了 `.fleet-artefact.json` 打包戳；③把 `connection`/`web-startup`
当浏览器行关掉导致节点没有 HTTP 服务，为此加了 `STRUCTURAL_ROWS` + 从已安装 `dsh-base` 解析
必需行；④浏览器验收固定采样一次会撞上侧栏重绘，改成有界轮询（截图超时不再算失败、CDP 定时器成功即清）；⑤插件开关第一版按名字猜默认值、把 `connection`/`web-startup` 当浏览器行、并给 59 行节点从不加载的行写了 disabled —— 三处都实测炸过，现在默认值取节点实际组合、结构行实测收敛、只对节点真有的行写 disabled。
