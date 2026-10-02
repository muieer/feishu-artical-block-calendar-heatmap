# 日历热力图开发验证

本版从首次成功读取文档 revision 和 Interaction 数据时在内存中建立统计基准；首次保存后，该基准可跨页面加载保留。每日已结算增量、首次启用日期、当前统计日期、当天基准和最新 revision 均保存在小组件 `Interaction` 中。浏览器本地存储不参与统计。

## 统计规则

- 每格一个用户本地自然日。今天由浏览器本地时区确定；日历日期加减采用日期标签计算，避免夏令时导致日期重复或缺失。
- 同一天反复加载或刷新，只更新最新 revision，保留当天首次记录的基准。
- 今天的实时增量为最新 revision 减去当天基准，标记 `pending`，不写入已结算历史。今天显示灰色并带蓝色轮廓；只有已结算的活跃日使用绿色。
- 首次在后续日期加载时，用当前 revision 减去上一统计日的基准，结算上一统计日。中间没有加载的自然日记为 `0`，今天建立新基准并保持 `pending`。
- 启用前日期的状态为 `no-data`，与增量为零的 `settled` 日期区分；未来日期为 `future`。
- 如果 revision 低于基准或上次已观察的最新 revision，重建今天的基准，保留已结算历史。由于无法可靠计算旧的未结算区间，该区间保留为无数据。
- 本地日期早于保存的统计日期时暂停结算，不修改保存的数据。检查时区或系统日期后重试。
- 历史颜色使用正增量的最近秩四分位数：第 25%、50%、75% 分位值为三个阈值，对应 4 档绿色。相同增量使用相同颜色；样本较少或重复值较多时，部分档位可以为空。零增量永远灰色。增加历史只重算颜色，不改变原始历史增量。

例如：10 月 1 日首次读取 revision `100`，当天再次读取 `120`，实时增量为 `20`。10 月 4 日首次读取 `150` 时，10 月 1 日结算为 `50`，10 月 2 日和 3 日为 `0`；10 月 4 日的基准为 `150`，实时增量为 `0`，状态为 `pending`。这是约定的观测和结算口径，不代表能还原各日的真实编辑次数。

## Interaction 数据

业务数据保存在 `revisionHeatmapV1`：

```json
{
  "version": 1,
  "startedOn": "2026-10-01",
  "currentDate": "2026-10-04",
  "baselineRevision": 150,
  "latestRevision": 150,
  "history": {
    "2026-10-01": 50,
    "2026-10-02": 0,
    "2026-10-03": 0
  }
}
```

旧版 `revisionHeatmapProbe` 和 `revisionHeatmapWriteGuard` 不再读取或写入；已有暂停标记不会阻止统计。数据格式损坏时报告错误并保留原数据，不静默清空统计。正常统计不修改 `Record` 或正文。

## 开发环境准备

1. 本机安装 `lark-cli`，完成用户身份授权。已有授权时可以跳过登录；需要新增授权时，在终端执行：

   ```sh
   lark-cli auth login --scope docx:document:readonly
   ```

2. 在本机终端确认授权和读取权限：

   ```sh
   lark-cli auth status --json --verify
   lark-cli api GET /open-apis/docx/v1/documents/<document_id> --as user --format json
   ```

   文档接口成功信封的 `ok` 为 `true`，revision 位于 `data.document.revision_id`。浏览器飞书登录、`opdev login` 和 CLI 用户授权各自独立。

3. 检查本地 `app.json`：`useInteraction` 为 `true`；`url` 指向有读取和插入小组件权限的目标 docx 文档。Wiki 文档额外填写底层 docx token 为 `revisionDocumentId`。代理只读取这个配置中的文档，拒绝其他 token。

4. 执行 `npm start`，按 README 的飞书调试步骤打开并插入小组件。revision 代理地址为 `http://localhost:5173/__heatmap/revision`，通过本机 `lark-cli` 请求飞书文档基本信息，只返回 `revision_id`。浏览器和小组件安全配置需允许本地调试请求；若宿主或浏览器拦截，先解决请求限制。

`npm run start:preview` 仅用于外观检查，不连接飞书，也不生成假历史。

## 文档内人工验收

1. 首次加载：内存 revision 与当天基准一致；Interaction 未保存时显示「—」。闲置 60 秒或手动保存后，两种 revision 一致；实时增量为 `0`；当前日期为本地今天；当天为 `pending`，启用前日期为无数据。
2. 同日编辑后刷新：最新 revision 更新，当天基准不变；实时增量随 revision 增加。点击保存或等待闲置 60 秒后，刷新页面或重新打开文档，基准和历史仍保持。
3. 隔日首次加载：前一天结算为当前 revision 减去前一天基准，今天另建基准并标记 `pending`。今天再次编辑不会改变前一天的原始结算增量。
4. 跨多日后加载：最后一次加载的统计日正常结算，中间未加载日为 `0`，当天保持 `pending`。
5. 检查调试面板：最新 revision、基准、实时增量、统计日期和最近 7 个自然日均可见。失败时显示错误，不将缺失 revision 当成零。窄屏可横向滚动图表，面板高度不会被容器裁切。

