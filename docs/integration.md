# 见机 ChanceKit：QQ 接入实现

## 数据流

渲染进程通过 `preload` 暴露的有限命令与主进程通信。主进程验证发送窗口和命令 schema，再转发到 utilityProcess。后台服务拥有 OneBot 连接、运行管理器和 SQLite，QQ 进程是独立子进程。没有任意 shell、SQL、文件系统或发送 QQ 消息的渲染进程接口。

应用只在用户点击连接后启动 QQ。停止连接只停止本应用创建的进程，不按 QQ 进程名强杀用户已有实例。关闭整个应用会停止采集并关闭数据库。

## 固定组件

NapCat 4.18.28 Shell 发布包：

```text
https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.28/NapCat.Shell.zip
bytes: 29498670
sha256: bcdd8bdb9e44bd0cf6a90908e572141787fd9e98cb8d8eecc5adf25bbdcabb94
```

版本和校验值统一存储在 `resources/napcat/manifest.json`。维护者运行 `npm run prepare:napcat` 获取官方 ZIP；构建脚本和 electron-builder 的 beforePack 都会检查大小和 SHA-256。通过 extraResources 将原始 ZIP、清单、来源说明一起放入安装包的 `resources/napcat/`（macOS 为 `Contents/Resources/napcat/`），不从开发运行目录收集文件。

主进程明确传递安装包内的 ZIP 路径给后台服务。首次连接只读取该文件，校验后解压到用户数据目录 `runtime/napcat-4.18.28/`。安装使用临时目录，校验及解压成功后切换；不接受压缩包符号链接。资源缺失或校验失败时提示重新安装，不联网下载。后续复用本应用已安装组件及配置。组件首次使用不会读取其他产品的目录或复用发现的本地端口。运行期间的令牌每次重新生成，接口只绑定 `127.0.0.1`。

## macOS

1. 检测官方 QQ 的 `package.json`，拒绝已被改为第三方入口的副本。
2. 原 QQ 必须正常退出。原始应用只读取，不修改其入口或签名。
3. 复制到本应用的 `QQRuntime.app`，在副本中生成 `chancekit-loader.cjs` 加载入口并做 ad-hoc 签名。
4. NapCat 当前通过 `os.homedir()` 构造 macOS 资料目录。加载入口只在自己的 QQ 进程内替换这个函数，指向本应用的 `runtime/qq-profile`，并同步 Node 内置模块导出。系统 HOME 和原 QQ 配置不变。
5. 使用 QQ 自带 Electron 启动 NapCat，设置独立 `NAPCAT_WORKDIR`。`CHANCEKIT_NAPCAT_ENTRY` 和 `CHANCEKIT_QQ_DATA` 分别指定组件入口与私有资料目录，不使用应用壳内的 Electron 加载 QQ 的 native wrapper。

副本复用会核对来源包摘要、关键文件身份、加载器与签名权限内容的摘要、实际加载入口以及代码签名。更改加载器后自动失效，不依赖手动递增版本号。准备副本前也会拒绝仍在运行的同路径 QQ 连接进程。

QQ 副本与 NapCat 组件的磁盘管理在 Electron 中使用 `original-fs`，将 `application.asar` 当作真实文件处理。每次准备使用独立临时目录；新副本校验通过后，将旧目录改名为 `.previous`，再发布新目录。发布失败尝试恢复旧目录；启动时发现只有 `.previous` 则先恢复。清理旧目录失败不会覆盖原始错误或使已经完成的替换变成失败。修复同版本 NapCat 时保留 `config`；QQ 的 `qq-profile` 和消息数据库不在这些替换目录内。

这条路径参考公开启动机制后独立实现。它必须在干净 macOS 和实际 QQ 版本上验证；开发机器可运行不代表已经通过默认 Gatekeeper 的正式安装包验收。

## Windows

检测安装位置和 `versions/config.json` 指向的实际 QQ 核心包。根据实际 package 信息生成临时启动描述，用官方发布包内的 `NapCatWinBootMain.exe` 和 `NapCatWinBootHook.dll` 启动；不调用会弹终端和暂停等待的 `.bat` 文件，不把示例 `qqnt.json` 中的旧版本硬编码为用户版本。

NapCat 配置和本应用消息归档独立保存；Windows QQ 原生层自行决定其官方账号资料位置。需要在 Win10/11 x64 验收子进程退出、路径有空格、VC++ 运行库和 QQ 版本兼容性。

