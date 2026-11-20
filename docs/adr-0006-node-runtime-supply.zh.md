# ADR-0006 节点运行时供给：制品优先，节点自建兜底

> 状态：**第二、三节与第九节已被 [ADR-0007](adr-0007-fork-node-runtime.zh.md) 推翻**
> （2026-11-20）。两条路线收敛成一条：节点运行时由本项目从 fork 编译，npm 兜底整条删除。
> 仍然有效的是第四节（构建戳）、第五节（实测数据）、第六节（制品缺陷）、第七、八节
> （发布侧），以及第四节第 2 条对 `engines` 的结论。读本文时以 ADR-0007 为准。
>
> 原始状态：已定（2026-11-19）。用户已确认「制品路线保留，别人想自己构建就自己构建」。
> 上承 [ADR-0005](adr-0005-release-and-maintenance.zh.md)。
> 本文只决定「节点的运行时从哪来」，不改路由、组合、会话语义。
> 现在怎么用：安装与升级步骤见根 [README.md](../README.md) 与
> [`packages/dsh-fleet/docs/UPGRADE.zh.md`](../packages/dsh-fleet/docs/UPGRADE.zh.md)；
> 设计与实测数据见 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) 六之四。

## 一、问题：一个本可以在节点上完成的工作，变成了所有人的等待

节点上的 DSH 是一份**独立安装**，版本必须与桌面**完全相等**（见 ADR-0002 与六之四）。它原来
只有一条来路：维护者在本机跑 `scripts/publish-runtime.mjs`，按平台打出
`dsh-<version>-<platform>.tar.gz`，传到 GitHub Release，节点再从加速站下载。

于是上游每发一个 DSH 版本，所有节点都卡在「制品还没打」上。而那份制品的内容，实测就是

```
npm install --os=<目标os> --cpu=<目标cpu> --libc=<目标libc> '@deepseek-ai/dsh@<版本>'
```

在维护者机器上跑 76 s 的结果 —— 也就是说，这件事本来**节点自己就能做**。

上游的每个发行版也都在 npm 上（`@deepseek-ai/dsh` 已发 46 个版本，`next` 标签是
`0.2.2-rc.5`，91 个依赖里 83 个是精确锁定），所以「节点自己解析」不是新能力，是把已有的
能力接上。

> **这一段的前提已经不成立。** 制品的内容不再是「上游发布版跑一次 npm install」，
> 而是本项目从 fork 编译并裁剪出来的树（实测 957.3 MiB → 408.6 MiB）。节点自己解析
> 永远得不到那份字节，所以兜底路线不是「慢一点」，是「换了一个运行时」。
> 见 ADR-0007。

## 二、决定：两条有序路线，制品优先（已被 ADR-0007 推翻）

`RUNTIME_ROUTES = ['artefact', 'npm']`，由 `RemoteHost.install` 依次尝试。

| 顺序 | 路线 | 何时用 |
|---|---|---|
| 1 | **制品** | 默认首选。一次下载、无 registry 依赖、字节确定 |
| 2 | **节点自建** | 制品拿不到时：所有源全挂、没有 `curl`/`wget`、`mirrors: []`、平台打不出标签 |

配置新增 `runtime: auto | artefact | npm`（默认 `auto`）与 `registry`。能强制单条路线，是为了
让失败可归因 —— 排查时不至于在一句复合错误里猜是哪条路出的问题。

**这三样都已经不存在了**（ADR-0007）：`RUNTIME_ROUTES`、`runtime`、`registry` 全部删除，
`mirrors` 也删除。删 `runtime` 不是精简，是因为留着它就成了陷阱 —— 见第三节。

## 三、判据：拿不到 ≠ 拿到的是坏的（结论保留，落点变了）

这是本次唯一的行为翻转，也是全部风险的集中点。

| 情形 | 处理（ADR-0006） | 处理（现在） |
|---|---|---|
| 所有源全挂（退出码 3，`ARTEFACT_UNAVAILABLE`） | 落 npm | **报错**，列出试过的 URL |
| 没有 `curl` 也没有 `wget` | 落 npm（原来直接报错） | **报错**，点名缺下载器 |
| `mirrors: []`（原来是配置错误） | 落 npm，等于「制品路线关掉了」 | 该配置项已删除 |
| 平台打不出标签 | 落 npm（原来也是这样） | **报错**，点名平台 |
| 校验和不符（退出码 4） | 回滚 + **抛错**，不落 npm | 不变 |
| 解包失败 / 归档里没有 `node_modules/@deepseek-ai/dsh/lib/bin.js`（退出码 5） | 回滚 + **抛错**，不落 npm | 不变 |

