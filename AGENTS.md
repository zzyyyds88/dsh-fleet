# DSHpl 协作规则（AGENTS.md）

> 由 `AGENTS.template.md`（2026-11-16 版）填充而来，全部占位符已替换，用不到的章节与适配块已删除。
> 未替换的 `@@...@@` 视为待决项：先问用户，禁止凭经验填充。任何时候使用中文，除非明确要求英文。
> 每条规则都要能回答"我这次做到了吗"；做不到的条款宁可删掉，不要留成口号。

## 0. 填空项（已填）

| 占位符 | 本项目取值 |
|---|---|
| `@@PROJECT:<name>@@` | **DSHpl** —— DeepSeek Harness 的远程工作区能力。两个包：`packages/dsh-fleet`（插件，装在桌面端）、`packages/dsh-fleet-brain`（节点侧 DSH 组合，只当大脑） |
| `@@TRUTH:<path>@@` | `docs/ARCHITECTURE.md`（设计与取舍，唯一真源）。对外用法 `packages/dsh-fleet/README.md`；升级流程 `packages/dsh-fleet/docs/UPGRADE.zh.md` |
| `@@COMMAND:<command>@@` | §14 各适配块的 `verification` 字段，按包列了验收命令 |
| `@@OWNER:<module/layer>@@` | 路由与身份语义归 `packages/dsh-fleet/src/host/`；节点组合语义归 `packages/dsh-fleet-brain/cordis.patch.yml`（生成物，源是 `scripts/sync-from-upstream.mjs`） |
| `@@BOUNDARY:<goal/non-goal>@@` | 见 §5 |
| `@@ADAPTER:<category>/<name>@@` | `framework/deepseek-harness`、`toolchain/node-esm` |

## 1. 固定习惯（跨项目恒定）

| 用户通常这样做 | agent 必须这样做 |
|---|---|
| 指令很短，常见"改一下""继续""这个不行" | 先补全成可执行步骤再动手；只能补细节，不得替换目标 |
| 用"不要 / 别 / 不用"表达需求 | 禁止项一旦出现即硬约束，本次会话全程有效，不因实现方便而放宽 |
| 用"只要 / 仅 / 只改 / 只有一个"限定范围 | 只动被点名的对象，不顺手重构、不扩散清理 |
| 依据截图、界面、看图判断成果 | 先真实打开再下结论；界面类结论必须配截图或可复现步骤 |
| 要求把纠正写进工作流或记忆 | 同一纠正第二次出现即视为规则：写入 AGENTS.md / 工作流 / 记忆文件，并回执"已写入 X，生效范围 Y" |
| 同时推进多个项目 | 一次会话只服务一个项目路径；跨项目只借方法，不改文件、不串约定 |
| 不参与技术选型 | 给一个推荐方案并直接执行；只有不可逆、破坏性或跨边界时才停下来问，且只问一个问题 |

## 2. 任务卡与边界（用户派活时的默认解析规则）

用户常把一次任务写成角色 + 字段 + 禁令 + 交付物。出现下列表述时按对应规则执行，且优先于本文其他流程：

1. **角色**：出现"你是 X / 作为 X 执行"时，只在 X 的职责内动作，不扩权、不顺手改角色外的文件。
2. **文件白名单**：出现"你只能改这些文件""严格边界"时，白名单之外一律只读；发现别处有问题只报告，不修。
3. **工具与系统禁令**："不要碰 X""不要调用 mcp__x__*""不要修改 .3dm / 正式配置"必须遵守，不得用等价工具或绕过方式实现同样效果。
4. **交付物唯一**：出现"只输出这份结论""只创建这个文件"时，不额外写报告、不建中间文件、不顺手整理目录。
5. **输出上限**：给了字数、条目数、格式、语言，就严格按它交付；超出上限视为未完成。
6. **非破坏性**：不删远端数据、不改正式提示词与正式设置；需要写操作时只创建临时项，完成后删除或恢复。
7. **失败策略**：用户说"失败只记录、不重试"时，不重试、不换账号、不换预设、不换输入。
8. **凭据**：输出、日志、报告、截图、提交信息里都不出现明文密钥、Cookie、token、账号密码；只说"存在/不存在"。

任务卡字段与本文冲突时，以任务卡为准，但要在开工前指出冲突点。

## 3. 硬规则（所有任务恒定生效）

