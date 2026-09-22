# 第三方项目与许可

ChanceKit 自有代码采用 [PolyForm Noncommercial 1.0.0](LICENSE)。该许可仅覆盖本仓库中由 ChanceKit 维护者和贡献者提供、且没有其他许可标记的代码与文档。依赖、内置组件、QQ 客户端及其资源继续适用各自许可证或服务条款，不会被重新授权为 ChanceKit 的许可证。

| 项目 | 用途 | 许可证 / 来源 |
| --- | --- | --- |
| NapCatQQ v4.18.28 | 安装包内置的 QQ 连接与 OneBot/WebUI 组件 | [受限再分发许可](licenses/NapCatQQ-v4.18.28-LICENSE.txt) · [上游](https://github.com/NapNeko/NapCatQQ) |
| Electron | 桌面运行环境 | MIT |
| React、Vite、pi Agent Core / pi AI | 界面、构建和模型适配 | 各包随附的 MIT 许可证 |
| Playwright | 自动化测试 | Apache-2.0 |
| PDF.js、sharp 及其他 npm 依赖 | 文档和图像处理 | 各包随附许可证 |
| QQ 客户端 | 用户自行安装的第三方客户端 | 腾讯及 QQ 适用的服务条款 |

直接和间接 npm 依赖的准确版本及声明以 `package-lock.json` 和安装包内各依赖随附文件为准。

## NapCatQQ 授权状态

ChanceKit 固定使用未经修改的 NapCatQQ 4.18.28 Shell 官方发布包，并在维护者构建安装包前从上游地址下载、校验大小和 SHA-256。最终安装包会携带该 ZIP、版本清单、来源说明及 NapCatQQ 原始许可证。

NapCatQQ 的许可证规定未经主作者明确许可不得使用、复制、修改或分发，并禁止商业用途；其再分发条款要求附带完整许可证、清楚标明来源和版权。仓库和安装包附带许可证原文仅用于告知和履行通知义务，不表示 NapCatQQ 已被重新授权，也不构成额外授权。

项目维护者正在向 NapCatQQ 主作者确认 ChanceKit 内置和再分发方式的书面授权。在获得并记录明确答复前，GitHub 公开发布流程不得生成新的公开 Release，也不应通过其他渠道发布包含 NapCatQQ 的安装包。

## 分发边界

源码仓库不提交 NapCatQQ ZIP、用户 QQ 安装副本、登录资料、令牌或运行缓存。维护者制作安装包时，必须使用 `resources/napcat/manifest.json` 指定且校验通过的官方组件，不得使用个人运行目录制作分发组件。

取得额外书面授权后，发布者仍应保留授权要求的许可证、版权、来源和声明。任何超出授权范围的修改、版本升级、镜像托管、收费或其他再分发行为，都需要重新确认相应权限。