理由里仍然成立的一半：**拿到了但坏了**是从 registry 再解析同一份坏版本也不会变好的事，只会更慢、
下载更多，并把「哪一个源坏了」掩盖掉 —— 这一条现在更强，因为根本没有 registry 可落。

不再成立的一半：**拿不到**曾经是「上游刚发版、制品还没打」的常态，而兜底装的是同一个官方版本，
所以「慢一点」说得通。现在兜底装的是**另一个运行时**（上游树而不是 fork 树），它写的是同一枚
`{"build":4,"via":"npm"}` 的戳，于是一次网络抖动就会把节点永久钉在上游版本上，界面还显示
「已就绪」。**留着它比删掉它更危险**，所以整条删掉，不是关掉开关。

## 四、两件必须一起做的事

### 1. 安装写同一枚构建戳

`BUILD_STAMP`（`.fleet-artefact.json`）的内容是 `stampJson()` 的
`{"build":N,"via":"artefact"|"npm"}`：

- `build` 参与判定，必须等于 `RUNTIME_BUILD`；
- `via` 只上报，不参与判定 —— 它记录的是「这棵树怎么来的」，不是「能不能用」。

`npm` 这个值现在只出现在**旧节点**的戳里。读取端必须照旧认它（否则格式变化会把在用节点判成
不可用），但不再有任何代码写它。`RUNTIME_BUILD` 升到 4 之后，那些树会被 `build` 判定为需要重装，
理由和它记录的路线无关。

没有这枚戳，`inspectRuntime` 会把树读成「早于构建戳」→ `decideGate` 返回
`node-runtime-repack` → **每次连接重装一次**。实测过这条链：`daemon.js` 的 npm 分支当时不写戳，
把它接成兜底后，一分钟的安装会变成一分钟的连接。

`parseStamp` 仍认旧格式的裸整数（现场节点的 `2`）。格式升级不能把在用节点判成不可用 ——
那会让所有人为了一个格式改动各自重装一次。

### 2. `engines` 报而不拦

上游 `0.2.2` 的四个 rc（rc.1/rc.3/rc.4/rc.5）全部声明 `engines.node: ">=24.9.0"`，而参考节点
是 **Node v22.20.0**，它一直在跑 rc.3。制品路线从不读这个字段（它解包一棵树），所以这条闸门
不能因为安装方式换成 npm 就突然变成硬停。

做法：`npmInstallScript` 用 `--engine-strict=false` 装，装完比对一次，不符就回 `engineWarning`，
界面如实显示。**抱怨、可运行、不静默**是这三条。

> **这条已经自然消解**（ADR-0007）：节点不再解析 registry，`npmInstallScript` 与 `engineWarning`
> 一起删除。解包一棵树永远不读 `engines`，所以 `MINIMUM_NODE_MAJOR = 22` 就是节点真实的门槛，
> 不存在「同一条闸门在两条路线上松紧不一」的问题了。下面的判定依据仍然有效。

> **已决（2026-11-19）：节点不升 Node 24，`MINIMUM_NODE_MAJOR` 保持 22。** 用户的原话是「有必
> 要就升，没必要就拉倒」，下面是判定「没必要」的实测依据：
>
> | 检查 | 结果 |
> |---|---|
> | 参考节点实际运行 | Node v22.20.0 + DSH 0.2.2-rc.5，连接与 e2e 全绿 |
> | `dsh` 的 `engines.node` | `>=24.9.0`，但只在 npm 路线上被读到，且已 `--engine-strict=false` |
> | 305 个依赖包里真正的 Node 24 API（`Promise.try` / `RegExp.escape` / `Float16Array` / `node:sqlite`） | **0 处** |
> | 唯一的 `await using` 命中 | `dsh-ptc-runtime-node/lib/process.js` 里 acorn 的**解析器字符串字面量**，不是语法；`node --check` 在 22 上通过 |
> | `workflow-ptc` 会不会加载 | brain 组合里 `disabled: true`，节点组合是 `dsh-base + rhino-mode + fleet-brain`，加载不到 |
>
> 也就是说 `engines` 这条声明在今天**只是建议**：没有任何一条被实际执行的代码路径需要 24。
> 抬高门槛的唯一后果是一部分现场机器连不上，而换不来任何东西。什么时候该重开这个决定：
> 依赖闭包里出现真正的 Node 24 语法或 API（`node --check` 或一次真实启动就能发现），
> 或者上游开始用 `engines` 之外的机制强制版本。

