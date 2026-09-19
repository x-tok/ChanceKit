<img src="build/icon.png" alt="见机图标" width="72" height="72" />

# 见机 ChanceKit

**不让机会淹没在消息里。**

见机是一个面向就业信息整理的本地桌面应用。从关注的 QQ 群收集消息，保存到本机，方便查找招聘通知、宣讲会和双选会信息。

当前为 **0.1.1 开发版**，已实现 QQ 连接、群聊选择和消息归档。LLM 信息抽取、机会聚合与微信接入尚未实现。本仓库是独立项目，项目名和 npm 包名均为 `chancekit`。

## 当前功能

| 功能 | 当前行为 |
| --- | --- |
| QQ 检测 | 检测安装路径与版本，也可在 GUI 中选择官方 QQ；不自动安装 QQ |
| 内置组件 | 安装包携带固定版本 NapCat，首次连接本地校验、解压，无需访问 GitHub |
| 登录 | 手机 QQ 扫码确认；已有登录资料有效时尝试恢复登录 |
| 外接 NapCat | 支持 OneBot WebSocket，按需配置 WebUI 登录管理 |
| 群聊 | 获取群列表、搜索、关注和取消关注 |
| 历史消息 | 每次请求最近 100 条，支持手动继续获取更早记录 |
| 实时归档 | 保存已关注群的新消息；连接中断后重连，并补取最近一页 |
| 本地阅读 | SQLite 存储、消息去重、离线阅读、文字搜索 |
| 消息展示 | 文字、图片引用、链接卡片、附件信息、合并转发文字、原始响应 |
| 导出 | 将本地记录导出为 JSON Lines 文件 |

## 平台与安装

| 平台 | 验证状态 |
| --- | --- |
| macOS Apple Silicon | 已验证本机 QQ 接入和开发构建；正式签名、公证与干净机器安装验收待完成 |
| macOS Intel | 尚未进行实机验证 |
| Windows 10 / 11 x64 | 已实现启动集成与 NSIS 打包配置；真实 QQ 登录、退出和兼容性待验收 |
| Linux | 不支持本机 QQ 自动启动 |

