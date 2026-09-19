# 参与 ChanceKit

## 开发与验证

使用 Node.js 24 或更新版本。在仓库根目录执行 `npm ci` 和 `npm run prepare:napcat`，然后按 [README](README.md) 运行开发环境。

提交前运行：

```sh
npm run build
npm test
npm run test:e2e
git diff --check
```

Electron 测试使用独立临时资料目录和本机 HTTP/WebSocket 模拟服务。浏览器布局测试使用 Google Chrome。测试输出保存在被忽略的 `test-results/` 中。

## 测试账号与数据

- 默认使用合成消息和模拟服务。正常自动验证不需要真实 QQ 登录。
- 不操作、断开、重连或切换他人正在使用的 QQ 会话。真实账号测试应先取得账号持有人的明确同意，避免频繁登录。
- 不将 `.dev-data/` 或正式应用资料目录用作自动测试目录，不清理其中的登录资料和消息库。
- 需要复现账号、群聊或附件问题时，使用虚构标识、示例链接与合成内容；截图也应使用这些数据。
- 平台实测结果只记录系统、架构、软件版本、步骤与结果，不记录私人群名、账号或聊天内容。

## 提交内容

每次提交围绕一个可解释的功能或修复，相关测试随实现一起提交。可使用 `feat:`、`fix:`、`docs:`、`chore:` 等前缀；使用实际作者配置与提交时间。

按文件或改动块暂存后，检查将要进入 Git 的内容：

```sh
git status --short
git diff --cached --stat
git diff --cached --check
git diff --cached
```

`.gitignore` 会排除资料目录、数据库及其 WAL 文件、消息导出、日志、测试截图、环境变量文件、签名私钥和生成的安装包。它不会删除本地数据，也无法保护已经跟踪或被强制添加的文件。遇到误提交的真实凭据，应先撤销凭据，再按仓库状态处理历史。

NapCat ZIP 由构建前准备步骤下载和校验，不提交到源码仓库。不要用自己的 NapCat 运行目录、QQ 安装副本或已登录配置制作分发组件。公开反馈、PR 描述和构建附件同样需要检查敏感信息。

## 兼容性与打包

涉及 QQ 接入的修改应核对 [接入说明](docs/integration.md) 和 [验证范围](docs/validation.md)。代码应保留本地归档与当前登录状态的区别；重建运行组件不能删除账号资料或业务数据库。

Windows 与 macOS 的原生进程和资料路径不同，不能用单个平台或模拟服务的结果宣称全平台通过。`npm run package` 与 `npm run dist` 只生成本地产物，不自动发布。
