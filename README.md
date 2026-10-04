# 飞书云文档日历热力图

在飞书文档正文中显示每页 7 行 × 53 列的每日贡献热力图，共 371 个日期格子。小组件通过飞书官方 SDK 的 Events.onDocumentChange 监听文档块增删改；最后一次变化后空闲 10 秒，累计次数加 1 并预保存到 Interaction；连续空闲达到配置时长后结束本次编辑，默认时长为 1 分钟。配置时长内继续编辑仍属于同一次贡献，重新计时，后续预保存和最终确认不再增加次数。

首次展示启用日所在周及后续 52 周，每周从周日开始。进入第 54 周后，默认展示截至今天所在周的最近 53 周，并显示「更早」「更新」分页按钮和页码。历史分页每次向前移动 53 周；最早一页从启用周开始补足 53 周，允许与相邻页重叠。贡献更新时保留当前页，重新加载回到最新页。分页不修改已保存的贡献数据。

页面随小组件宽度调整方格大小，宽屏充分利用可用空间；窄屏保留至少 10px 的方格，仅图表区域横向滚动。月份与周列对齐，跨年处显示年份，边缘空间不足的标签会省略；图表上方显示完整日期范围。

开发验证面板默认折叠，点击「开发验证」可展开或收起，显示当日基线贡献次数、最新累计贡献次数、Interaction 已保存的累计贡献次数、当天贡献和最近 7 个自然日。页面没有手动刷新或保存按钮。当天保持 pending，并随贡献次数更新颜色；历史按 T+1 结算。

开发验证面板最底部提供 1、3、5、10、30、60 分钟六档计时规则。当前选项为蓝底白字且不可点击，其他选项可切换。切换立即影响当前编辑段，保留最后编辑时间；缩短后若已超时则立即结束，延长不会恢复已结束的编辑段。规则说明与状态提示随配置更新。配置自动保存到 Interaction，其他设备或网络打开、刷新同一小组件时读取；已打开的端不实时同步。本地外观预览中的选择只在本页面生效，不写入飞书数据。

## 数据与统计

- 首次启用从 0 开始；重新加载恢复已保存的数据，不重置累计次数和当日基线。
- 一段连续编辑只计一次贡献；多块变化和多次事件不会直接按数量累加。
- 文档变化按条目筛选：仅接受 `insert`、`remove`、`update`，并排除 `from: "silence"`。混合批次中的其他有效变更保留，来源缺失时沿用原判断。
- 打开、刷新、恢复页面可见，以及无编辑的闲置，不产生贡献。
- 预保存后关闭标签页可保留已成功保存的贡献。重新加载时恢复尚未结束的编辑段；预保存后再次编辑会保存最新编辑时间，避免刷新后按旧时间提前分段。保存失败每 10 秒重试写入，不再次增加贡献。
- 数据只来自飞书官方 SDK，不需要独立数据服务、CLI 数据代理或额外的文档信息读取接口。
- 小组件的 Interaction 根只保存 contributionHeatmapV1。首次使用新结构时建立零贡献状态，成功保存后替换原有统计数据，不迁移或兼容旧结构。
- 现有 version: 1 数据缺少 contributionIdleMinutes 时按 1 分钟读取，并在保存时补入字段；历史、累计和未结束贡献均保留。配置保存失败时保留页面中的选择，每 10 秒重试，成功保存后才可在其他端读取。
- 小组件未运行或未成功监听期间的编辑不补算。本次贡献尚未预保存时，未完成 10 秒静默就关闭或重新加载，不计入贡献；预保存未成功写入时也无法保证关闭后恢复。

完整规则和验收步骤见 [开发验证说明](doc/development-verification.md)。

加载事件误计的实测证据、事件机制、修复规则和验证边界见 [文档静默变更与贡献误计修复](doc/document-change-silence.md)。

## 项目结构

| 文件 | 用途 |
| --- | --- |
| src/activity.mjs | 本地自然日、贡献计数、T+1 结算、颜色分级 |
| src/tracker.mjs | 统计加载、预保存与确认贡献、串行保存 |
| src/idle.mjs | 文档变化筛选、10 秒预保存与可配置的分段调度 |
| src/contribution.mjs | 计时规则可选值、默认值与时长校验 |
| src/interaction.mjs | 官方 Interaction 读写适配 |
| src/feishu.js | 官方 SDK 初始化、事件订阅、组件高度调整 |
| src/index.js / index.html / index.css | 热力图与开发验证面板 |
| test/ | 统计、存储、调度和集成测试 |
| webpack.config.js | 官方打包插件与文档调试入口 |
| app.example.json | 可提交的配置模板 |
| app.json | 本地私有配置，已被 Git 忽略 |
| dist/ | 构建生成的程序包 |

## 配置与开发

项目沿用飞书官方小组件构建工具和 @lark-opdev/block-docs-addon-api。app.json 中填写 appID、blockTypeID 和调试文档 url，并保持 contributes.addPanel.useInteraction 为 true。本地配置无需写入数据接口地址。

安装依赖后，现有开发入口如下。这些命令负责开发和打包，不用于获取贡献数据。

| 命令 | 用途 |
| --- | --- |
| npm ci | 按锁文件安装依赖 |
| npm run start:preview | 仅预览页面外观，不读取飞书数据 |
| npm start | 启动飞书官方文档调试入口 |
| npm test | 执行自动化测试 |
| npm run build | 构建正式程序包 |
| npm run upload | 构建并通过官方开发工具上传程序包 |

外观预览地址为 [本地热力图](http://127.0.0.1:5173/block/index.html)。飞书内调试使用官方工具给出的调试链接；开发工具需要完成官方登录。在有编辑权限的文档正文中，通过「+」或「/」选择与 app.json.blockTypeID 对应的本地小组件，并保持开发服务器运行。

构建采用官方插件支持的 CI_FLAG=1 模式生成正式环境配置。上传后在 [飞书开发者后台](https://open.feishu.cn/app) 选择程序包、设置组件名称与可用范围并完成版本发布。正文插入已发布的小组件前，需先安装或添加组件；静态页面地址不能代替正文小组件。

## 官方接口

- [小组件 API 文档](https://open.feishu.cn/document/client-docs/docs-add-on/05-api-doc/05-api-doc)
- [Events.onDocumentChange](https://open.feishu.cn/document/client-docs/docs-add-on/05-api-doc/events/Events.onDocumentChange)
- [Interaction.getData](https://open.feishu.cn/document/client-docs/docs-add-on/05-api-doc/interaction/Interaction.getData)
- [Interaction.setData](https://open.feishu.cn/document/client-docs/docs-add-on/05-api-doc/interaction/Interaction.setData)
- [组件配置](https://open.feishu.cn/document/client-docs/docs-add-on/appjson-configuration-instructions)
- [快速上手](https://open.feishu.cn/document/client-docs/docs-add-on/03-cloud-document-widget-quick-developme)
