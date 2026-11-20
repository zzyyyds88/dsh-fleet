# ADR-0005 发布与维护：包名、发布形态、三条升级链

> 状态：**部分被推翻**（2026-11-20，0.6.0）。包名与「发 npm」这两条不再成立：项目已改名为
> `dsh-remote-node-harness`，并且整体放弃 npm，只发 CNB（下载）与 GitHub（发行）。本文其余章节
> （三条升级链、tarball 形态）仍然有效。改动记在 `CHANGELOG.md` 的 0.6.0 段。
> 上承 [ADR-0004](adr-0004-node-control-and-picker.zh.md)。
> 本文只决定「怎么发、怎么维护」，不改任何运行时行为。
> 现在怎么用：安装与升级步骤见根 [README.md](../README.md) 与
> [`packages/dsh-remote-node-harness/docs/UPGRADE.zh.md`](../packages/dsh-remote-node-harness/docs/UPGRADE.zh.md)。
>
> 下面正文里的 `dsh-fleet` 与 `@greatbaby/dsh-fleet` 是**当时的名字**，保留原样以免伪造事实。

## 一、背景：要发，但当时发不出去

用户要求把插件发布到 GitHub 与 npm 作为长期维护对象。核对现状后有三类问题：

| 问题 | 实测证据 |
|---|---|
| 仓库落后于代码 | `origin/main` 停在 11-17，本地领先 **21 个提交**（40 文件、+5467 行） |
| README 与代码漂移 | 根 README 写「测试矩阵 14 项」，实际 30 个套件；`/@fleet`、`node-control`、`fleet_nodes`、`dsh plugin add` 在根 README 里**一个字都没有** |
| 没有许可与包元数据 | 仓库根无 `LICENSE`（README 却声称 MIT）；`package.json` 缺 `repository`/`license`/`keywords`/`homepage`/`bugs`/`author` |

## 二、包名：`@local/dsh-fleet` 发不出去，必须改

**决定：`@greatbaby/dsh-fleet`**（用户已确认）。

### 为什么必须改，不是偏好问题

三条独立的硬阻塞，都实测过：

1. **`@local` 这个 scope 不是本项目的。** `GET https://registry.npmjs.org/-/org/local/user`
   返回 **200 `{"local":"owner"}`**，而对照：`zzyyyds88` 与任一随机串都返回 **404**。
   也就是说 `local` 是**别人的组织**，`npm publish @local/dsh-fleet` 会被 registry 拒绝。

2. **`dsh-fleet` 这个无作用域名已被他人占用。** `dsh-fleet@0.1.0`（author SnowDu，
   `github.com/scriptsnet/dsh-fleet`）主题与本项目**高度重叠**（都是 DSH 多机），只是路线不同
   （算力池 vs 远程工作区）。同名既发不上去，也会让用户把两个项目搞混。

3. **曾被选中的 `@zzyyyds88` 也不行 —— 那个 scope 不存在。** 这一条是实际发布时才暴露的：
   GitHub 账号叫 `zzyyyds88`，但 npm 账号叫 `greatbaby`（`npm whoami` 实测），而 npm 的 scope
   只认**账号名或组织名**，不认 GitHub 用户名。`npm access list packages '@zzyyyds88'` 返回
   `404 Scope not found`，`@greatbaby` 则正常。**教训：选包名前先跑 `npm whoami` 确认登录的是
   哪个账号，而不是照着 GitHub 用户名拼 scope。**

### 为什么选作用域名而不是再找一个无作用域名

`dsh-fleet-remote`、`dsh-node-fleet` 实测都可用，但无作用域名与 GitHub 仓库名不一致，日后
**任何名字都可能被别人先注册**；作用域名 `@greatbaby/*` 属于发布账号本人，注册即得。

### 代价：改名波及 52 个文件，且 client id 必须一起改

官方 `dsh-doc` 的 `references/ui-plugin.md` 原话：
**"The browser artifact registers a lazy factory whose id equals the package name."**
所以 `src/client/client.js` 的 `id` 与包名是同一个事实的两处记录，必须同步。

**`@local/dsh-fleet-brain` 不改名。** 它是内嵌在 fleet 里的节点侧组合，连接时按文件写进节点
profile 的 `node_modules`，**从来不走 registry**。改名没有收益，只会多一处不一致。
**`repository`、`homepage`、`bugs` 里的 `github.com/zzyyyds88` 也不改** —— 那是仓库地址，
与 npm scope 是两件不同的事。

## 三、发布形态：npm 为主，tarball 与本地目录为备

| 形态 | 用途 | 命令 |
|---|---|---|
| **npm（主）** | 用户安装 | `dsh plugin --profile <p> add -w @greatbaby/dsh-fleet` |
| tarball | 离线环境、无法访问 registry | `dsh plugin ... add -w ./dsh-fleet-x.y.z.tgz` |
| 本地目录 | 开发（`link:`） | `dsh plugin ... add -w <绝对路径>` |

三者都是 `install-spec.ts` 原生支持的形态（registry / tarball / path），不是自造。

配套：`private` 从 `true` 去掉（保留则 `npm publish` 直接拒绝）；补 `repository` / `license` /
`homepage` / `bugs` / `keywords` / `author` / `publishConfig`；删掉被跟踪的
`package-lock.json`（里面写的是 `0.1.0`，早已过期，而 profile 的依赖由 pnpm 管理）。

### 被否方案

