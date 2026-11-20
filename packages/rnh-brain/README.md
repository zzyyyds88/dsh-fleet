# `@local/rnh-brain` — 节点侧的 DSH 组合

一台被 `@local/dsh-remote-node-harness` 接管的机器要当**远程大脑**：跑 agent、执行工具、服务
Remote API，但**不服务浏览器**。上游没有这样的 bundle，这个包就是它。

节点 profile 现在组合：

```
@deepseek-ai/dsh-base + @local/rnh-brain
```

而不是：

```
@deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app
```

差别不是"加载后 disable"，而是**那一层根本不在组合里**：57 个 `dsh-client-ui-*`
包连 `import` 都不会发生。

## 定制分两层：组合层改包，运行时改树

本包管**第一层：加载哪些行**，不动官方包的一个字节。

| | 改官方包的源码 | 定制组合层（本包） |
|---|---|---|
| 节点装什么 | 自己改过的 `@deepseek-ai/dsh-*` | 官方包 + 一个本地 bundle |
| 删 UI 的彻底程度 | 物理删除 | 组合层不含该行 → **根本不加载** |
| 出问题的样子 | 编译错 / 缺符号 | 启动时明确报 "entry did not activate" |

DSH 是 Cordis 组合式架构：一个插件是否存在于运行时，完全由组合层决定。所以
"删掉 UI"的正确做法是让那些行不进入组合。

**第二层是节点跑哪棵树**，由 `packages/dsh-remote-node-harness` 的 fork 构建脚本管
（`scripts/build-fork-runtime.mjs` + `trim-fork-runtime.mjs`）：节点运行时来自本仓库对上游源码的
fork，只留大脑需要的包（实测 957.3 MiB → 408.6 MiB），npm 兜底路线整条删除。理由与代价见
[`docs/adr-0007-fork-node-runtime.zh.md`](../../docs/adr-0007-fork-node-runtime.zh.md)。

两层不重叠，也不能互相替代：组合层决定要哪些行，运行时决定那些行的代码从哪来、磁盘上有哪些包。

## 组成

```
cordis.patch.yml      生成物：从官方 web-app patch 减去浏览器面（59 行）
presets/*.yml         原样复制：大脑的 Session 也是普通 Session，靠 preset 挂工具
src/runtime.js        手写：大脑唯一的专属代码
scripts/              生成、校验、嵌入
```

### `src/runtime.js` 做三件事

1. **打印入口 URL** —— 取代被去掉的 `web-runtime`。格式 `dsh web: <url>?token=…`
   与本机桌面端解析的那一行完全一致，rnh 插件靠它拿到端口和 launch token。
2. **认领 index fallback 座位做 `?token=` → cookie 交换** —— 大脑没有 dist，但
   `/api` 需要 cookie。少了这个座位，`/?token=…` 会落到一个没有 fallback 的
   webserver 上，直接 404，看起来像"节点没有 Remote API"，其实 API 本身是好的。
3. **提供 `webApp` 服务** —— Host 契约的一部分，其它行会读。

它**不挂** `frontend-static`、**不开**浏览器、**不组装** `window.__DSH_BOOT__`。

## 生成与校验

```bash
# 1. 从"已安装的那个 release"派生组合（默认读 DSH_INSTALL_DIR）
node scripts/sync-from-upstream.mjs

# 2. 断言结果仍然是个大脑
node scripts/check-composition.mjs

# 3. 嵌进插件（插件运行时读的是嵌入副本，不假设本包在盘上）
node scripts/embed-into-rnh.mjs
```

`sync-from-upstream.mjs` 的规则：

- **keep**：全部 host-plane 行 —— Remote 控制器、webserver、`/api`、服务、`web-startup`。
- **drop**：全部 `dsh-client-ui-*`，加 9 个浏览器专属行（`web-runtime`、`modules`、
  `client-hmr`、`harness-dev-context`、`directory-picker`、`open-in-app`、
  `session-log-download`、`product-analytics`、`desktop-product-telemetry`），
  每个在脚本里写了理由。
- **公式化复制**：`system-prompt`、`session-query-sqlite` 两个 surface 值，以及
  agent plane 的 22 条 `disabled: true`（大脑的 Session 和桌面一样通过 preset 挂工具）。

### 为什么必须从"已安装的 release"派生

第一版从 master 生成，多出了一行 `authentication-token`。而 `0.2.2-rc.3` 根本没
发布 `dsh-host-authentication-token` 这个包，节点启动直接报：

```
1 entry did not activate: Cannot find package '@deepseek-ai/dsh-host-authentication-token'
```

master 领先于发布版。组合必须描述它要**启动进去的那个运行时**，所以默认源是
`DSH_INSTALL_DIR`，git checkout 只作为对照手段（`DSH_SOURCE=`）。

## 升级 DSH 之后

```bash
node scripts/sync-from-upstream.mjs
git diff packages/rnh-brain/cordis.patch.yml
```

diff 里出现的每一种变化都值得看一眼：

- 多了一行 host 服务 → 大脑大概也该保留。
- 多了一行浏览器专属 → 加进脚本的 `DROPPED` 并写理由。
- 某行 id 被重命名 → 本包的 patch 会指向不存在的 id，`check-composition` 会失败。

后者是唯一的真实风险：行 id 是上游的内部命名，不是公开契约。所以
`check-composition.mjs` 把它变成**启动前的显式断言**，而不是等运行期发现。