## 登录与消息协议

登录管理：`POST /api/auth/login` 发送 `sha256(token + '.napcat')`，后续用返回的 `Credential` 作为 Bearer 凭据。

- `QQLogin/CheckLoginStatus`：已登录、离线、二维码和登录错误。
- `QQLogin/RefreshQRcode`：刷新二维码。
- OneBot `get_login_info`：确认账号身份。
- `get_group_list`：群列表。
- `get_group_msg_history`：每页 100 条历史。
- `get_forward_msg`：展开合并转发。
- `message` / `message_sent` 群事件：关注群的增量归档。

OneBot 请求用随机 echo 标识关联响应，不假设响应按发出顺序到达。连接关闭立即拒绝未完成请求；每个请求有超时。单个历史查询串行执行，实时消息仍可进入 SQLite。

NapCat 的 `message_seq` 在此版本中是短 ID 锚点，不能算术递增或作为永久游标。应用仅保留当前连接会话的分页锚点，重连时清空。向更早历史分页时使用 `reverse_order=true`；真实 QQ 比较测试中，false 返回锚点和更晚消息，true 返回锚点和更早消息。历史消息持久化成功后才推进锚点。

没有锚点的初次查询收到“消息不存在”，显示“QQ 当前没有可获取的记录”；向前分页遇到相同返回时，显示暂时没有更早记录。不将它等同于连接故障或完整导出证明。网络、令牌和其他接口错误仍单独显示。

## 存储与显示

消息键包含账号、群和 `real_seq`；没有原始序号时使用外部 ID、发送者、时间及消息摘要。内容相同的两次真实发送保留为两条。群关注状态刷新后保留。群不在最新列表时，其已归档资料仍可在本机查看。

`AppState.account` 只代表确认成功的当前登录，`localAccount` 表示当前离线归档的所属账号。登录信息与群列表确认后一起发布；停止连接先清空当前账号，再等待子进程退出。取消后的迟到响应通过会话 generation 校验丢弃，不会覆盖新连接。账号切换会重置阅读器，离线读取仍使用归档账号。

旧版“群讯”目录只在新的 `ChanceKit` 目录不存在时整体迁移，不合并已有目录。文件搬移保留 QQ 原生登录资料和业务库，但 macOS 的 Electron `safeStorage` 使用应用名选择钥匙串项；改名后旧外接 NapCat 配置可能不能自动解密，需要在 GUI 重新填写。迁移测试不宣称钥匙串密钥已经迁移。

正文通过 React 文本节点展示，JSON 卡片使用结构化解析，外部链接限定 HTTP/HTTPS。原始 OneBot JSON 可供核对。渲染进程没有 Node 权限，拒绝打开额外窗口或授予摄像头等权限。

## 验证范围

自动测试分三层：真实 HTTP/WS 协议服务测试、SQLite 与业务服务测试、Electron GUI 操作与截图。协议模拟服务明确使用测试账号，不与真实 QQ 登录混淆。

真实 QQ 验证须事先取得账号持有人同意，避免频繁登录或切换。平台验证仅记录操作系统与架构、QQ 核心版本、NapCat 版本、资料目录是否新建及各流程的通过情况，不保存真实账号和聊天内容。用户扫码之前只能确认“二维码链路”，不能记录成“真实消息采集通过”。

## 源码依据

- [NapCat 4.18.28](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.28)
- [QQLogin 管理接口](https://github.com/NapNeko/NapCatQQ/blob/v4.18.28/packages/napcat-webui-backend/src/api/QQLogin.ts)
- [Auth 管理接口](https://github.com/NapNeko/NapCatQQ/blob/v4.18.28/packages/napcat-webui-backend/src/api/Auth.ts)
- [OneBot 历史查询](https://github.com/NapNeko/NapCatQQ/blob/v4.18.28/packages/napcat-onebot/action/go-cqhttp/GetGroupMsgHistory.ts)
- [Windows 启动参数](https://github.com/NapNeko/NapCatQQ/blob/v4.18.28/packages/napcat-shell-loader/launcher-user.bat)
- [QCE 公开 macOS 启动机制](https://github.com/shuakami/qq-chat-exporter/blob/7fcca88880c2eb8c12c51c2b6cc49ee805a53d0c/scripts/napcat-launcher/launcher-user.sh)
