# 安装与发布

## 下载与安装

在 [Releases](https://github.com/x-tok/ChanceKit/releases) 中选择版本，展开 **Assets** 下载。预览版带有 **Pre-release** 标记，适合先行体验；自动生成的 `Source code` 是源码，不是安装包。

| 文件名后缀 | 适用设备 |
| --- | --- |
| `mac-arm64.dmg` | Apple Silicon Mac，例如 M1/M2/M3/M4 |
| `mac-x64.dmg` | Intel Mac |
| `mac-arm64.zip` / `mac-x64.zip` | 对应架构的 macOS 应用压缩包 |
| `win-x64.exe` | Windows 10/11 x64 安装器 |
| `SHA256SUMS.txt` | 上述五个文件的 SHA-256 校验值 |

安装包包含固定版本 NapCat；用户不需要另行从 GitHub 下载组件。官方 QQ 需要自行安装。macOS 打开 DMG 后将见机拖入“应用程序”，Windows 双击安装器按提示安装。

### 未正式签名的安装包

macOS 暂不使用 Developer ID 证书，也不向 Apple 提交公证。构建中仅做无需证书的 ad-hoc 签名，保证应用代码签名结构完整；这不代表 Apple 认证，也不会消除首次打开的安全提示。

首次打开被阻止时，先确认文件来自本仓库 Release，再进入“系统设置 → 隐私与安全性”，在见机对应提示处点击“仍要打开”，按系统要求验证身份。旧系统入口可能叫“系统偏好设置 → 安全性与隐私”。系统策略、受管理设备或不同拦截原因可能不提供此按钮，不能保证所有提示都能通过这一方式处理。若提示文件损坏，先重新下载并反馈具体提示，不要全局关闭系统安全检查。

Windows 安装器暂未签名，可能显示 SmartScreen 提示；确认来源后按系统界面继续。企业设备策略可能禁止运行。应用打包成功不代表所有系统和 QQ 版本都已实测，发布前仍需在目标平台和对应 QQ 版本上验收。

## 维护者手动发布

1. 将待发布代码推送到 `main`。发布新版本时，在开发环境执行 `npm version 0.1.1 --no-git-tag-version`（替换成实际版本），审查并提交两个 package 文件；不要提前创建同名 tag。
2. 打开 [Actions → Release ChanceKit](https://github.com/x-tok/ChanceKit/actions/workflows/release.yml)，点击 **Run workflow**，选择 `main`。
3. 默认不勾选 **Publish as a pre-release instead of the Latest release**，发布后会成为 Latest。只有预览版才勾选；带 `-beta.1` 等后缀的版本必须勾选。
4. 点击运行。版本来自所选提交，所有任务都构建该次触发固定的提交 SHA。普通 push、tag 和 Pull Request 不触发此工作流。
5. 等待三个平台任务及发布任务完成，从运行摘要或 Releases 页面取得下载链接。正式版标记为 Latest，预览版不会替换 Latest。

工作流在 GitHub 托管的全新 macOS/Windows 环境执行 `npm ci`，下载并验证清单固定的 NapCat ZIP，构建、运行模拟测试和打包。打包后再次核对应用入口、版本、NapCat 清单与 ZIP 摘要，macOS 还校验 ad-hoc 签名。不会安装、登录真实 QQ，也不会读取维护者电脑上的数据。

构建任务仅有仓库读取权限。只有全部平台成功后，发布任务才使用 GitHub 自带的 `GITHUB_TOKEN` 创建草稿、上传五个安装包和摘要文件，核对远端大小与 SHA-256 后公开 Release。无需添加个人访问令牌或签名 Secrets；仓库需要允许 Actions 运行这些官方 Actions，并允许发布任务取得 `contents: write` 权限。

### 失败与重试

- 构建或测试失败不会创建 Release。修复后提交并重新手动运行；同一次运行中重新执行失败任务也可复用已成功任务的结果，构建附件保留 7 天。
- 上传或摘要核验失败会保留草稿，供维护者检查，不自动公开。重新运行前，在 Releases 中删除本次失败的草稿；如已生成同名 tag，确认没有任何已发布版本使用它后再删除。已公开版本应通过新版本修复，不覆盖附件。
- 同名 Release（包括草稿）或 tag 已存在时，会拒绝重复发布。这个规则也意味着成功后点击“重新运行”不会替换原包。
- 若 GitHub 禁用了 Actions 或组织策略禁止写入 Releases，需要仓库管理员调整平台设置；不需要在应用内配置这些权限。

当前工作流不提供应用内自动更新。用户下载新版安装包安装；现有本地数据保留规则见 README。
