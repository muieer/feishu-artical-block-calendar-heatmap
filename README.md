# 飞书云文档日历热力图 MVP

在飞书文档正文中显示 7 行 × 26 列的每日编辑活跃度热力图。从小组件首次成功启用之日起，使用文档 `revision_id` 增量统计活跃度，通过小组件 `Interaction` 持久化，按 T+1 结算历史日期。revision 增量不等同于严格意义上的编辑次数。

当前为开发验证版：包含当天 `pending`、最近 7 个自然日的增量、内存与已保存 revision 展示。停止编辑 10 秒后读取 revision，60 秒后保存到 Interaction；也可分别手动刷新和保存。完整规则、验证步骤及正式使用前的条件见 [开发验证说明](doc/development-verification.md)。

## 开发方式与官方依据

已于 2026-10-01 查阅飞书官方页面：

| 官方文档 | 页面标注的更新时间 | 本项目采用的结论 |
| --- | --- | --- |
| [云文档小组件概述](https://open.feishu.cn/document/client-docs/docs-add-on/docs-add-on-introduction) | 2025-03-17 | 小组件支持标准 Web 技术，框架自由；React 模板只是推荐方案。 |
| [快速上手](https://open.feishu.cn/document/client-docs/docs-add-on/03-cloud-document-widget-quick-developme) | 2026-05-22 | 使用 `@lark-opdev/cli` 的 `opdev` 命令创建、调试和上传 `docs-addon`。 |
| [组件配置](https://open.feishu.cn/document/client-docs/docs-add-on/appjson-configuration-instructions) | 2026-01-08 | `contributes.addPanel` 是正文小组件入口，`view` 指定 HTML 页面。 |
| [安全配置](https://open.feishu.cn/document/client-docs/docs-add-on/cloud-doc-block-security-configuration) | 2025-01-20 | 外部请求受域名白名单限制，文档 API 调用受权限约束。 |
| [常见问题](https://open.feishu.cn/document/uAjLw4CM/uYjL24iN/docs-add-on/faq) | 2025-05-29 | 自建小组件不会自动进入加号面板；用户需要安装。粘贴网页 URL 不会自动转成小组件。 |

项目沿用目录中已有的飞书模板构建工具，移除了 React、TypeScript 和文档字数统计代码。生产包由飞书官方 `docsAddonWebpackPlugin` 生成配置文件，保留官方调试和上传流程。

## 项目结构

```text
.
├── app.example.json         # 可提交的配置模板，不含真实应用标识
├── app.json                 # 本地私有配置，已被 Git 忽略
├── package.json             # 依赖和开发命令
├── package-lock.json        # 锁定依赖版本
├── webpack.config.js        # 官方小组件打包和文档调试接入
├── src/
│   ├── index.html           # 页面结构、星期标签和图例
│   ├── index.js             # 原生 DOM 渲染
│   ├── index.css            # 7 行网格、5 档颜色及横向滚动
│   ├── activity.mjs         # 本地日期、每日统计、T+1 结算和颜色分级
│   ├── tracker.mjs          # 内存统计与 Interaction 保存编排
│   ├── idle.mjs             # 10 秒读取、60 秒保存的闲置调度
│   └── feishu.js            # 飞书 SDK 与 revision 读取适配
├── dev/revision-proxy.cjs   # 开发服务器的 lark-cli revision 代理
├── test/                   # 统计、存储和代理自动化测试
├── doc/                    # 开发验证说明
└── dist/                    # npm run build 生成的可上传程序包
    ├── index.html
    ├── index.js
    ├── index.css
    ├── index.json           # 官方插件生成的小组件配置
    └── project.config.json  # 官方插件生成的工程配置
```

## 安装依赖

在当前项目目录执行：

```sh
npm ci
```

需要重新解析依赖时使用 `npm install`。本项目已生成锁文件，日常安装优先使用 `npm ci`。

## 本地私有配置

仓库只保存 `app.example.json` 模板。首次克隆后，为飞书调试、构建和上传创建本地配置：

```sh
cp app.example.json app.json
```

在 `app.json` 中填写自己的 `appID` 和 `blockTypeID`。`url` 可留空，或填写有编辑权限的调试文档地址。官方工具和构建配置从这个 JSON 文件读取真实配置；文件已被 Git 忽略。现有本地 `app.json` 无需覆盖。

开发验证通过本机已登录的 `lark-cli` 以用户身份读取文档 revision，凭证由 CLI 管理，不打包进小组件。`Interaction` 必须启用：`contributes.addPanel.useInteraction` 为 `true`。本地配置和示例配置已采用该值。

`npm run start:preview` 不依赖私有配置。`npm start`、`npm run build` 和 `npm run upload` 需要填写完整的 `app.json`；缺少配置或必填标识时会给出错误提示。

Git 同时忽略依赖、构建产物、日志、环境文件、证书和本地私有 JSON 文件；`package-lock.json` 和 `app.example.json` 会保留在仓库中。

飞书当前快速上手文档建议 Node.js 版本不高于 18.20.8。本次在现有 Node.js 24.20.0 环境中完成了构建和调试命令验证；如果开发者工具出现兼容问题，先按官方建议切换到 Node.js 18.20.8。

## 本地预览：只检查页面外观

```sh
npm run start:preview
```

打开 [本地热力图](http://127.0.0.1:5173/block/index.html)。

预览不需要飞书账号，也不会创建飞书文档。它只显示小组件自身的页面；在文档正文中的运行效果需要下一节的官方调试流程。

## 飞书文档内调试

### 准备开发工具

如果尚未安装官方 CLI：

```sh
npm install @lark-opdev/cli@latest -g
opdev help
```

如果此前装过旧包 `@bdeefe/opdev-cli`，按官方文档先卸载旧包，避免命令路径冲突：

```sh
npm uninstall @bdeefe/opdev-cli -g
```

官方要求 `opdev >= 3.3.0` 与 `block-docs-addon-webpack-utils >= 1.0.0` 配套。本项目锁定后者为 1.0.1。

开发者登录：

```sh
opdev login
```

按提示选择 Feishu 开发环境并完成登录。这是开发工具登录，小组件本身没有登录功能。官方明确不支持在飞书测试企业中创建和调试。

### 使用当前项目

当前应用的真实标识保存在本地 `app.json` 中。使用拥有该应用开发权限的账号；新克隆的项目需要先按「本地私有配置」一节填写自己的应用标识。

停止本地预览，避免占用同一个端口，然后执行：

```sh
npm start
```

官方工具会打开文档调试页。没有 `app.json.url` 或该字段为空时，工具会创建一篇测试文档并把地址写回本地配置；已有 `url` 时会复用该文档。使用终端输出的调试链接，私有文档地址不保存在 README 中。

开发服务器的 revision 代理需要 `lark-cli` 的用户授权，具体准备步骤见 [开发验证说明](doc/development-verification.md)。浏览器登录飞书、`opdev login` 和 `lark-cli` 用户授权是不同的登录状态。

在启动开发服务器的同一台电脑上，用已登录飞书的浏览器打开调试链接。在可编辑的正文空行点击左侧「+」或输入 `/`，在菜单中查找本地小组件。官方文档说明，本地组件名称为 `blockTypeID`，选择与本地 `app.json.blockTypeID` 相同的条目。

插入后应在正文看到热力图。调试模式下保持开发服务器运行；停止服务器后，本地调试组件无法继续加载本地资源。

若希望在另一篇有编辑权限的文档调试，把该文档 URL 写入 `app.json.url`，重新执行 `npm start`，使用工具输出的调试链接。

## 如何创建对应的开放平台应用

优先使用官方自动创建流程，避免手工猜测应用类型和组件配置。

1. 完成上面的 CLI 安装和 `opdev login`。
2. 在当前项目的父目录执行下面的命令，使用一个新的目录，避免覆盖本项目：

   ```sh
   opdev create docs-heatmap-registration
   ```

3. 按提示选择 `docs-addon` 并完成创建。官方工具会创建小组件，并在终端给出对应的开发者后台链接。
4. 打开终端提供的链接，确认对应的应用和「云文档小组件」能力。
5. 从新项目的 `app.json` 复制真实的 `appID`、`blockTypeID` 到本项目的 `app.json`。保留本项目的 `contributes.addPanel` 配置，勿用模板中的示例业务代码覆盖热力图。
6. 回到本项目，执行 `npm start` 调试，或执行下面的上传命令。

如果当前目录中的应用已经属于你的账号，可以直接使用当前配置，无需重复创建应用。通过开放平台已有应用开启云文档小组件能力时，`appID` 来自应用凭证与基础信息，`blockTypeID` 来自小组件能力；字段来源见官方快速上手的项目配置表。

## 构建、上传和发布

只构建：

```sh
npm run build
```

构建使用官方包支持的 `CI_FLAG=1` 模式生成飞书正式环境的配置，使静态打包不依赖开发者登录。上传和文档调试仍需要 `opdev login`。

上传到 `app.json` 指定的应用：

```sh
npm run upload
```

该命令先构建，再执行 `opdev upload ./dist`。之后在 [飞书开发者后台](https://open.feishu.cn/app) 完成：

1. 进入对应应用的云文档小组件配置。
2. 选择刚上传的程序包，填写小组件基础信息，例如名称「日历热力图」，然后保存。
3. 检查官方安全配置。本版读取 revision 需要文档基本信息读取权限；正式程序包还需要配置可用的 `revisionApiUrl`，并允许该服务的请求域名。开发用的本机代理不能作为正式服务。
4. 在应用发布区域创建版本，设置可用范围使自己的账号可使用，提交发布，并按租户流程完成审核。

用户已实测 Interaction 写入不会改变文档 revision。本版已移除写入前后 revision 一致性检查和相关暂停机制；旧暂停标记不再参与统计。自动保存前若继续编辑则取消本次尝试，已经发出的请求正常完成，下一次闲置后再同步。

## 如何实际插入一篇普通飞书文档

以下是发布版本的使用流程，与本地调试流程分开：

1. 确认程序包已上传，版本已审核发布，自己的账号在应用可用范围内。
2. 在飞书应用市场/小组件入口安装或添加该小组件。官方 FAQ 明确说明，企业自建小组件不会默认进入加号面板，需要由用户安装。
3. 打开一篇有编辑权限的飞书新版文档，在要插入的位置新建正文空行。
4. 点击正文左侧「+」，或输入 `/`，搜索发布时设置的名称「日历热力图」。
5. 选择小组件，将它插入正文。预期显示 182 个自然日格子和「少 → 多」图例。首次启用前日期没有数据，今天标记为 `pending`；成功写入 Interaction 后，刷新保持当天基准和已结算历史。

不要把本地页面 URL 粘贴进正文来代替插入小组件；官方 FAQ 明确不支持把粘贴 URL 自动识别为小组件。

若菜单找不到组件，先检查是否已安装、是否已发布，以及当前账号是否在可用范围内。代码构建成功和程序包上传成功都不能替代版本发布。

## 验证范围

执行自动化测试：

```sh
npm test
```

当前测试覆盖首次启用、同日重复加载、T+1 结算、多日补零、revision 回退、本地时区、颜色分级、内存与持久化分离、10 秒／60 秒闲置调度、保存前取消及保存中继续编辑，以及本地 revision 代理。

原静态 MVP 的构建、发布和正文显示已由用户确认。本次改动的文档内验收需重新执行，不能沿用静态版本的验收结论。重点检查真实 revision 读取、刷新后基准保持、调试面板完整显示及闲置读取与保存时序。操作和预期结果见 [开发验证说明](doc/development-verification.md)。