- **只发 GitHub Release、不发 npm。** 用户明确说要「用 npm 包安装」，且这是维护成本最低的分发方式。
- **把 brain 也发 npm。** 无必要：节点拿到的是内嵌文件，且有 digest 去重；多发一个包只多一条
  要维护的版本线。
- **镜像进 DSH 官方 Discover 索引。** 需要上游收录，不在本项目控制内。

## 四、三条升级链：现在只有一条有防线

这是本文最重要的一节，也是**至今仍然成立**的一条判断。

| 升级对象 | 防线 | 空白点 |
|---|---|---|
| **DSH** | 契约表 16 条，每条挂一个测试；`dispatch-seam.mjs` 钉运行时缝隙 | 无（够用） |
| **中转 `ds-harness-remote`** | **无自动断言** | fleet 有三处行为围着中转写：`ensureHostWorkspaceDirectory` 的 `mkdir`、`directoryPicker/list` 被接管、`TerminalCarrierCompat` 合成 attach。任何一处变了，手机端静默坏掉，而现有 e2e **全部走本机 `/api`，不经中转真实 dispatch** |
| **DSH Go（安卓）** | **无自动断言** | 客户端的 `harnessRemoteAllowlist` 是 `const Set`，Host 侧改不了。已发生一次真实漂移：中转放行 `subagents/interruptByParent`，而 0.2.2-rc.3 的真实端点是 `subagents/interruptByUser` —— 手机因此完全无法中断子代理 |

### 决策：做成「可执行的报告」，不是「记得看一眼」

`UPGRADE.zh.md` 补两节，各配一条可执行检查：

1. **中转升级后**：比对三处被依赖的行为。前两处可以用既有测试间接覆盖（`picker-flow` 覆盖命名
   空间与影子目录清理、`workspace-browse` 覆盖选择器）；第三处（终端四跳接力）的判断依据是中转的
   `terminal-carrier-compat` 仍在把 follow/write/resize 合成 attach。
2. **DSH Go 升级后**：`scripts/check-phone-allowlist.mjs` 把「中转放行集合」与「本机真实 wire
   端点集」做双向差集，并把已知漂移钉成表。

### 为什么不做成自动断言

做过一次比对：allowlist 99 条、本机 wire 端点 90 条、allowlist 里 52 条在本机不存在。
原因是 fleet 的装饰器在**运行时**补上端点（`workspace/create`、`directoryPicker/list` 等），
静态扫描源码得不出真实集合。硬断言会立刻红，而红了之后只能被注释掉 —— 那还不如改成清单。

## 五、版本与 tag

- 插件版本按 semver 走：**改运行时行为 → minor**，**只改文档/元数据 → patch**。
- 每次发布打 `v<version>` tag 并与 GitHub Release 对应；节点运行时制品
  （`dsh-<ver>-<platform>.tar.gz` + `.sha256`）挂在**同名 release** 下，避免用户困惑
  「为什么 release 里是 DSH 而不是插件」。
- `engines.dsh` 已 bound `>=0.2.2-rc.3 <0.3.0`：DSH 升到 0.3 时安装会被直接拒绝，
  这是设计意图（宁可拒装也不要半组合）。

## 六、CI：只跑不需要 DSH 安装的那一层

GitHub Actions 跑 **8 个纯 Node 套件**（`routing-unit`、`routing-extra-unit`、`multipart-unit`、
`waterfall-unit`、`version-unit`、`picker-paths-unit`、`install-unit`、`fleet-control-unit`），
不跑契约层与 e2e。

依据是实测的依赖边界：这 8 个套件**只 import `node:` 与相对路径**，不碰 `app.asar`，不碰 `ssh2`
（`ssh2` 只有 `src/ssh/connection.js` 一个文件直接 import，而这 8 个套件的 import 链都不经过它，
所以 CI 里可以 `--ignore-scripts` 装也不装依赖）。契约层要已安装的 DSH，e2e 要运行中的 Host +
SSH 可达的节点 —— 两者都放在本地 `run-all.mjs` 里跑。

这 8 个套件覆盖了路由身份编码、多部分解码、路径命名空间、清单自洽、节点控制面、版本闸门、
waterfall、以及离线层的路由形状 —— 正好是「改一行代码最可能碰坏」的那部分。

## 七、影响面（实施时的清单，已全部落地）

| 文件 | 变化 |
|---|---|
| `LICENSE` | 新增（MIT） |
| `CHANGELOG.md` | 新增 |
| `packages/dsh-fleet/package.json` | 改名、去 `private`、补 npm 元数据与 `publishConfig` |
| `packages/dsh-fleet/cordis.patch.yml` | 插件行 `name` |
| `packages/dsh-fleet/presets/node-control.patch.yml` | 预设引用新名 |
| `packages/dsh-fleet/src/client/client.js` | 客户端插件 `id`（官方要求等于包名） |
| `packages/dsh-fleet/src/core/plugin-sync.js` | `NODE_NEVER_SYNC` / `isThirdParty` 的新旧两名并存 |
| `packages/dsh-fleet/test/*.mjs` | 名与 `private` 相关断言 |
| `README.md`、`packages/dsh-fleet/README.md` | 安装章节改为 npm 优先，五处过期修正 |
| `packages/dsh-fleet/docs/UPGRADE.zh.md` | 补中转与 DSH Go 两节 |
| `.github/workflows/ci.yml` | 新增 |
