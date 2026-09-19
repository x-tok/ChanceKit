# 群讯

一个全新的 QQ 群消息桌面客户端。全部源码、依赖、构建配置和测试都在本目录内，不引用父目录项目的文件、服务或运行缓存。

当前版本只实现 QQ 接入和消息归档，没有接入 LLM、招聘信息抽取或微信。

## 已实现

- 官方 QQ 路径、版本检测和 GUI 文件选择。
- 未安装 QQ 时提供官方网站入口，由用户自行下载安装，不自动安装 QQ。
- 安装包内置固定版本 NapCat，首次使用本地校验、解压，无需访问 GitHub。
- macOS 使用官方 QQ 的私有副本，Windows 使用 NapCat 官方启动组件。
- NapCat WebUI 管理接口认证、二维码显示与刷新、登录状态轮询。
- 已有 NapCat 的 OneBot WebSocket 连接，可选登录管理服务。
- 群列表、搜索、关注与取消关注。
- 获取最近 100 条消息、手动继续读取更早历史。
- 关注群的实时消息归档、断线重连、重新连接时补取最近一页。
- SQLite WAL 本地存储、消息去重、离线阅读和本地文字搜索。
- 文字、图片链接、分享卡片、附件信息、合并转发文字、原始响应查看。
- JSON Lines 消息导出。

## 桌面操作

1. 在“连接 QQ”选择“本机 QQ”。如果没有检测到 QQ，自行安装官方 QQ 后重新检测，也可以选择安装位置。
2. 正常退出正在使用的桌面 QQ，点击“连接 QQ”。应用解压内置连接组件，成功后显示二维码。
3. 在手机 QQ 中扫码并确认登录，然后点击“查看群聊”。
4. 选择群聊，点击“关注”开始归档新消息，点击“获取消息记录”导入最近消息。
5. 点击“从 QQ 获取更早记录”继续回溯；通过导出按钮保存已归档消息。
6. 需要返回普通 QQ 时，在连接页停止连接，再打开官方 QQ。下次连接仅尝试恢复本应用中已确认过的账号；登录凭据不可恢复时重新显示二维码。

已有 NapCat 的用户可在 GUI 中填写消息服务地址与访问令牌。需要本应用显示二维码时，还要启用扫码登录管理并填写 WebUI 地址及对应令牌。两个令牌不是同一份凭据。

## 独立开发

以下命令只给开发者使用，最终桌面用户不需要 Node、终端或编辑配置文件。

需要 Node.js 24 或更新版本。

```sh
npm install
npm run prepare:napcat
npm run dev
```

`npm run dev` 启动 Vite 和 Electron。默认浏览器预览端口为 5178，占用时自动换端口。浏览器没有桌面桥接，只预览界面；QQ 接入在 Electron 内运行。

`prepare:napcat` 仅供维护者构建前使用，从官方 Release 获取固定版本并验证 SHA-256，不读取 `.dev-data`、原 QQ 或 QCE 缓存。有网络限制的构建环境也可预先将匹配清单的官方 ZIP 放入 `resources/napcat/`。构建及打包会再次校验，缺失或损坏时直接失败，不生成缺少组件的安装包。用户收到的安装包包含 ZIP 和清单，运行时没有 NapCat 下载回退。

```sh
npm run build
npm test
npm run test:e2e
npm run package
```

端到端测试启动真正的 Electron 客户端和独立的 NapCat 协议模拟服务，不访问个人 QQ 数据。窄屏测试使用本机 Google Chrome。`test-results/` 保存截图，测试账号和消息只存在于测试夹具。

`npm run package` 生成当前平台的应用目录；`npm run dist` 生成 DMG/ZIP 或 Windows NSIS 安装器。当前未配置生产签名证书，开发构建不等同于正式发行版。Windows 安装包应在 Windows 构建和实机验收。

## 目录

```text
src/                  React 界面、共享消息协议、桌面桥接
electron/main.ts      窗口、系统凭据、文件选择、导出、窄 IPC
electron/preload.ts   隔离的桌面桥接
electron/worker.ts    utilityProcess 后台服务入口
electron/core/       NapCat、OneBot、运行管理、SQLite 与业务服务
scripts/             独立构建与开发启动
tests/               协议、存储、服务与 Electron 测试
docs/                接入与验证说明
DESIGN.md             客户端设计约定
```

开发数据保存在本项目 `.dev-data/`，正式应用使用 Electron 的独立 `userData` 目录。运行组件在其 `runtime/` 下，消息在 `messages.sqlite` 中。macOS 采集使用 `runtime/qq-profile`，不链接旧 QCE 或原 QQ 的聊天库。

## 当前边界

- QQ 登录是第三方 QQ 客户端登录，不是腾讯开放平台 OAuth。
- 历史只包含 QQ 接口当前能够返回的记录。macOS 独立资料目录不会自动带入官方 QQ 的旧本地历史。
- 初版是手动按页回溯。重连仅补取最近一页，长时间断线可能有缺口；尚未实现全范围后台导入和完整断点回溯。
- 消息正文与原始响应在本机保存；图片及附件当前保留上游引用，未做永久文件归档，链接可能过期。
- 合并转发目前展开一层文字；内嵌图片、视频、语音和多层转发仍保留原始字段。
- SQLite 业务库不做整库加密；外接连接配置使用 Electron safeStorage。NapCat 自身需要在私有运行目录读取令牌配置。
- 自动启动兼容性取决于 QQ、NapCat 和系统版本。Windows 10/11 的真实 QQ 启动尚需实机验收；不能用协议模拟测试代替。
- 许可联系由项目发起人另行进行，本次实现没有 fork NapCat 或复制 QCE 源码。

详细协议与进程说明见 [docs/integration.md](docs/integration.md)。
