# 参与这个项目

本仓库是 DSH 的远程工作区能力：`packages/dsh-fleet`（桌面端插件）与
`packages/dsh-fleet-brain`（节点侧组合）。**设计取舍的唯一真源是
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**，对外用法在 [`README.md`](README.md)，
升级流程在 [`packages/dsh-fleet/docs/UPGRADE.zh.md`](packages/dsh-fleet/docs/UPGRADE.zh.md)。
动手之前先读这三份，尤其是 `AGENTS.md` 里的硬约束。

## 一、跑起来

不需要构建步骤：源码就是运行物（Node ESM，无打包器、无 TS 编译）。

```bash
# 唯一一个运行时依赖（只有 src/ssh/connection.js 会 import 它）
cd packages/dsh-fleet && npm install --ignore-scripts

# 纯逻辑测试，不需要 DSH，也不需要节点
node test/run-all.mjs --layer offline
```

需要节点的那两层要先给地址与凭据（**源码里没有默认 IP 和默认密码**，这是公开仓库）：

```bash
export DSH_FLEET_TEST_HOST=192.0.2.10      # RFC 5737 文档地址，换成你自己的
export DSH_FLEET_TEST_USER=root
export DSH_FLEET_TEST_PASSWORD=...          # 或 DSH_FLEET_TEST_KEY_FILE=<path>
node test/run-all.mjs --layer e2e
```

读上游契约的两层必须用 DSH 自带的 Node，不是系统 Node：

```bash
ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" test/dispatch-seam.mjs
```

## 二、自己构建节点运行时

节点上的 DSH 是一份**独立安装**，版本必须与桌面端**完全相等**。正常路径是插件自己搞定：
先下 Release 制品，拿不到就让节点 `npm install` 同版本（见
[`docs/adr-0006`](docs/adr-0006-node-runtime-supply.zh.md)）。你想自己控制这一步也可以。

**在节点上直接装**（这就是兜底路线的配方）：

```bash
mkdir -p ~/.dsh-fleet/runtime && cd ~/.dsh-fleet/runtime
npm install --no-audit --no-fund --engine-strict=false \
  --os=linux --cpu=x64 --libc=glibc \
  '@deepseek-ai/dsh@<与桌面端完全一致的版本>'
node node_modules/@deepseek-ai/dsh/lib/bin.js --version
```

三个参数都不是可选的：

- `--os/--cpu/--libc` 决定 npm 解析哪一套原生包（`@img/sharp-linux-x64`、
  `sherpa-onnx-linux-x64`、`@koromix/koffi-linux-x64`）。省略就按**运行 npm 的那台机器**解析。
- `--engine-strict=false`：上游 0.2.2 全四个 rc 都声明 `engines.node: ">=24.9.0"`，而本项目的
  节点下限是 Node 22；低于它仍然装得上、跑得起来，只是应当知道。
- 装完要写版本戳 `~/.dsh-fleet/runtime/.fleet-artefact.json`，内容
  `{"build":3,"via":"npm"}`。**少了它，插件每次连接都会重装一次**
  （`inspectRuntime` 把无戳的树读成「早于构建戳」）。

**打一个分平台的制品**（发到 Release，任何节点都能下载）：

```bash
node packages/dsh-fleet/scripts/publish-runtime.mjs \
  --version 0.2.2-rc.5 --platform linux-x64 --out dist
```

`--platform` 认 `linux-x64`、`linux-arm64`、`linux-musl-arm64`、`darwin-arm64`、`win32-x64`。
加 `--publish` 才会上传（需要 `gh` 已登录）。CI 用
[`.github/workflows/release-runtime.yml`](.github/workflows/release-runtime.yml) 做同一件事，
四个平台各自在本平台 runner 上打包。

打包脚本有三个不显眼但必要的行为，改它之前先读代码里的注释：
`--ignore-scripts`（否则打包机的原生构建产物会被塞进别的平台的归档）、
`STRIPPED`（删错了会 `MODULE_NOT_FOUND`，`docs/` 形状的目录里也可能是代码）、
以及 `RUNTIME_BUILD`（改了打包规则必须 bump）。

## 三、改代码时的几条线

- **不 import 任何 `@deepseek-ai/*`，也不从 `app.asar` 里 import。** 唯一运行时依赖是 `ssh2`。
  破坏这条等于把插件绑死在某个版本的内部结构上。
- **生成物只读不手改**：`packages/dsh-fleet-brain/cordis.patch.yml` 与 `presets/*.yml` 由
  `scripts/sync-from-upstream.mjs` 生成，`src/host/brain-bundle.generated.js` 由
  `scripts/embed-into-fleet.mjs` 生成。改源再重新生成。
- **节点组合必须从已安装的那个 release 派生**，不能从 master 派生。
- **设计先行**：改动跨越模块、改了公共契约 / schema / 状态机、或新增子系统时，先改
  `docs/ARCHITECTURE.md` 并单独提交 `docs:`，再分派实现。
- **提交粒度**：一次一件事，前缀 `feat` / `fix` / `docs` / `refactor` / `test` / `chore` /
  `breakdown`。禁止 `git add .`，只 stage 本任务的文件。
- **公开仓库**：不许提交密钥、令牌、私钥、真实用户数据。测试只从 `DSH_FLEET_TEST_*` 读节点
  地址与凭据。`.scratch/` 与 `reference/` 不进版本管理。

## 四、提一个改动之前

1. `node test/run-all.mjs --layer offline` 全绿；
2. 改了路由、描述符或 inject 的，再跑 `--layer contract`（要用 DSH 自带的 Node）；
3. 改了连接流程的，用真节点跑一次 `--layer e2e --only node-control,session`；
4. 说清楚改了什么、为什么、怎么验的。**退出码 0 不等于功能生效**：纯逻辑、契约缝隙、
   端到端各只证明自己那一层。

发现设计缺陷时停下来提案：给问题与证据、影响范围、与现有设计的冲突、可选方案、推荐方案、
待确认问题。不要边写代码边暗改设计。