## 五、代价（实测）

参考节点（Linux x86_64）：glibc 2.35 / Node v22.20.0 / npm 10.9.3 /
registry 指向 `npmmirror`（metadata 0.148 s）。

| 路线 | 耗时 | 树大小 | 额外依赖 | 备注 |
|---|---|---|---|---|
| 制品（CNB） | 一次 162 MiB 下载，实测 4 311 729 B/s 约 40 s | 669.3 MiB / 51 419 文件 | CNB 可达 | 可离线；打包时裁过 |
| 制品（加速站） | 同一次下载，加速站 0.2–9.6 MB/s，抖动 40 倍 | 同上 | 加速站可达 | 灾备 |
| 节点自建 | `npm install` 26–33 s / 673 包 | 958 MiB / 93 983 文件 | registry 可达 | 首次 275.7 MiB npm 缓存；同版本第二次 1 s |

本机（Windows，跨平台解析 `--os=linux --cpu=x64 --libc=glibc`）实测 83.2 s / 968.2 MiB /
94106 文件；`npm ci` 加平台标志 53.4 s，正确跳过 win32 的包。

两条树差 289 MiB（+43.1%），差在 `STRIPPED`：`.map` 9 933 个、`.d.ts` 16 144 个、`.md` 与
per-package 的 test 目录都不进制品。只影响节点磁盘占用，不影响可用性。

**当时的真机验收证据**：`test/npm-install-acceptance.mjs` 在参考节点上两次通过（22 项断言，
含戳、原生包、`koffi/build` 缺席、`spawn-helper` 可执行）；`run-all.mjs --layer e2e --only
session,node-control` 在一个真 Host 上跑了 112.4 s 全绿，之后节点上的
`~/.dsh-fleet/runtime/.fleet-artefact.json` 是 `{"build":3,"via":"npm"}`、版本 `0.2.2-rc.5` ——
也就是说那次连走的就是兜底路线，并且没有触发第二次安装。

> 那个套件已随路线一起删除。它证明的是「上游发布版能在这台节点上装起来」，而这个前提在
> ADR-0007 之后不成立了 —— 节点现在要的是 fork 的树，registry 上根本没有那份字节。

结论（**已被 ADR-0007 推翻**）：**路线顺序不该反过来**。npm 慢一点、多一个依赖，但它换来的
是「不等任何人」。代价是它对节点上跑的是**哪一棵树**没有任何话语权，而后者比等待更重要。

## 六、顺手修掉的两个制品缺陷

这两条不是本次的目标，但都在同一条路径上，且都会在别的节点上以更难查的形式出现：

1. **制品里有打包机的原生产物。** install 脚本按**打包机**的 `process.platform` 跑，koffi 的
   `cnoke` 在 Windows 上编出 `koffi/build/win32_x64`。实测那份 rc.5 归档里有 48 个
   `.exe`/`.cmd`/`.dll`/`.lib` 和 147 条 `koffi/build` 条目，全在一个 `linux-x64` 制品里。
   改法：解析加 `--ignore-scripts`（树里每个原生依赖都自带预编译平台包；实测带脚本
   968.2 MiB / 94106 文件，不带 957.3 MiB，四个原生模块都在）。
2. **可执行位传不了。** 实测 bsdtar 在 Windows 上给每个条目写 `-rw-rw-rw-`，51500 个文件全是，
   仅 20 个带 `+x` 且全是 `.exe`/`.cmd`；`chmodSync` 在 Windows 是空操作，`--owner/--group`
   改了也没用。改法：`installScript` 在节点解包后自己 `chmod 0755` 那两个
   `node-pty/prebuilds/*/spawn-helper` —— 少了这一步，Darwin 节点的终端在第一次打开时才失败，
   而错误信息一个字都不会提到这个文件。这一条同时修好已经发出去的归档。

`RUNTIME_BUILD` 因此从 2 升到 3。

## 七、制品构建搬到 CI（仍然有效，但 CI 打包的不是 fork）

`.github/workflows/release-runtime.yml`：四平台（linux-x64 / linux-arm64 / darwin-arm64 /
win32-x64）各自在**本平台** runner 上打包，`workflow_dispatch` 给入参版本，
`repository_dispatch` 接 webhook。

打包与上传分成两个作业：四条腿同时 `gh release create` 会互抢，而抢输看起来像打包 bug。
pack 不 `fail-fast`：某个平台没成，其余平台的节点照样能走快路径。

