# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

三条规则：

- **改了运行时行为 → minor**，**只改文档与元数据 → patch**，**破坏既有安装或身份语义 → major**。
- 每条都说清「谁受影响」，因为这套东西的读者是「装它的人」，不是写它的人。
- 与 `docs/ARCHITECTURE.md` 的章节对应，细节不去那边重复。

## [未发布]

## [0.5.1] — 2026-11-18

**只改发布元数据，运行时行为与 0.5.0 相同。** 0.5.0 已经发到 registry，同号不能再发，
所以命名空间更正随这个 patch 版本出。

### 修复

- **包名从 `@zzyyyds88/dsh-fleet` 改为 `@greatbaby/dsh-fleet`。** 原计划的 scope
  是照着 GitHub 用户名取的，但 npm 的 scope 只认**账号名或组织名**，而发布账号叫
  `greatbaby`：`npm access list packages '@zzyyyds88'` 返回 `404 Scope not found`，
  发布时报 403。`@greatbaby` 是账号自己的 scope，注册即得，不必另建组织。
  GitHub 仓库地址（`github.com/zzyyyds88/dsh-fleet`）不受影响，那是另一件事。

### 说明

- 0.5.0 在 registry 上是一个**未被引用的历史版本**（发布时名字还叫 `@zzyyyds88/...`，
  而那个 scope 不属于本账号，所以它从未真正可安装）。以 0.5.1 为准。
- registry 上还有一个 `0.0.0-stage` 占位版本，是 npm 暂存发布流程自动建的，不是本项目发的。

## [0.5.0] — 2026-11-18

**发布形态变更，已安装的用户要重装一次。** 包名从 `@local/dsh-fleet` 改为
`@greatbaby/dsh-fleet`：`local` 这个 npm 作用域属于他人的组织，`dsh-fleet` 这个包名
已被人占用。旧名已无法安装，也不会有更新。替换命令见下。

### 变更

- **包名改为 `@greatbaby/dsh-fleet`**，并发布到 npm。安装不再需要先 clone 仓库：
  `dsh plugin --profile <p> add -w @greatbaby/dsh-fleet`。
  从旧名迁移：先 `dsh plugin --profile <p> remove @local/dsh-fleet`，再用新名安装，
  最后把 profile 的 `dsh.profile.bundles` 里的旧名换成新名。
- 客户端插件 id 与包名同步（DSH 要求二者相等），因此浏览器半会重新注册一次。
- 本包不再是 `private`，补齐 `repository` / `license` / `keywords` 等 npm 元数据。

### 移除

- 被跟踪却早已过期的 `packages/dsh-fleet/package-lock.json`（写的是 0.1.0）。
  profile 的依赖一直由 pnpm 管理，这份 lock 从未参与任何安装。

### 文档

- 新增 `LICENSE`（MIT）。
- 新增 `docs/adr-0005-release-and-maintenance.zh.md`：包名依据、发布形态、三条升级链。
- `UPGRADE.zh.md` 补中转插件与 DSH Go 两条升级链 —— 此前只覆盖 DSH 本身，
  而这两条是无声失效的来源。
- 根 `README.md` 修掉五处与代码不符的表述，安装章节改为 npm 优先。

## [0.4.0] — 2026-11-18

### 新增

- **节点控制模式**：agent preset `node-control` + `fleetControl` 服务 + 只注册一个工具的
  `./node-control` 入口。该预设的工具集就是它的 `config.plugins`，因此「除节点管理外一律拒绝」
  是组合属性，不是运行时判断。密钥只收引用、拒绝内联，因为工具参数会写进会话日志。
- **`/@fleet/<nodeId>/…` 路径命名空间**：手机用同一套「本机绝对路径」语法就能浏览与选择
  节点目录。中转在 dispatch 前会 `mkdir -p`，这个前缀把它的落点限制在 `<盘>:\@fleet\` 之下，
  fleet 在工作区建好后自底向上 `rmdir` 空目录链 —— 精确清理，不是启发式。
- **目录选择器由 fleet 整体替换**（不是装饰）：桌面上 `directory-picker-auto` 解析成 native
  后端，原生 `list` 会 `requireCapability("browse")` 抛错，中转随即改用自己那份实现，
  继承式的装饰永远调不到。
- **A 类端点补路由**：`goals`、`userQuestions`、`subagents`、`commands`、`messageFeedback`、
  `sessionReferenceResolver`、`fileReferences`、`schedule`。这批的共同形态是「不路由不报错，
  只是回答这台 Host 的」—— 目标条消失、斜杠命令列本机的、`@` 补全给 Windows 路径。
- **插件下发默认全开**，另加 `NODE_NEVER_SYNC` 硬排除清单（本插件、brain bundle、中转插件）。
  理由：装了插件又连了节点的人要的是一套工作环境，不是一个悄悄不同的第二套；
  而「哪些绝不能被送到节点」必须逐条列举，不能靠命名空间推断。

### 变更

- `dsh.bundle.patch` 从字符串改为有序数组，新增 `presets/node-control.patch.yml` 一层。
- 补 `engines.dsh`（`>=0.2.2-rc.3 <0.3.0`）：不满足范围的 DSH 直接拒装，而不是半组合。
- `files` 补上 `presets/*.patch.yml`，并补上此前一直缺失的 `docs/DETAIL*.md` 与 `preview.svg`
  （`meta.detail` 指向不存在的文件时，详情页会显示失败而不是回退到 README）。

### 修复

- 已跟踪文档里的真实内网地址与公网域名换成占位符（本仓库是公开的），`install-unit` 现在会拦。

## [0.3.0] — 2026-11-16

### 新增

- 节点侧组合 `@local/dsh-fleet-brain`：从官方 `dsh-web-app` 派生，减去浏览器面，
  节点 profile 只组合 `dsh-base` + brain，浏览器面**根本不加载**（不是加载后禁用）。
  派生而非手写的理由：`web-app` 有 621 行且每个 release 都在变，手抄会腐烂。
- 插件同步单位从「节点组合里的行」改为「用户安装的 bundle」。

### 说明

首个正式插件版本。此前是原型阶段，没有对外安装形态，不列。
