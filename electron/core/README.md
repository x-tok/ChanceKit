# Electron 核心模块

`electron/main.ts` 和 `electron/worker.ts` 是装配入口，`core` 内按领域组织实现，不在目录根部放业务 TypeScript 文件。

| 目录 | 职责 |
| --- | --- |
| `application/` | 后台服务编排，对接 IPC 命令与各领域模块 |
| `connection/` | OneBot 协议、NapCat 管理接口和连接参数校验 |
| `runtime/` | QQ/NapCat 进程、内置组件、运行目录和 macOS 启动适配 |
| `archive/` | 消息 SQLite 存储、附件边界和引用关系 |
| `models/` | 模型配置持久化与 pi 模型适配 |
| `materials/` | 网页、图片、PDF、文档等消息材料读取 |
| `processing/` | 招聘信息与日程提取、审核、队列和查询 |

依赖保持从编排层指向领域层：

```text
application ──> connection / runtime / archive / materials
runtime ──────> connection
models ───────> connection
materials ────> models
processing ───> archive / materials / models
```

同一领域内使用相对导入，跨领域直接指向所属文件。不要增加汇总导出的 `index.ts`，以免隐藏依赖或形成循环。
