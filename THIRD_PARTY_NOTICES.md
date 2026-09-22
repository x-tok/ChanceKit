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

## NapCatQQ 再分发条件

ChanceKit 固定使用未经修改的 NapCatQQ 4.18.28 Shell 官方发布包，并在维护者构建安装包前从上游地址下载、校验大小和 SHA-256。最终安装包会携带该 ZIP、版本清单、来源说明及 NapCatQQ 原始许可证。

NapCatQQ 的受限许可证允许在附带完整许可证、清楚标明来源和版权的条件下再分发，并禁止商业用途。ChanceKit 按这些条件携带未经修改的官方发布包；NapCatQQ 不会被重新授权为 ChanceKit 的许可证。

## 分发边界

源码仓库不提交 NapCatQQ ZIP、用户 QQ 安装副本、登录资料、令牌或运行缓存。维护者制作安装包时，必须使用 `resources/napcat/manifest.json` 指定且校验通过的官方组件，不得使用个人运行目录制作分发组件。

发布者必须保留许可证、版权、来源和声明。任何超出许可证范围的修改、版本升级、收费或其他商业用途，都需要另行取得相应权限。