跨日、回退和时区场景已有自动化测试；真实 SDK 和宿主效果仍需在飞书内验证。当前单实例会串行化刷新和保存操作；多用户或多实例同时修改同一 Interaction 的冲突行为尚未实测，开发验证应先使用单实例。

## 闲置更新与保存验收

用户已实测 Interaction 写入不会改变文档 revision。本版移除自动保存前后的 revision 一致性检查、写入探针和持久化暂停逻辑。

1. 持续编辑：每次文档变化事件重置闲置窗口，不自动更新内存 revision 或保存 Interaction。
2. 停止编辑 10 秒：读取并展示内存 revision；Interaction 已保存 revision 保持原值。
3. 从最后一次编辑起闲置 60 秒：重新读取最新 revision 并保存完整统计状态，成功后更新 Interaction 已保存 revision。
4. 尚未发出保存请求时继续编辑：取消本次尝试，重新等待 10 秒读取、60 秒保存。读取过程中若收到编辑事件，也不应用过期的自动读取结果。
5. 保存请求发出后继续编辑：允许本次请求完成，不回滚、不暂停；下一次闲置后保存最新状态。
6. 点击「刷新 revision」：立即读取并更新内存展示，不写入 Interaction。点击「最新 revision 保存到 Interaction」：立即尝试读取最新 revision 并保存；请求发出前若收到新的编辑事件，延后到下一次闲置保存。
7. 跨日首次成功观察在内存中结算前一天；后续读取和延迟保存保留这份结算，不把后续编辑追加到前一天。
8. 保存失败：报告错误，Interaction 已保存 revision 不更新。点击保存可重试；继续编辑后的下一次闲置也会再次尝试。

初始化会立即读取一次数据，但不立即保存。页面重新可见时重新启动闲置窗口。闲置以收到的文档变化事件为准；计时器到期后还需等待 API 请求完成。保存前关闭页面会丢失尚未持久化的内存状态，可先点击保存。

## Interaction 读取失败

`getActiveBlock().data.component_id` 为空不能用于判断 Interaction 是否可用。2026-10-02 在测试文档中移除该前置检查后，现有组件成功读取并保存统计数据，页面显示最新 revision 和当日基准均为 `14`、当日实时增量为 `0`。此前将空字段和读取超时归因为缺少互动存储的判断不成立。 随后执行真实写入探针，页面显示 `14 → 14 · 本次写入前后未变化`；组件重新加载后基准仍为 `14`。

组件直接调用 `Interaction.getData` 和 `Interaction.setData`，以实际调用结果判断存储是否可用。SDK 仅由 `BlockitClient` 构造函数初始化一次，避免重复注册。

遇到读取失败或超时，最新 revision 仍会独立读取并展示。未读取到的数据保持未知，不建立或重置基准，不写入数据，不生成历史结算。已有界面数据只保留作参考；跨日失败时不展示旧基准对应的“当日增量”。同日失败不触发每 30 秒的自动重试；可点击刷新按钮重试。

恢复步骤：

1. 保持 `npm start` 运行，在 Chrome 调试文档中刷新页面。
2. 确认调试服务加载了最新代码。旧版的 `component_id` 空值提示是前置检查误判；刷新原组件即可重试，无需因此重新插入。
3. 首次成功加载且尚无统计数据时，检查基准等于最新 revision、实时增量为 `0`、今天为 `pending`。已有统计数据时，应保留原基准和历史。
4. 点击「最新 revision 保存到 Interaction」，确认已保存 revision 更新。刷新页面确认当天基准仍不变。
5. 如果仍然超时，保留现有数据，继续检查宿主配置与请求错误；不能把超时转换为空数据，或切换到 `Record` / 浏览器存储继续结算。

## 构建与正式服务边界

`npm test` 验证统计与存储编排；`npm run build` 生成小组件包。构建成功不代表真实 SDK 读写、宿主请求权限或闲置调度的文档内验收已经通过。

本地 CLI 代理只用于开发。正式服务需实现与用户和文档权限匹配的 revision 读取，并在本地 `app.json` 配置 `revisionApiUrl`。小组件向该地址发起 `GET`，传入查询参数 `documentId`，预期 JSON 为 `{"revision_id": 150}`。地址会打包进前端，应为公开的服务地址，不能包含 token、密钥或其他凭证；服务必须自行鉴权并限制允许读取的文档。

未配置 `revisionApiUrl` 的正式程序包会显示缺少 revision API 的错误，不能上传后直接作为正式统计版使用。先在开发环境验证，再准备正式服务和发布配置。

## 官方依据

- [云文档小组件 API 概览](https://open.feishu.cn/document/client-docs/docs-add-on/05-api-doc/05-api-doc)：SDK、文档引用和持久化能力。
- [Interaction.setData](https://open.feishu.cn/document/client-docs/docs-add-on/05-api-doc/interaction/Interaction.setData)：按路径替换互动数据。
- [获取文档基本信息](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/get)：通过文档 OpenAPI 获取 `revision_id`。
- [组件配置](https://open.feishu.cn/document/client-docs/docs-add-on/appjson-configuration-instructions)：`useInteraction` 位于 `contributes.addPanel` 中。
