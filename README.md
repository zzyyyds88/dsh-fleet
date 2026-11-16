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
│         └─ /fleet/api   ← 节点管理 + 按路径加远程工作区  │
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

### 3.2 三处运行时缝隙（而不是改上游代码）

插件**不 import 任何 `@deepseek-ai/*`**，唯一运行时依赖是 `ssh2`。
它站在三处 DSH 自己的实现细节上，每一处都有测试守着：

| 缝隙 | 是什么 |
|---|---|
| 实例上的 own property | Gateway 从**类原型**读 `@Remote` 描述符，但 dispatch 用 `Reflect.get(view, name)` —— 实例属性优先。所以在实例上覆写方法，端点表不变、实现换掉。 |
| `typert.lookups.configure('workspaceFileScope', …)` | `fleet_…` 不是本地 Session，Host 自己的 lookup 会先返回 not-found。覆写后本地 id 原样委派上游，包装 id 合成 scope。 |
| `webServer.register('/fleet/api')` | 本地的目录选择器浏览的是**本机**，永远选不到节点的 `/root/project`。所以加一个"按路径加远程工作区"的入口。 |

这三条是**实现细节，不是公开契约**。所以有 `test/dispatch-seam.mjs`：
DSH 升级后它先炸，而不是等你某天发现所有远端会话都点不开。

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

**节点确实是个大脑**（实测 192.168.3.93 / DSH 0.2.2-rc.3）：

```
profile bundles : @deepseek-ai/dsh-base + @local/dsh-fleet-brain
composed rows   : 138    (top-level rows; presets add 108 nested rows)
dsh-client-ui-* : 0
web-runtime     : 0
```

**测试矩阵**：9 项，分三层。

| 层 | 脚本 |
|---|---|
| 纯逻辑 | `routing-unit`、`multipart-unit`、`provision-unit`、`check-composition` |
| 契约缝隙（读 `app.asar`，需 Electron 的 Node） | `dispatch-seam`、`upstream-smoke` |
| 端到端（要运行中的 Host + 连上的节点） | `host-routing`、`workspace-flow`、`tool-parity`、`tool-git-image`、`client-bundle` |

---

## 五、怎么用

插件通过 `link:` 装进 DSH profile：

```json
{
  "dependencies": { "@local/dsh-fleet": "link:D:/path/to/packages/dsh-fleet" },
  "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-fleet" ] } }
}
```

然后在 DSH 的**设置 → Fleet** 里加节点（host / 端口 / 用户 / 密码或私钥），
点连接。首次连接会自动在节点上装同版本 DSH、装大脑组合、下发模型与密钥、启动，
然后验证 `session/list` 真的能答 —— 只有它成功才报 connected。

节点要求：Node ≥ 22、有 npm、能 SSH 登录。别的都由插件准备。

跑测试要自己给节点（源码里**没有默认 IP 和默认密码**，这是公开仓库）：

```bash
export DSH_FLEET_TEST_HOST=192.0.2.10
export DSH_FLEET_TEST_USER=root
export DSH_FLEET_TEST_PASSWORD=...
node packages/dsh-fleet/test/workspace-flow.mjs <hostBase> <launchToken>
```

---

## 六、文档

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 路线取舍、三处缝隙、身份编码、为什么"不做镜像"是功能 |
| [`packages/dsh-fleet/README.md`](packages/dsh-fleet/README.md) | 插件安装、接线、测试矩阵、已知限制 |
| [`packages/dsh-fleet-brain/README.md`](packages/dsh-fleet-brain/README.md) | 节点组合：怎么从官方 web-app 减出"只当大脑"的一层 |
| [`packages/dsh-fleet/docs/UPGRADE.zh.md`](packages/dsh-fleet/docs/UPGRADE.zh.md) | DSH 升级后要重跑什么，每条上游契约由哪个测试守着 |
| [`AGENTS.md`](AGENTS.md) | 本仓库的协作规则与硬约束 |

## 七、许可

插件代码 MIT。`reference/` 下的上游源码各归其原作者（DSH 是 MIT，ZCode 见其仓库）。
