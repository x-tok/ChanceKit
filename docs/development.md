# 开发与构建

[返回首页](../README.md) · [文档目录](README.md)

## 环境

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

需要从首次设置开始重新测试时，先退出开发版见机，再执行 `npm run clean:dev-data`。该命令只删除仓库内的 `.dev-data/`，包括见机的消息库、设置状态、模型配置、Electron 缓存和本应用创建的 QQ 运行副本；不会删除官方 QQ 的应用或原聊天数据。

`dev`、`start` 和 `test:e2e` 会先检查 Electron 运行文件，缺失时调用官方安装器下载并校验，代理选择与 NapCat 下载一致。也可单独执行 `npm run prepare:electron`。安装包已缓存或运行文件已就绪时会直接复用，不需要删除 `node_modules` 或重装全部依赖。

## NapCat 如何随包分发

固定版本、官方 URL、文件大小和 SHA-256 位于 [resources/napcat/manifest.json](../resources/napcat/manifest.json)。维护者执行 `prepare:napcat`，将校验通过的原始 ZIP 放入 `resources/napcat/`；此 ZIP 不提交到 Git。

下载优先使用 `HTTPS_PROXY` / `HTTP_PROXY`（也支持小写），其次使用 npm 的 `https-proxy` / `proxy` 配置；均未设置时，macOS 自动读取系统的 Web / Secure Web 代理。`NO_PROXY` 可指定不走代理的域名，设置为 `*` 则全部直连。脚本不修改系统代理，不使用第三方镜像；连接超时或临时网络错误最多尝试 3 次，每次仍校验固定大小和 SHA-256。

如果 GitHub 直连超时，可显式指定本机 HTTP 代理（端口按实际配置调整）：

```sh
# macOS / Linux
HTTPS_PROXY=http://127.0.0.1:7890 npm run prepare:napcat
```

```powershell
# Windows PowerShell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
npm run prepare:napcat
```

也可从清单中的官方 URL 手动下载，将 ZIP 放到 `resources/napcat/NapCat.Shell.zip` 后重试；已通过校验的文件不会重复下载。

构建和打包都会再次校验组件。缺失或损坏时直接失败，不生成缺少组件的安装包。打包时 ZIP、清单和来源说明一起进入应用资源目录；最终用户首次连接只从安装包解压，不需要下载 NapCat，也不需要访问 GitHub。QQ 的正常联网仍然必需。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按 lockfile 安装依赖 |
| `npm run prepare:napcat` | 获取或验证固定版官方 NapCat ZIP |
| `npm run prepare:electron` | 使用代理配置检查或安装 Electron 运行文件 |
| `npm run clean:dev-data` | 清除源码开发版的本地数据和缓存 |
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

## GitHub 手动发布

打开 [Actions → Release ChanceKit](https://github.com/x-tok/ChanceKit/actions/workflows/release.yml)，点击 **Run workflow**，选择 `main` 后运行。版本号读取所选提交的 `package.json`，默认发布正式版并标记为 Latest；需要预览版时再勾选预发布选项。工作流会构建 macOS arm64/x64 和 Windows x64 安装包，内置 NapCat，并在检查通过后创建 `v版本号` 的 Release。

**普通 push、推送 tag 和 Pull Request 都不会触发发布。** 不需要提前创建 tag、上传安装包或配置签名证书。新版本发布前应同步更新 `package.json` 与 `package-lock.json` 的版本并推送；已有版本不会被覆盖。步骤、失败重试和平台验证边界见[发布说明](../docs/releases.md)。

自动测试只连接本机 NapCat 协议模拟服务，使用合成账号和消息。不要把测试数据目录改成正在使用的资料目录，也不要用主账号反复登录代替自动测试。更多规则见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 项目结构

```text
src/                    React 界面、品牌、共享协议与桌面桥接
  onboarding/           首次设置步骤与一次性同步编排
  settings/             完成初始化后的统一设置页面
electron/main.ts        Electron 生命周期与模块装配
electron/preload.ts     隔离的桌面桥接
electron/worker.ts      utilityProcess 后台服务入口
electron/onboarding/    首次设置状态存储与 IPC 注册
electron/core/          Electron 后台领域模块
  application/          后台服务与命令编排
  connection/           OneBot、NapCat 管理接口与连接校验
  runtime/              QQ/NapCat 进程、组件和运行目录
  archive/              消息存储、附件与引用关系
  models/               模型配置与 pi 适配
  materials/            网页、图片、PDF 和文档读取
  processing/           招聘信息、日程提取与处理队列
resources/napcat/       固定组件清单与来源说明
scripts/                开发、构建、组件准备与打包校验
.github/workflows/      仅手动触发的跨平台发布流程
tests/                  协议、存储、迁移和 Electron 测试
docs/                   使用、数据、活动处理、开发与发布说明
DESIGN.md               界面设计约定
```

技术栈为 Electron、React、TypeScript、Vite 和 Node.js SQLite。页面和 Electron 后台分别按功能目录组织；`main.ts` 只负责生命周期、IPC 和领域模块装配，不保存具体业务规则。渲染进程不直接操作 QQ 或数据库，消息服务运行在独立后台进程，通过受限 IPC 与界面通信。Electron 核心模块的职责和依赖方向见 [`electron/core/README.md`](../electron/core/README.md)。
