# 让 agent 装：一条 URL 走完

这份文档描述的是**唯一由 agent 驱动的安装路径**：不敲命令、不先下载、不需要 npm 账号。人只说一句「装远程节点插件」，剩下的由桌面端会话里的 `plugin_manager` 工具完成。

## 为什么这条路成立

DSH 自己的安装器接受三种 spec（`@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.js`）：

| spec 形态 | 判据 | 用途 |
|---|---|---|
| `@scope/name` 或 `@scope/name@range` | `PACKAGE_NAME` 正则 | 走 npm registry |
| 绝对路径 / `file:` / `link:` | `isAbsolute` | 本地开发（`link:` 保持软链） |
| `https://…/*.tgz` | `TARBALL_SPEC = /\.(?:tgz\|tar\.gz)$/i` | **一条 URL 直接装** |

第三行就是这里用的形态。它对参数的要求只有两条：以 `.tgz` 结尾，且不以 `.git` 结尾（后者会被当成 git 仓库）。CNB 的 Release 附件地址完全满足。

`plugin_manager` 工具的 `target` 参数原话是「Plugin entry id, bundle package name, or installation spec」——**installation spec** 就是上面那三种之一，http tarball 属于它。

## 人的用法

对 agent 说：

> 装远程节点插件

agent 执行：

```
plugin_manager(
  action = 'install_bundle',
  target = 'https://cnb.cool/serendipity-archive/dsh-remote-node-harness/-/releases/download/v0.5.1/greatbaby-dsh-remote-node-harness-0.5.1.tgz'
)
```

成功的标志是返回里 `application: 'applied'`，或者 `application: 'restart-required'` 加一句 `nextStep`（此时要重启 DSH）。之后 `list_bundles` 里能看到 `@greatbaby/dsh-remote-node-harness`。

**不再更新的版本没有第二条退路**：CNB 是唯一的目的地。GitHub Release 上不放插件 tarball——节点运行时那边需要灾备是因为它 162 MiB 且经第三方代理，插件本身 200 KB，一个源够用。

## agent 需要知道的边界

1. **只能在桌面端会话里做。** 中转插件的 `HARNESS_REMOTE_ALLOWLIST` 里有 `pluginManager/updateBundle`，**没有 `installBundle`**。手机端装不了插件；它负责的是装好之后连节点。
2. **装完要重启一次。** `tool-plugin-manager` 在 `dsh-base` 里是 `disabled: true`，只在 agent preset 里打开（`disabled: !!js "!ctx.get('profileContext')"`）。装插件这个动作本身在桌面端可用，但新装 bundle 的**客户端半边**要 Host 重启才会被 shell 加载。
3. **`engines.dsh` 会拦。** 插件的 `engines.dsh` 是 `>=0.2.2-rc.3 <0.3.0`。DSH 版本不匹配时安装会被拒绝，这不是 bug——绕过它需要用户明确接受崩溃与数据丢失风险（`acceptRisk`）。
4. **不要自己写 `~/.dsh/profiles/*/package.json`。** 走 `plugin_manager` 而不是手改 manifest：安装器会写 `dependencies`、更新 `bundles`、必要时提示重启。手改会在下一次 `dsh plugin` 操作时被覆盖。而且 profile 目录里必须已经有 `pnpm-workspace.yaml`——见下面「一个必须先知道的前置条件」。

## 装完之后

人要做的事接在这里（见根 `README.md`「加节点」）：

1. 设置 → Remote nodes → 加节点（host / 端口 / 用户 / 密码或私钥）
2. 点连接。首次连接会装同版本运行时、下发大脑组合与凭据、启动、验证 `session/list`
3. 加一个工作区：先选机器，再选目录

## 验证记录

2026-11-19，在一个新建的 `agentinstall` profile 上：

- `npm pack` 产出 `greatbaby-dsh-remote-node-harness-0.5.1.tgz`（45 个文件，209 KiB）
- 上传到 CNB Release `v0.5.1`：`POST releases` → 取预签名地址 → `PUT` → `POST verify_url` 确认 →
  assets 里出现该附件，CNB 算出的 sha256 与本地一致
- 匿名 `curl` 下载：200，214 188 字节，sha256 与本地一致
- `dsh plugin --profile agentinstall add -w <该 URL>` → `dependencies` 与 `bundles` 都被写上，
  `node_modules/@greatbaby/dsh-remote-node-harness` 里 `src/index.js` 与 `cordis.patch.yml` 都在
- 同一个 profile 起 Host → 日志出现 `rnh: routing …` 九行，`/rnh/api/nodes` 返回 200，
  节点记录（`~/.dsh/rnh/nodes.json` 是共享的）里那台机器报 `connected` 且**已经带上主机密钥**

### 一个必须先知道的前置条件

**profile 目录里必须有 `pnpm-workspace.yaml`。** DSH 自己在创建 profile 时会写它
（`dsh-app-boot` 的 `ensureProfile`：`package.json` + `cordis.patch.yml` + `pnpm-workspace.yaml`
三件套），但**手写一个只有 `package.json` 的目录**会得到一个看起来像 profile、实际不是的空壳：
`pnpm add -w` 报 `--workspace-root may only be used inside a workspace`，而 DSH 把它当成
「插件安装失败」。实测就是这么撞上的——`agentinstall` 第一次建目录时只写了 `package.json`，
安装直接失败；补上 `pnpm-workspace.yaml` 后 1.1 s 装完。

所以「让 agent 从零装」的正确前置是：**profile 由 DSH 创建**（`dsh` 首次启动那个 profile 时会写全
三件套），不要在它之前手搓目录。`plugin_manager` 的 `install_bundle` 走的是同一个
`runProfilePnpm`，所以它对这条前置的要求完全一样。

### 未验证的部分

`plugin_manager` 工具的 `install_bundle` **没有**在真实会话里跑过——本轮用的是同一个安装器
（`runPluginCommand` → `runProfilePnpm`）的 CLI 入口，参数与代码路径相同，但「模型调这个工具」
这一层没有实测。把它写成已验证是不诚实的，所以这里分开写。