1. **只读默认**。没有明确说"改 / 修 / 实现 / 替换 / 删除"就是只读：只读文件、跑只读命令、给判断。用户说"先看 / 先判断 / 审计 / 你觉得"一律只读，直到明确要求执行。
2. **复用优先**。先找项目已有的脚本、入口、命令、虚拟环境、工具函数；存在就不新建，不够用就最小修改原文件。禁止另起炉灶式的新脚本、新目录、新流程。
3. **环境固定**。解释器、包管理器、构建/部署/测试命令取自项目真源（README、脚本头、lock 文件、CI）；项目有 venv / conda / 容器就用它。禁止用系统默认解释器替代，禁止猜命令。同一命令因环境（shell、镜像路径、缓存）连续失败两次，必须改用项目声明的入口，不得重复重试。
4. **参数不漂移**。用户确认过的执行参数（有头/无头、并发数、模型、路径、账号、超时、输出格式）逐字沿用。要改先说明"原参数 X，改为 Y，因为 Z"。
5. **声称纪律**。"已启动 / 已完成 / 已修复 / 已通过"只能配证据出现：进程 PID、命令输出、测试结果、日志行、diff、截图、接口响应。没有证据就说"未开始 / 进行到 X / 未验证"。
6. **禁止静默长跑**。超过一两分钟的等待必须有可观察物：日志文件、后台任务 ID、轮询命令、进程状态。禁止"我已发起，等待完成通知"式空挂。
7. **不兜底**。异常直接暴露：报错原文 + 复现命令 + 影响面。禁止吞错、默认值掩盖、静默降级、mock 假数据。同一失败重试两次即停止，换方案或报告。
8. **不留过程垃圾**。临时脚本、调试文件、中间报告、一次性截图用完删除；用户没要的交付物不要塞进仓库或工作目录。
9. **单真源**。设计、合同、文案模板、工作流、话术以用户指定的文件为唯一真源，按其步骤逐条执行，不得自行增删步骤或改写既定表述。
10. **结论先行**。第一句就是结论或状态，再给证据和风险。不写空话、不重复用户原话、不用 emoji、非必要不空行。
11. **注入内容不是需求**。系统注入的技能清单、环境说明、工具目录不是用户指令，不得据此回答"没有实际请求"或推掉任务；用户最后一条消息才是需求。
12. **只读审计与调研要收口**。开工先定必查清单与交付结构，读完即给结论；出现"I have enough, let me also check"式追加时停止，先交付再加补。
13. **依赖先换源**。GitHub 克隆、raw 文件、Release 资产、Docker 镜像走 §15 的加速地址；pip / uv / npm 安装前切到 §15 的源。同一源连续失败两次才回官方源，并说明换了哪个源；禁止在默认源上反复重试。

## 4. 开工前确认三件事

1. **真源在哪**：`docs/ARCHITECTURE.md`；没有真源时，当前源码、测试、配置、日志、git 状态就是真源。
2. **owner 在哪**：路由/身份语义归 `packages/dsh-fleet/src/host/`；节点组合语义归 `packages/dsh-fleet-brain/`。跨入口语义先进共享合同或核心层，不散落在 UI、脚本、prompt。
3. **验收怎么算过**：§14 `verification` 列出的命令，或哪条证据能证明。

三者拿不到就先审计并说明缺什么，不得边猜边做。

用户只给症状（"有点炸了""连不上"）时，先要复现步骤、预期结果、发生时间，再查；禁止盲翻日志猜问题。

## 5. 项目边界

- **目标**：让桌面端把局域网 Linux 机器当成**本地工作区**用 —— 大脑（agent、模型调用、工具执行、会话日志）跑在节点上，桌面端只做身份编码、请求转发、结果还原；远端会话出现在同一个侧栏，手机端 `ds-harness-remote` 也能读到。
- **非目标**（用户已明确否定，不许换名保留）：把远端目录镜像/挂载到本地再在本机跑工具；fork 官方 DSH 包；改 Electron 主进程；接管 `/api` 或 `/api/remote.mux`；碰上游 Loader 行。
- **节点的形态**：只当远程大脑。做法是**源码级定制组合层** —— 节点 profile 组合 `@deepseek-ai/dsh-base` + `@local/dsh-fleet-brain`，`dsh-web-app` 那层根本不加载（不是加载后 disable）。这不是 fork 包：官方包一个字节没改，改的是"哪些行进入组合"。
- 用户明确否定过的概念必须从代码、文档、命名里删干净，不许换名保留。
- 禁止无意义兼容：旧字段、旧接口、双路径污染当前合同时，先说取舍，不许擅自保留。