请先自行安装[官方 QQ](https://im.qq.com/)。macOS 首次准备运行副本需要额外约 1 GB 空间，聊天记录和附件引用也会占用空间。

安装包发布后可从 [GitHub Releases](https://github.com/x-tok/ChanceKit/releases) 下载。Apple Silicon 选择 `mac-arm64.dmg`，Intel Mac 选择 `mac-x64.dmg`，Windows 10/11 选择 `win-x64.exe`；完整文件名带有版本号。普通用户通过 GUI 完成配置，不需要 Node.js、终端或手动编辑配置文件。

当前 macOS 安装包没有 Developer ID 正式签名和 Apple 公证。将见机拖入“应用程序”后尝试打开；如被系统阻止，可前往“系统设置 → 隐私与安全性”，找到见机的阻止提示并点击“仍要打开”。不同系统版本的按钮文字可能不同，详见[安装与发布说明](docs/releases.md)。

### 使用流程

1. 打开见机，在“连接 QQ”中选择“本机 QQ”。未检测到 QQ 时，安装后重新检测，或选择安装位置。
2. **macOS 先正常退出官方 QQ**，再点击“连接 QQ”。应用准备独立运行副本并启动内置 NapCat。
3. 如出现二维码，用手机 QQ 扫码确认。登录成功后点击“查看群聊”。
4. 选择需要关注的群并点击“关注”，开始接收新消息。已有历史通过“获取消息记录”读取。
5. 需要更早记录时点击“从 QQ 获取更早记录”；可搜索、离线查看或导出已归档内容。
6. 暂停采集时点击“停止连接”。头像和当前账号显示会清空，本地记录保留。macOS 可在停止完成后重新打开官方 QQ。

首次连接会读取群列表，不会自动下载所有群的全部历史。只有已关注群的新消息会实时归档。退出见机会停止本应用的采集进程。

停止本机连接或退出见机时，会先通过 NapCat 的 `bot_exit` 请求 QQ 正常退出并等待进程结束。macOS 在扫码服务尚未就绪时通过私有进程管道发送退出指令；只有进程持续不响应才使用系统终止作为兜底。不会清除登录资料或聊天库，外接 NapCat 只断开消息连接，不退出其 QQ。

### 已有 NapCat

在 GUI 选择“已有 NapCat”，填写 OneBot WebSocket 地址和访问令牌。需要在见机中扫码时，另行启用登录管理，填写 WebUI 地址和令牌。OneBot 与 WebUI 使用各自的认证配置。

本机地址可使用 `ws://127.0.0.1:<端口>`；非本机消息服务必须使用 WSS，登录管理必须使用 HTTPS。不要把访问令牌放到 URL 中，也不要公开 NapCat 管理端口。

## 数据、隐私与 QQ

### 数据保存位置

| 环境 | 数据根目录 |
| --- | --- |
| macOS 安装版 | `~/Library/Application Support/ChanceKit/` |
| Windows 安装版 | `%APPDATA%/ChanceKit/` |
| 源码开发 | 仓库内的 `.dev-data/` |
| 自动测试 | 测试创建的独立临时目录 |

数据根目录中包含：

```text
messages.sqlite          消息、群列表与关注状态
messages.sqlite-wal      SQLite 写入日志，运行时可能存在
messages.sqlite-shm      SQLite 共享内存文件，运行时可能存在
connection.enc           系统凭据加密支持可用时保存的外接连接配置
exports/                 消息导出临时文件
runtime/
  napcat-4.18.28/         解压后的组件及其 config/ 配置
  QQRuntime.app/         macOS 的 QQ 运行副本
  qq-profile/            macOS 采集进程的独立 QQ 登录资料与原生数据
```

消息正文与原始响应保存在本机，业务 SQLite 库目前**没有整库加密**。外接连接配置使用 Electron `safeStorage`；NapCat 自身运行所需令牌保存在私有运行目录的配置文件中。因此整个数据目录都应当视为私人资料，不能作为反馈附件或提交到 Git。

应用没有接入 LLM，也没有实现云端消息上传。联网连接 QQ/NapCat、加载 QQ 头像和远程图片、打开外部链接时，仍会访问相应服务。图片与附件目前保存的是上游引用，链接可能失效。

### 与官方 QQ 的关系

macOS 会复制官方 QQ 应用到见机的数据目录，只修改和签名副本。**应用副本与官方 QQ 的原始聊天库是隔离的**：不会自动导入官方 QQ 的旧本地记录，也不保证将采集期间的数据写回官方 QQ 原来的数据库。重新打开官方 QQ 后的云端同步行为，仍由 QQ 决定。

Windows 使用 NapCat 提供的启动组件，不改写官方 QQ 安装文件；QQ 原生资料位置由其自身决定，不能套用 macOS 的目录隔离结论。

NapCat 登录使用 QQ 客户端会话，不是腾讯开放平台 OAuth。第三方接入的兼容性和账号状态取决于 QQ 与 NapCat，不能保证所有版本可用或绝无风控影响。不要为了验证功能频繁切换真实账号或反复登录。

### 更新与数据保留

重新安装或构建后，会检查 QQ 副本的来源、加载入口、启动参数和签名策略再决定是否复用。需要重建时先准备临时副本，再替换正式目录；替换失败尝试回滚。macOS 使用 QQ 的多进程运行方式，同时签名并校验副本中的辅助进程，避免单进程模式在正常退出时触发“QQ 意外退出”。组件修复不会清理 `qq-profile` 或业务消息库。

从旧版“群讯”迁移时，仅在 `ChanceKit` 目录不存在的情况下整体搬移旧数据目录；两者同时存在时不覆盖、不合并。QQ 登录资料与已归档消息保留。**macOS 改名可能导致旧版 `safeStorage` 加密的外接 NapCat 配置无法解密，需要在 GUI 中重新填写地址与令牌**；搬移旧密文不等于系统钥匙串身份也完成迁移。

## 开发与构建

### 环境

- Node.js 24 或更新版本及 npm。
- macOS 或 Windows 开发环境。正式安装包在对应目标系统构建和验收。
- Electron 自动测试不需要真实 QQ 账号；浏览器布局测试使用本机 Google Chrome。
- 首次安装依赖和准备 NapCat 的构建机器需要网络，也可预置与清单匹配的官方组件 ZIP。

在仓库根目录执行：

```sh
npm ci
npm run prepare:napcat
npm run dev
```

`npm run dev` 启动 Vite 和 Electron，开发界面默认端口为 5178，占用时自动换端口；连接 QQ 仍需在 GUI 中主动操作。仅查看界面可运行 `npm run dev:web`，浏览器预览没有 QQ 接入能力。

### NapCat 如何随包分发

固定版本、官方 URL、文件大小和 SHA-256 位于 [resources/napcat/manifest.json](resources/napcat/manifest.json)。维护者执行 `prepare:napcat`，将校验通过的原始 ZIP 放入 `resources/napcat/`；此 ZIP 不提交到 Git。

构建和打包都会再次校验组件。缺失或损坏时直接失败，不生成缺少组件的安装包。打包时 ZIP、清单和来源说明一起进入应用资源目录；最终用户首次连接只从安装包解压，不需要下载 NapCat，也不需要访问 GitHub。QQ 的正常联网仍然必需。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按 lockfile 安装依赖 |
| `npm run prepare:napcat` | 获取或验证固定版官方 NapCat ZIP |
| `npm run dev` | 启动桌面开发环境 |
| `npm run dev:web` | 仅启动浏览器界面预览 |
| `npm run typecheck` | TypeScript 检查 |
| `npm run build` | 检查类型并构建界面、主进程和后台服务 |
| `npm test` | 协议、存储、迁移及运行目录回归测试 |
| `npm run test:e2e` | Electron 与浏览器布局测试，运行前先 build |
| `npm start` | 运行已构建的桌面应用 |
| `npm run package` | 构建当前平台的应用目录 |
| `npm run dist` | 构建当前平台安装包 |

推荐验证顺序：

```sh
npm run build
npm test
npm run test:e2e
```

输出位于 `dist/`、`dist-electron/`、`release/`。macOS 配置为 DMG/ZIP，Windows 为 NSIS 安装器。当前未配置正式代码签名和公证。

### GitHub 手动发布

打开 [Actions → Release ChanceKit](https://github.com/x-tok/ChanceKit/actions/workflows/release.yml)，点击 **Run workflow**，选择 `main` 后运行。版本号读取所选提交的 `package.json`，默认勾选预览版；工作流会构建 macOS arm64/x64 和 Windows x64 安装包，内置 NapCat，并在检查通过后创建 `v版本号` 的 Release。

**普通 push、推送 tag 和 Pull Request 都不会触发发布。** 不需要提前创建 tag、上传安装包或配置签名证书。新版本发布前应同步更新 `package.json` 与 `package-lock.json` 的版本并推送；已有版本不会被覆盖。步骤、失败重试和平台验证边界见[发布说明](docs/releases.md)。

自动测试只连接本机 NapCat 协议模拟服务，使用合成账号和消息。不要把测试数据目录改成正在使用的资料目录，也不要用主账号反复登录代替自动测试。更多规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目结构

```text
src/                    React 界面、品牌、共享协议与桌面桥接
electron/main.ts        窗口、系统凭据、文件选择、导出与 IPC
electron/preload.ts     隔离的桌面桥接
electron/worker.ts      utilityProcess 后台服务入口
electron/core/         OneBot、NapCat、运行管理、业务服务和 SQLite
resources/napcat/      固定组件清单与来源说明
scripts/               开发、构建、组件准备与打包校验
.github/workflows/     仅手动触发的跨平台发布流程
tests/                 协议、存储、迁移和 Electron 测试
docs/                  接入细节与验证范围
DESIGN.md               界面设计约定
```

技术栈为 Electron、React、TypeScript、Vite 和 Node.js SQLite。渲染进程不直接操作 QQ 或数据库，消息服务运行在独立后台进程，通过受限 IPC 与界面通信。

## 当前限制与后续方向

- 历史范围取决于 QQ 接口实际返回值；空群、过期记录和未同步记录可能无法读取。
- 重连只补取最近一页，长时间离线可能有缺口；尚未提供全量历史保证或持续断点回溯。
- 去重目前针对消息重放。不同群转发的同一招聘信息尚未进行语义合并。
- 合并转发仅展开一层文字；图片、语音、视频和嵌套转发保留原始字段，未做完整内容解析。
- 后续计划包括独立 Agent 抽取模块、多模态及链接解析、结构化 JSON 落库、并发调度和机会去重；这些功能尚不可配置或使用。
- 微信接入是后续扩展方向，本版没有微信适配器。

## 常见问题

**没有找到 QQ？** 自行安装官方 QQ 后重新检测，或在文件选择器中选择原始安装。其他工具生成的 QQ 副本不作为安装来源。

**macOS 提示 QQ 正在运行？** 正常退出官方 QQ 后再连接。见机不会主动强制关闭你的官方 QQ。

**二维码没有出现？** 先查看连接活动；如果已有资料恢复登录成功，会直接展示账号。如果使用外接 NapCat，检查 WebUI 地址、令牌及登录管理开关。

**连接成功但没有消息？** 群列表不代表历史已导入。先关注群，再获取最近记录；没有可获取记录的群会展示空状态。

**停止后记录还在，但左下角没账号？** 这是预期行为：当前登录状态已经清空，离线归档仍保留。

**构建提示 NapCat 缺失或损坏？** 执行 `npm run prepare:napcat`，或提供与清单完全匹配的官方 ZIP 后重试。

## 贡献与许可

欢迎通过 Issue 或 Pull Request 反馈问题、补充兼容性结果和改进实现。反馈中请使用合成或脱敏数据，不附带真实聊天库、二维码、令牌或个人资料目录。提交规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

项目自身的源码许可证尚待维护者确定；当前仓库公开计划不代表已经完成再分发授权。NapCat 及其依赖保留各自上游许可，见 [组件来源说明](resources/napcat/NOTICE.md) 和 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)。QQ 的名称和软件属于其权利人，见机不是腾讯官方产品。

更多实现细节见 [QQ 接入说明](docs/integration.md)、[验证范围](docs/validation.md) 和 [设计约定](DESIGN.md)。
