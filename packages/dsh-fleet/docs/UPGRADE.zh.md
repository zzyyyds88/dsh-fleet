# 升级流程

这份文档写给以后维护 `@local/dsh-fleet` 的人（很可能就是未来的你）。核心原则只有一条：

> **插件不 fork 任何上游代码，也不从 `app.asar` 里 import 任何东西。**
> 所以 DSH 升级时，插件不会"跟着坏"，但可能"悄悄失配"。下面这些检查就是发现失配的办法。

---

## 一、DSH 升级后必须重跑的三件事

桌面端升级 DSH（`0.2.2-rc.3` → `0.2.3` 之类）之后，按顺序做：

### 1. 重跑不依赖网络的三个测试

```bash
cd packages/dsh-fleet
node test/routing-unit.mjs      # 身份编解码、流扇出、工作区合并
node test/multipart-unit.mjs    # Gateway 二进制应答解码
node test/gateway-smoke.mjs     # SSH 上的 cookie / unary / 流载体
```

### 2. 重跑两条"缝隙"测试（必须用 DSH 自带的 Node，不是系统 Node）

这两个测试读的是 `app.asar` 内部结构，**只有 Electron 打过补丁的 `node:fs` 能读**：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "D:\Program Files\DSH\DeepSeek Harness.exe" "test/dispatch-seam.mjs"
& "D:\Program Files\DSH\DeepSeek Harness.exe" "test/upstream-smoke.mjs"
& "D:\Program Files\DSH\DeepSeek Harness.exe" "test/provision-unit.mjs"
```

`dispatch-seam` 挂了 = **最关键的那条缝隙没了**（Gateway 的 view 不再读取实例 own property）。
真到这一步，插件的主路线就断了，需要回到本文第三节重新找缝，而不是"修一修"。

### 3. 端到端验收（需要一个连上的节点）

```bash
node test/host-routing.mjs    <base> <token>
node test/workspace-flow.mjs  <base> <token>
node test/tool-parity.mjs     <base> <token>
node test/tool-git-image.mjs  <base> <token>
node test/client-bundle.mjs   <base> <token>
```

这五个要一个跑着的 Host（`dsh --profile <非 desktop> --host 127.0.0.1 --port 0 --no-open`）
和一个已连接节点。四个断言最值钱：

| 断言 | 说明它守住了什么 |
|---|---|
| `event types are not corrupted by identity translation` | 身份重写没有波及事件**类型**（`session-log-…/delivery-accepted`） |
| `workspaceFiles/readBytes returns real bytes` | Gateway 的 multipart 应答解码还活着（远端图片/PDF 预览靠它） |
| `the agent used its own read/write/edit tool` | 工具没有被静默退化成"全部走 bash" |
| `no tool call mentions a real Windows path` | 没有东西偷偷镜像回了本机 |

---

## 二、每次升级要对照的上游契约

升级时最容易悄悄改变的是下面这些。每一条都有对应的测试，改了就重跑它。

| 上游契约 | 在哪 | 变了会怎样 | 谁守 |
|---|---|---|---|
| `@Remote` 描述符写在**类原型**上，Gateway dispatch 用 `Reflect.get(view, name)` | `dsh-typert-protocol`、`dsh-api-gateway` | 实例覆写不再生效，所有路由失效 | `dispatch-seam.mjs` |
| Gateway 用 `Function.prototype.toString` 解析**形参名** | `dsh-api-gateway` | overrider 的形参名对不上 → `missing "xxx"` | `host-routing.mjs` |
| 流方法的第一个位置参数**就是** request 对象（不是 `{request}` 包装） | `dsh-api-session-controller` | 流端点全部 not-found | `workspace-flow.mjs` |
| 带字节的结果走 `multipart/form-data`，`Uint8Array` 在 JSON 里是 `null` | `dsh-api-gateway` + `dsh-client-connection` | `readBytes` 报"非 JSON 应答" | `multipart-unit.mjs` + `host-routing.mjs` |
| Gateway 每 2 秒 ping 一次，不应答就断 | `dsh-api-gateway` (`websocketHeartbeatIntervalMs`) | 流两秒后静默消失 | `gateway-smoke.mjs` |
| `typert.lookups.configure(key, …)` 每 key 一次，且**优先于** provider | `dsh-typert-registry` | `workspaceFileScope` 无法解析远端会话 | `host-routing.mjs` |
| `SessionId` 无格式校验（只是 brand） | `dsh-session` | 不能再塞 `fleet_…` 身份 | `routing-unit.mjs` |
| 模型行的 id/包名 + `configEditor.configuration()` 的返回形状 | `dsh-config-editor`、`dsh-llm-*` | 下发到节点的 overlay 缺字段 | `provision-unit.mjs` |
| `dsh --patch <file>` 接受额外 patch 层 | `dsh` CLI / `dsh-app-boot` | 节点无法只当大脑 | `provision-unit.mjs`（结构）+ 实测 |
| 客户端插件槽位名（`settings.section` / `sidebar.panellist` / `main`） | `dsh-client-ui-*` | 设置页或侧栏面板不出现 | `client-bundle.mjs` |

**查上游契约的办法**（不用读 TypeScript 源码）：

```bash
# 一个服务的完整 Remote 签名
dsh --profile <p> --dump-config           # 行与包名
cordis_inspect listService                # 服务方法签名（含 @Remote 标注）
# 某个 Remote 端点的精确 wire 形状
node -e "..."  # 读该包 lib/typert.remote-client.js 里的 <endpoint>_parameter_<n>$schema
```

---

## 三、如果主路线真的断了（`dispatch-seam` 失败）

先确认是不是这三条缝隙之一变了，**不要**马上想到 fork：

1. 实例 own property 还能不能覆盖 dispatch？读 `dsh-api-gateway/lib/index.js` 里
   `invokePrepared` / `prepareInvocation`，看它取方法用的是 `Reflect.get(view, name)` 还是
   读原型上的描述符。如果改成读原型，覆写就失效了 —— 这时才有必要考虑换方案
   （例如注册一个自己的 provider，或者 fork，但 fork 的维护成本要高得多）。
2. lookup 还能不能 override？读 `dsh-typert-registry` 的 `lookups.configure`。
3. SSH 上的 HTTP/WS 还通不通？这跟 DSH 版本无关，基本不会坏。

---

## 四、给节点装什么版本

**节点永远安装与本机 desktop profile 完全相同的版本**（`localDshVersion()` 从
`$DSH_INSTALL_DIR/package.json` 读）。理由：Session 日志格式、事件类型、投影结构都随版本走，
两边版本不一致会以"能连上但会话显示错乱"这种最难查的方式失败。

版本不符时 `connect` 会自动 `npm install` 到节点，所以**升级桌面端后第一次连节点会慢**
（几分钟），之后复用。

---

## 五、节点侧的改造：只当远程大脑

节点的常驻宿主是一个**独立的 DSH 安装**，有自己的 `~/.dsh`。插件用 `--patch` 给它在启动时
叠加一份自己拥有的 overlay（`~/.dsh-fleet/run/brain.patch.yml`），内容是：

1. **模型行**：从本机 `configEditor.configuration()` 复制 provider 路由、默认模型、权限预设。
   账号登录型的 provider 不复制（那是本机的登录态）。
2. **凭据**：把那些行点名的 `apiKeyEnv` 对应的键从本机取出来，通过节点自己的
   `credentials/set` 推进节点的凭据库。
3. **只留大脑**：把 `@deepseek-ai/dsh-client-ui-*` 这些纯浏览器插件全部 `disabled: true`。

为什么不 fork 源码删代码：节点上装的是 npm 上的 `@deepseek-ai/dsh`，fork 就意味着
每次官方更新都要手工合一次，而且节点与本机版本就再也对不齐了。用 `--patch` 达到同样效果，
且**升级后自动跟随**（那份 UI 行清单是每次连接时从本机活组合里现算的，不是写死的）。

**overlay 是幂等的**：内容没变就不重启节点宿主（`writePatch` 返回 `changed: false`）。

**凭据不会重复写**：每次连接都会推一次（覆盖写），所以本机换了 key，重连节点就同步了。

---

## 六、小改动怎么发

插件是 `link:` 进 profile 的（`@local/dsh-fleet: link:D:/ProjectHub/DSHpl/packages/dsh-fleet`），
所以改代码后：

| 改的是 | 怎么生效 |
|---|---|
| `src/client/client.js`（浏览器半） | 桌面端**刷新页面**即可；若同时跑着 `pnpm run dev:web` 则热更 |
| `src/index.js`、`src/host/**`、`src/ssh/**`、`src/remote/**`（Host 半） | 必须**重启桌面端** |
| `cordis.patch.yml`（插件自己的 patch 层） | 重启桌面端 |
| `locale/*.json`、`icon.svg` | 刷新页面 |

改完一个 Host 半的改动后，最小的验证是：

```bash
node test/routing-unit.mjs && node test/multipart-unit.mjs
```

然后再跑一个端到端（`host-routing.mjs` 或 `workspace-flow.mjs`）。