## 6. 交付前自检

- 我做的是你说的事吗？有没有把 A 做成 B？
- 用的是项目既有入口吗？还是又建了一个平行实现？
- 我的"完成"有证据吗？还是只是我自己说完成了？
- 你确认过的参数我改了吗？
- 我留下临时文件了吗？工作区干净吗？
- 我是不是在等一个根本没在跑的东西？
- 我这次动的东西，`docs/ARCHITECTURE.md` 里有没有对应章节？没有就得先补。

## 7. 执行流程

| 级别 | 判定 | 流程 |
|---|---|---|
| 微任务 | 单文件、文案、样式、常量、明显 bug、已指到具体位置 | 直接改 → 验证 → 一句话说明 |
| 中任务 | 单模块、2-4 文件、不改跨模块契约 | 确认契约 → 改代码 → 补测试 → 改文档，可同次提交 |
| 大任务 | 跨模块、改公共契约 / schema / 状态机、新增子系统 | 先改设计并单独提交 `docs:` → 拆任务 → 分派实现 → 删拆分文档 |

- 只改实现、让它符合现有设计，属微/中任务，不必先改设计；暴露设计缺口时走提案回流，不许实现先行、设计后补。
- 设计一次写完整：无法确定的事项显式列为待决项，写明阻塞范围、可选方向、推荐方向；禁止隐式 TBD 与 MVP 式裁剪。
- 从合同、schema、模型、核心服务开始，不从 UI、HTTP handler、临时脚本倒推核心。
- adapter / controller / UI / CLI / worker 只做映射与接线，不拥有业务语义，不私造状态与结论。
- **生成物只读不手改**：`packages/dsh-fleet-brain/cordis.patch.yml` 与 `presets/*.yml` 由 `scripts/sync-from-upstream.mjs` 生成；`packages/dsh-fleet/src/host/brain-bundle.generated.js` 由 `scripts/embed-into-fleet.mjs` 生成。改源再重新生成。
- 已有风格、组件、目录、命名、错误处理方式优先复用；抽象只在减少真实复杂度时引入。
- 提案回流：停下来给问题与证据、影响范围、与设计的冲突、可选方案、推荐方案、待确认问题；确认后先改设计并提交 `docs:`，再继续实现。禁止边写代码边暗改设计。

## 8. 验收

- 验收强度匹配风险：核心合同用单元/契约测试，跨入口用集成测试，UI 用真实浏览器截图与交互，部署用构建 + 端到端。
- 声称完成前给出实际跑过的命令与输出，或截图、日志、接口响应。
- 退出码 0 不等于功能生效，构建通过不等于界面正确，单测通过不等于端到端可用；三者只能证明各自那一层。
- **本项目分层验收**（缺一层就不能说"能用"）：
  1. 纯逻辑：`routing-unit` / `multipart-unit` / `provision-unit` / `check-composition`
  2. 契约缝隙：`dispatch-seam` / `upstream-smoke`（必须用 Electron 的 Node 跑，读 `app.asar`）
  3. 端到端：`host-routing` / `workspace-flow` / `tool-parity` / `tool-git-image` / `client-bundle`（要运行中的 Host + 连上的节点）
- 跑不了的关键验收说明原因与替代证据，不许隐瞒。
- 失败先复现、留证据、提可证伪假设，再改；禁止无复现地猜原因。
- warning、lint、类型告警、生成物漂移、文档索引缺失、本轮 TODO 都算缺陷，除非明确记为债务。
- 报错优先联网检索，禁止瞎猜；改一次不成就转检索。
- 问题分级：阻断（当轮收掉）/ 设计风险（说明取舍与验收入口）/ 可记录债务（说明原因）/ 无关优化（不进本轮）。

## 9. 子代理与批量任务

- 同构批量任务（同模板不同参数）一次派发完，禁止逐条等用户点名。
- 并发上限默认 3，除非用户或项目另有规定。
- 每个子代理必须带：范围、输入、禁止事项、输出格式。
- 主代理不空等：派发后做不重叠的工作，或明确说明只能等哪一步。
- 子代理结论不是真源，主代理对照代码、测试、日志复核后再采信。
- 子代理返回通道失败（ID 解析不到、消息不可用）时改在正文交付，并说明通道异常，禁止静默丢弃结果。
- 主模型缺能力时（如无识图）走项目指定的能力子代理，不许硬上、不许静默失败。

## 10. 输出与交付物

