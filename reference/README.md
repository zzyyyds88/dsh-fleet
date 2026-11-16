# `reference/` — 上游源码，只读参考，不进版本库

这里放的是**别人写的代码**，用来读契约、对协议、抄组合方式。它们各自是独立的
git 仓库，克隆在本地，**不提交到本仓库**（见根 `.gitignore`）。

| 目录 | 是什么 | 为什么要它 |
|---|---|---|
| `deepseek-harness/` | DeepSeek Harness 官方 monorepo（`deepseek-ai/deepseek-harness`） | 节点大脑就是它本体。插件要写节点侧的组合（bundle），必须读它的 `packages/bundle/*`、`packages/boot/app-boot`、`packages/api/*`；三条运行时缝隙（`@Remote` 描述符、Gateway 的 `Reflect.get` dispatch、参数名解析）也在这里有原文 |
| `zcode/` | ZCode（`zai-org/ZCode`） | 远控架构的参照物：它怎么让"远端有大脑"、怎么下发配置、怎么只装一个 server。本插件的第一版路线就是照它定的 |

## 重新拉取

本机的全局 git 代理已失效，直连 `github.com` 会失败。用加速站：

```bash
git -c http.proxy= -c https.proxy= clone --depth 1 \
  https://git.yylx.win/https://github.com/deepseek-ai/deepseek-harness.git \
  reference/deepseek-harness

git -c http.proxy= -c https.proxy= clone --depth 1 \
  https://git.yylx.win/https://github.com/zai-org/ZCode.git \
  reference/zcode
```

版本要**与本机桌面端一致**：本机 DSH 是 `0.2.2-rc.3`，`reference/deepseek-harness`
就钉在 `39163dd3`（release 0.2.2-rc.3 的 master）。读之前先 `git log -1` 确认，
否则读到的组合行 id 会和运行时对不上。