在本平台 runner 上打包**不是**为了让原生包正确（`--os/--cpu/--libc` 已经保证了），而是为了
让 `tar` 能记下可执行位 —— Windows 记不了（见上）。

> **现在这个工作流打包的是上游发布版，不是 fork。** fork 路线要在有 fork checkout 的机器上跑
> `build-fork-runtime.mjs`（见 ADR-0007 与 UPGRADE 第五节）。两者共用同一个上传脚本
> `publish-runtime.mjs`，所以归档形状、校验和、CNB 的四个坑都只有一份实现。

## 八、制品发到哪：CNB 主源，GitHub 加速站灾备

原来只有 GitHub Release 一条去路，节点靠**前缀加速站**下载。前缀加速表达不了 CNB 的路径形状
（`https://cnb.cool/<org>/<repo>/-/releases/download/<tag>/<file>`），所以 `artefactUrls()` 从
「前缀数组」改成「源对象数组」：

```js
DEFAULT_SOURCES = [
  { kind: 'template', template: 'https://cnb.cool/serendipity-archive/dsh-fleet/-/releases/download/{tag}/{file}' },
  { kind: 'prefix', prefix: 'https://git.yylx.win/' },   // 以下四项仍拼接 GitHub 官方 URL
  { kind: 'prefix', prefix: 'https://gh.inkchills.cn/' },
  { kind: 'prefix', prefix: 'https://tvv.tw/' },
  { kind: 'prefix', prefix: 'https://ghfast.top/' },
]
```

> **加速站已经退役**（ADR-0007）：`DEFAULT_SOURCES` 只剩第一条，其余四项进 `RETIRED_MIRRORS`
> 只作记录。原因是国内节点连不上 GitHub —— 加速站是给 GitHub 加速的，前提不成立；而且它们
> 实测抖动 40 倍。GitHub Release 仍收到同一份字节（`--publish`），但节点不从那里取。

`mirrors: string[]` 继续可用（转化为 prefix 源追加在模板源之后），`mirrors: []` 仍是「关掉制品
路线」的写法。`sources` 是整条有序列表，给需要自有布局的源用。

**为什么把 CNB 放第一，实测**（参考节点，整档 170 092 405 字节）：

| 源 | 10 MiB 分段实测 |
|---|---|
| cnb.cool（302 → asset.cnb.cool，Range/206） | **4 311 729 B/s**，重复测量抖动 <1% |
| gh.inkchills.cn | 178 047 B/s（同一时段） |
| 四个加速站历史区间 | 0.2–9.6 MB/s，**抖动 40 倍** |

抖动才是问题：同样的节点、同样的归档，有时 34 s 有时一小时，读起来就是「连接卡住了」。CNB 不
抖。仓库**公开**是刻意的 —— 节点上不放任何 CNB 凭据，匿名 `GET` 就能下。

发布侧的四个坑，全部实测撞过：

1. `target_commitish` 是必填，且必须能解析成提交对象 —— 空仓库没有提交，先 push 一次 `main`。
2. 重复建同名 release 返回 **409**，响应体里没有 id；要按 tag 再查一次。
3. `PUT` 到预签名地址返回 200 **不等于附件已关联**：必须再 `POST` 一次返回里的 `verify_url`。
   少了这一步，release 的 assets 一直是空的，匿名下载 404。这条只写在 API 描述里。
4. `ttl` 最大 180 天，`0` 表示永久。制品要用永久 —— 否则半年后快路径会自己消失。

## 九、非目标（第一条已被 ADR-0007 推翻，其余保留）

- **~~不 fork 官方 DSH 包。~~** 现在 **fork 了**：节点运行时来自本仓库对上游源码的 fork，
  只留大脑需要的包。理由、裁剪规则与实测数字见 [ADR-0007](adr-0007-fork-node-runtime.zh.md)。
  「定制走 `@local/dsh-fleet-brain` 与 profile patch」这条仍然成立，只是不再是**唯一**的定制层。
- **不出锁文件。** 一份 `package-lock.json` 的 `resolved` 写死 registry 域名；实测 npm 11 的
  `replace-registry-host` 默认只对 `registry.npmjs.org` 开头的 URL 生效，把锁绑到 npmmirror 就
  在别的节点上失效。保持每次在线解析，代价可接受。
  > 现在构建发生在打包机上（`build-fork-runtime.mjs`），锁文件问题只剩打包侧；节点不再解析任何东西。
- **不把 npm 设成默认。** ~~制品快、可离线、字节确定；npm 是兜底，不是替代。~~
  **npm 已经不是兜底了**：整条路线删除。节点只有制品一条路。