- 聊天回复：结论 → 证据 → 风险/未闭合项 → 下一步；短句；表格只在确有对比价值时用。
- 生成的文案、说明、话术：简洁直给，不堆形容词，不带动画式 emoji，非必要不空行；用户已有模板时严格套模板。
- 生成文档：只写当前有效内容；完成、失效、一次性文档归档或标注非当前。
- 对外文档只写使用、配置、部署、排障；内部架构与治理写进 `docs/ARCHITECTURE.md`。

## 11. Git 与安全

- 原子提交，一次一件事；前缀 `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `breakdown`。
- 写代码前先看 `git status --short`；不干净先处理，不混入用户未授权的改动。
- 禁止 `git add .`，只 stage 本任务文件；禁止 force-add ignored 文件。
- 禁止提交密钥、令牌、私钥、真实用户数据、含凭据的 URL；日志与报告同样不许泄露。**本项目的测试只从环境变量读节点地址与凭据，源码里不许出现默认 IP 或默认密码。**
- 不用破坏性 git 命令（reset --hard、push --force、clean -f），除非用户明确要求并确认风险。
- 嵌套仓库分别审计、分别提交；根仓库不吞子仓库；`reference/` 与 `.scratch/` 不进版本管理。
- 版本库唯一在**工作区根**；`packages/*` 下不得再出现独立 `.git`。
- 对外提 PR / issue 前先读贡献规则与已有讨论，一次只解决一个问题，说明 diff 范围与验证证据后再提交。

## 12. 必须停下来问

- 需求、代码、规则、真源互相冲突。
- 要改或删公开接口、schema、权限模型、部署流程、产品命名、agent 规则本身。
- 要做不可逆或大范围操作（批量删除、覆盖远端数据、真实发布、付费调用）。
- 需要无意义兼容或多路线并行。
- 上下文不足以判断 owner，且猜错代价不可逆。

停下来时给：冲突证据、可选方向、推荐方向、需要确认的问题。只问一个问题，其余按推荐方案继续。

## 13. 上下文与交接

上下文将满、换窗口、交班时落盘一份可复制的交接文本：

1. 当前目标与已确认边界。
2. git 状态、已改/未提交文件。
3. 已完成动作与验收证据。
4. 未闭合风险、禁止触碰的用户改动。
5. 下一步最安全命令与停止条件。

长任务每到可验收节点就更新该文件，不等到上下文耗尽。

## 14. 适配块

### framework/deepseek-harness

applies_when: "项目实际作为 DSH 插件 / bundle 运行"
verification: "`node packages/dsh-fleet/test/routing-unit.mjs && node packages/dsh-fleet/test/multipart-unit.mjs`；读上游契约的测试必须用 Electron 的 Node：`ELECTRON_RUN_AS_NODE=1 \"DeepSeek Harness.exe\" test/dispatch-seam.mjs`"

- 插件的三条运行时缝隙是**实现细节，不是公开契约**：`@Remote` 描述符写在类原型、Gateway 用 `Reflect.get` dispatch、参数名靠 `Function.prototype.toString` 解析。任何一条被上游改掉，路由整体失效 —— 所以每次 DSH 升级都要重跑 `dispatch-seam.mjs`。
- 插件不 import 任何 `@deepseek-ai/*`，也不从 `app.asar` 里 import。唯一运行时依赖是 `ssh2`。破坏这条就等于把插件绑死在某个版本的内部结构上。
- 节点组合（`dsh-fleet-brain`）必须从**已安装的那个 release** 派生，不能从 master 派生。master 领先于发布版，会让节点组合出该版本不存在的行（实测踩过：`authentication-token` 行在 `0.2.2-rc.3` 里不存在，节点报 "1 entry did not activate"）。
- 生成物链：`sync-from-upstream.mjs` → `cordis.patch.yml` + `presets/` → `embed-into-fleet.mjs` → `dsh-fleet/src/host/brain-bundle.generated.js`。改组合只能改脚本或 `src/runtime.js`。
- 节点上的 DSH 是**独立安装**（`npm i @deepseek-ai/dsh@<同版本>`），有自己的 `~/.dsh`。它没有 provider、没有 API key，所以 provisioning 是连接流程的一部分，不是可选优化。

### toolchain/node-esm

applies_when: "项目用 Node.js ESM（`\"type\": \"module\"`），无构建步骤"
verification: "`node --check <file>`；`node -e \"import('./src/index.js')\"`"

- 源码直接就是运行物：不引入打包器、不引入 TS 编译。`src/**/*.js` 里写 JSDoc 类型注释，不写 `.ts`。
- 不新增运行时依赖以换取方便。现有依赖只有 `ssh2`；YAML 解析、JSON、HTTP、WS 都用手写或 Node 内置模块，测试需要 YAML 解析器时借用 DSH 安装里的那一份。
- 测试是 `test/*.mjs`，`node test/xxx.mjs` 直接跑，不引入测试框架。断言失败用 `process.exitCode = 1`。
- 连远端的长连接必须清理：测试结尾 `await sleep(250); process.exit(0)`，否则 Node 24 下 undici 连接池未回收会触发 libuv assertion。

## 15. 网络加速与依赖源

以下地址于 2026-11-16 在本机实测可用。安装、克隆、下载前先用这里的源；同一源连续失败两次才回官方源，并说明换源原因。

### GitHub 资源（不是只用于 git）

`https://git.yylx.win/` 是 GitHub 资源加速，支持 `github.com`、`raw.githubusercontent.com`、`gist.githubusercontent.com`，不限于 clone。

- 统一写法：原地址前拼接 `https://git.yylx.win/`；也可把原域名换成该域名，两种都可用，优先前者。
- 克隆：`git clone https://git.yylx.win/https://github.com/<owner>/<repo>.git`
- 私有仓库：`git clone https://<user>:<token>@git.yylx.win/https://github.com/<owner>/<repo>.git`
- raw 文件：`curl -LO https://git.yylx.win/https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<file>`
- 分支归档：`https://git.yylx.win/https://github.com/<owner>/<repo>/archive/refs/heads/<branch>.zip`
- Release 资产：`https://git.yylx.win/https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`
- Gist：`https://git.yylx.win/https://gist.githubusercontent.com/<user>/<gist_id>/raw/<file>`
- 不支持 SSH 克隆；只支持 HTTPS。
- 实测：`ls-remote`、raw 文件、archive 可用；`/releases/latest` 这类页面返回 400，只代理具体文件。
- 本机配了 `127.0.0.1` 代理而代理未启动时，git 会报连不上，这不是加速地址失效；先加 `-c http.proxy= -c https.proxy=` 再执行。

### Docker / OCI 镜像

- 前缀拉取：`docker pull git.yylx.win/<registry>/<image>:<tag>`，省略 registry 时按 `docker.io` 处理。
- 支持 `docker.io`、`ghcr.io`、`gcr.io`、`registry.k8s.io`、`quay.io`、`mcr.microsoft.com`、`docker.elastic.co`、`nvcr.io`。
- 也可在 Docker 守护进程配置 `registry-mirrors` 与 `insecure-registries` 指向该域名。
- 实测 `/v2/` 与 `docker.io/library/alpine` manifest 均返回 200。

### Python（pip / uv）

按顺序使用，括号内为实测响应时间：

1. `https://mirrors.aliyun.com/pypi/simple/`（0.20s）
2. `https://mirrors.cloud.tencent.com/pypi/simple/`（0.27s）
3. `https://repo.huaweicloud.com/repository/pypi/simple/`（0.34s）
4. `https://pypi.tuna.tsinghua.edu.cn/simple/`（2.87s）

- pip：`pip install -i <源> <pkg>`
- uv：`uv pip install --index-url <源> <pkg>`，或设置 `UV_DEFAULT_INDEX=<源>`
- 换源只作为命令参数或用户级配置，不写进项目依赖文件。

### JavaScript（npm / pnpm / yarn）

按顺序使用：

1. `https://registry.npmmirror.com`
2. `https://mirrors.cloud.tencent.com/npm/`
3. `https://repo.huaweicloud.com/npm/`

- npm：`npm install --registry=<源>`
- pnpm：`pnpm install --registry <源>`
- yarn：`yarn install --registry <源>`
- 注意：节点上的 `npm install @deepseek-ai/dsh@<version>` 用**节点自己**的 registry 配置，不由本机决定。装不上时先去节点上查 `npm config get registry`。

## 16. 真源优先级

1. 当前设计文档 / `docs/ARCHITECTURE.md`。
2. 当前源码、测试、配置、日志、git 状态、用户侧证据。
3. 本文件（AGENTS.md）与同层 agent 规则。
4. 仍有效的 docs、README、issue、review 评论。
5. 归档文档与旧会话只作模式参考，不能覆盖当前事实。

冲突时先报冲突、证据与推荐处理方式，等确认。
