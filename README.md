# DSHpl — DeepSeek Harness 的远程工作区能力

这个仓库是我为 **DeepSeek Harness (DSH)** 写的一套东西，核心是一个插件：
把局域网里的 Linux 机器变成桌面端**一等公民的工作区**，而不是"另开一个窗口连过去"。

```
packages/
  dsh-fleet/        插件本体（Host 侧 + 浏览器侧）
  dsh-fleet-brain/  节点侧 bundle：让节点只当远程大脑的 DSH 组合
docs/
  ARCHITECTURE.md   设计文档：为什么这么做、每个决定否决了什么
reference/          上游源码（只读参考，不进版本库，见其 README）
```

## 问题

DSH 的桌面端很好用，但它的工具**全跑在本机**。一旦你想用另一台 Linux 机器干活
（编译、跑服务、GPU、那个只有它装了工具链的机器），所有东西就开始崩：

- `bash` 里敲 `ls /root/project` → 拿到的是**本机**的 `/root/project`，或者直接没有
- 代码放在远端、桌面端打开一个远端目录 → 编辑器能读，但 agent 一改就写到本地
- 远端截图/PDF 想看一眼 → `read_image` 在本机找那个路径，找不到

社区里常见的解法是"把远端目录镜像/挂载到本地"。这个思路会在工具层炸掉，
具体五类故障写在 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 第九节。

## 做法（一句话）

**大脑放在远端。** 每台节点上跑一个真正的 DSH，agent、模型调用、工具执行、会话日志
全在节点上；桌面端只做三件事：**身份编码、请求转发、结果还原**。

于是工具层**零改动**：`grep`/`git`/`read_image`/`bash` 在节点上就是本地的，
因为它们本来就是本地的。同时远端的会话出现在**同一个侧栏**里，手机端的
`ds-harness-remote` 也能读到它们——因为对 Host 来说它们就是普通会话。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 完整设计：路线取舍、三处运行时缝隙、身份编码、故障分析 |
| [`packages/dsh-fleet/README.md`](packages/dsh-fleet/README.md) | 插件说明、安装、测试矩阵 |
| [`packages/dsh-fleet-brain/README.md`](packages/dsh-fleet-brain/README.md) | 节点侧组合：怎么从官方 web-app 减出"只当大脑"的一层 |
| [`packages/dsh-fleet/docs/DETAIL.zh.md`](packages/dsh-fleet/docs/DETAIL.zh.md) | 实现细节 |
| [`packages/dsh-fleet/docs/UPGRADE.zh.md`](packages/dsh-fleet/docs/UPGRADE.zh.md) | **DSH 升级后要重跑什么**，每条上游契约由哪个测试守着 |

## 许可

插件代码 MIT。`reference/` 下的上游源码各归其原作者。
