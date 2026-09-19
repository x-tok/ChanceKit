# ChanceKit 验证范围

本文件说明验证方法与证据边界，不保存真实账号、群名、聊天内容或私人资料路径。自动测试的数据均为合成数据。

## 自动验证

准备 Node.js 24+、依赖、固定版本 NapCat ZIP 和 Google Chrome 后，在仓库根目录执行：

```sh
npm run build
npm test
npm run test:e2e
```

| 测试文件 | 覆盖范围 |
| --- | --- |
| `tests/core.test.ts` | OneBot 乱序响应与事件分流、超时、管理认证、消息去重、分页、导出、离线读取、取消登录和账号隔离 |
| `tests/component.test.ts` | 离线组件安装、摘要校验、残缺组件修复与配置保留 |
| `tests/profile.test.ts` | 旧目录迁移、SQLite WAL 与登录文件保留、已有目录不覆盖 |
| `tests/runtime-files.test.ts` | 运行副本替换、失败回滚、中断恢复、清理错误处理 |
| `tests/runtime-stop.test.ts` | 本机 `bot_exit`、无响应时的退出等待、重复停止、扫码前管道退出与已退出进程保护 |
| `tests/release.test.mjs` | 版本一致、拒绝重复发布、拒绝缺失或额外附件、上传失败或摘要不符时保持草稿 |
| `tests/e2e/desktop.spec.ts` | 独立 Electron 窗口中的模拟扫码、群列表、历史与实时消息、搜索、断线重连、账号显示和窗口尺寸 |
| `tests/e2e/runtime-files.spec.ts` | 真实 Electron utilityProcess 中含有效 ASAR 文件的目录清理与替换 |
| `tests/e2e/qq-exit.spec.ts` | 真实 Electron 加载 macOS 运行入口后，通过私有 stdin 管道正常退出，不加载 QQ 或真实登录资料 |
| `tests/e2e/quit.spec.ts` | macOS 系统退出事件（与 Dock 退出相同）经过真实主程序，等待后台服务及模拟 QQ 进程清理；覆盖重复退出 |
| `tests/native/mac-qq-exit.test.ts` | 可选：临时复制官方 QQ，使用真实 QQNT 运行库验证管道与模拟 OneBot 退出码及辅助进程清理；不登录 QQ |

Electron 桌面布局覆盖 1240x820、900x820、1240x640、900x640；浏览器预览覆盖 1280、760、375、320px。测试截图与失败 trace 位于 `test-results/`，不提交到 Git。

## 回归重点

### QQ 与 NapCat 副本

Electron 会把 ASAR 当作虚拟目录。运行目录管理使用 `original-fs`，并通过真实 Electron 后台进程测试这个差异，不能仅依赖普通 Node 文件系统测试。

新副本在独立临时目录完成准备和校验后再替换；替换失败恢复旧副本，遗留 `.previous` 可恢复。NapCat 同版本修复保留配置，QQ 登录资料与消息库不在替换目录中。

退出测试使用自建的子进程和模拟 OneBot 服务。NapCat `bot_exit` 会直接退出、可能来不及回复，因此以进程退出事件确认结果；WebSocket 断开不代表进程已经结束。macOS 的启动入口在登录前就接收私有管道退出指令，不依靠 JavaScript 的 `SIGTERM` 监听覆盖 Electron 原生处理。主程序等待后台清理完成，重复退出请求不能提前跳过等待。

这些测试验证退出指令和等待顺序，不替代特定 QQ 版本的实机验收；验证期间不自动操作真实 QQ 账号。外接 NapCat 的断开测试同时检查服务仍可接受新连接。

#### macOS QQNT 退出回归

标准 Electron 的退出测试无法覆盖 QQ 自带 QQNT 运行库的差异。QQ `6.9.89-45758` 在 `--single-process` 下，即使入口为空白脚本、未登录且未加载 NapCat，`process.exit(0)` 和 `app.quit()` 仍会在原生清理阶段触发 `SIGABRT`。去掉该参数并对副本内的框架与辅助进程一并签名后，管道退出和模拟 `bot_exit` 均返回退出码 0，辅助进程也结束。

已在 Apple Silicon 上执行原生回归的红绿对照：修复前测试因 `SIGABRT` 失败，修复后通过。测试仅修改临时副本，使用空白资料目录和合成 WebSocket 服务，不导入 NapCat、不进行真实账号登录。可显式执行：

```sh
CHANCEKIT_TEST_QQ_APP=/Applications/QQ.app npm run test:native:qq
```

未指定路径或不在 macOS 上时跳过，发布 CI 不依赖安装官方 QQ。该测试不证明登录后的消息完整性，也不替代其他 QQ 版本、Intel Mac 和 Windows 的验收。

### 账号显示

当前登录账号与本地归档账号分开。启动时不把历史账号展示为已登录；停止、取消、断线和失败清空当前账号，离线记录仍可读取。迟到的登录或群列表响应不能恢复已取消的会话。

桌面回归还覆盖两处头像一致、空白昵称、图片加载失败后换号、停止后离线读取以及取消扫码。测试使用可控制响应时机的本机模拟服务，不需要反复登录真实 QQ。

### 数据迁移

目录迁移测试证明文件与 WAL 保留，**不证明系统钥匙串身份兼容**。macOS 应用改名后，旧 `safeStorage` 外接连接配置可能需要在 GUI 中重新填写；原始密文仍保留。

## 平台证据与限制

| 平台 | 已有证据 | 尚缺证据 |
| --- | --- | --- |
| macOS Apple Silicon | 开发阶段曾完成 QQ 检测、独立副本、扫码、群列表、分页归档、停止与恢复；开发 `.app` 可运行 | 干净机器安装验收、Developer ID 签名与公证、多版本兼容性 |
| macOS Intel | 代码路径存在 | 实机接入和打包验收 |
| Windows 10 / 11 x64 | 原生启动集成与安装器配置 | QQ 登录、进程退出、路径空格、运行库和版本兼容性实测 |

历史 macOS 接入使用 QQ 核心 package 版本 `6.9.89-45758` 与 NapCat `4.18.28`。该结果只代表当时的特定环境，不代表所有 QQ 版本均可用。

当前自动测试不操作真实 QQ。未来确需平台实测时，应先取得账号持有人同意，使用专门测试环境，并记录系统与软件版本、步骤、预期与实际结果。不要用心跳代替真实消息入库证据，也不要将一次成功登录等同于全量历史或离线缺口补齐。

## 发布流程验证

手动发布工作流在 macOS arm64、macOS x64 和 Windows x64 执行构建、模拟测试和打包，再校验包内入口与 NapCat 摘要。最终发布任务核对五个安装包和 GitHub 上传摘要，全部通过后公开 Release。该流程仅通过 `workflow_dispatch` 触发，详见[发布说明](releases.md)。

本地的发布逻辑测试使用模拟 GitHub API，不创建真实 Release。工作流配置和本地测试通过不等于 GitHub 三个平台已运行成功；首次手动运行及下载后的干净机器安装仍需验收。正式签名与公证暂不在本轮范围内。

## 尚未覆盖的能力

- 全量历史自动导入、长时间离线缺口补齐和完整断点回溯。
- 附件永久归档、复杂转发完整解析和 LLM 信息抽取。
- 官方 QQ 原资料库与 macOS 独立采集资料库的双向同步。
- 生产签名、公证和各平台干净机器安装验收。
