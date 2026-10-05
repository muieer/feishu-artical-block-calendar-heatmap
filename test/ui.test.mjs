import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as activity from '../src/activity.mjs';
import { createTracker } from '../src/tracker.mjs';
import { createIdleScheduler } from '../src/idle.mjs';
import { createInteractionStorage } from '../src/interaction.mjs';
import * as contribution from '../src/contribution.mjs';

async function uiFixture({ startedOn = '2026-10-03', savedData, readGate, failRead = false, preview = false, writeGate } = {}) {
  let clock = 0;
  const epoch = new Date(2026, 9, 3, 12).getTime();
  const dateNow = () => new Date(epoch + clock);
  const today = activity.localDate(dateNow());
  const elements = new Map();
  function element() {
    const classes = new Set();
    const handlers = new Map();
    const attributes = new Map();
    let text = '';
    return { children: [], rebuilds: 0, dataset: {}, style: { setProperty() {}, getPropertyValue() { return ''; } }, clientWidth: 768, scrollWidth: 0, scrollLeft: 0,
      addEventListener: (name, handler) => handlers.set(name, handler),
      click() { if (!this.disabled) handlers.get('click')?.(); },
      get textContent() { return text; }, set textContent(value) { text = String(value); },
      replaceChildren() { this.rebuilds += 1; this.children = []; }, append(child) { this.children.push(child); },
      setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name),
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } };
  }
  function getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }
  let nextId = 0;
  const timers = new Map();
  const setTimer = (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: clock + delay }); return id; };
  const clearTimer = id => timers.delete(id);
  const windowEvents = new Map();
  const documentEvents = new Map();
  let data = savedData ?? (startedOn === today ? { obsoleteStatistics: { count: 100 } }
    : { [activity.STATE_KEY]: activity.advanceActivity(undefined, startedOn).state });
  const context = { failWrite: false, writes: 0, calendarCalls: 0, thresholdCalls: 0 };
  let changeHandler;
  const storage = createInteractionStorage({ Interaction: {
    getData: async () => {
      if (readGate) await readGate;
      if (failRead) throw new Error('read unavailable');
      return structuredClone(data);
    },
    setData: async change => {
      context.writes += 1;
      if (writeGate) await writeGate(change, context.writes);
      if (context.failWrite) throw new Error('storage unavailable');
      assert.deepEqual(change.data.path, []);
      data = structuredClone(change.data.value);
      return data;
    },
  } });
  const host = { ...storage, listen: async handler => { changeHandler = handler; return () => {}; }, resize: async () => {}, destroy() {} };
  const source = (await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, {
    ...activity, ...contribution, localDate: () => activity.localDate(dateNow()),
    calendarPage: (...args) => { context.calendarCalls += 1; return activity.calendarPage(...args); },
    colorThresholds: (...args) => { context.thresholdCalls += 1; return activity.colorThresholds(...args); },
    createTracker: options => {
      context.publish = options.onChange;
      context.tracker = createTracker({ ...options, now: dateNow });
      return context.tracker;
    },
    createIdleScheduler: options => createIdleScheduler({ ...options, now: () => dateNow().getTime(), dateNow, setTimer, clearTimer, createId: () => `ui-session-${++nextId}` }),
    connectFeishu: async () => host, LOCAL_PREVIEW: preview,
    document: { getElementById, createElement: element, querySelector: selector => getElementById(selector),
      addEventListener: (name, handler) => documentEvents.set(name, handler), removeEventListener: name => documentEvents.delete(name) },
    window: { addEventListener: (name, handler) => windowEvents.set(name, handler) },
    ResizeObserver: class { constructor(callback) { context.resize = callback; } observe() {} disconnect() {} },
    requestAnimationFrame: fn => setTimer(fn, 16), cancelAnimationFrame: clearTimer,
    setTimeout: setTimer, clearTimeout: clearTimer, setInterval: () => ++nextId, clearInterval() {},
  }, { filename: 'src/index.js' });
  async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
  async function advance(ms) {
    const target = clock + ms;
    while (true) {
      const item = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) break;
      clock = Math.max(clock, item[1].at);
      timers.delete(item[0]);
      item[1].fn();
      await flush();
    }
    clock = target;
    await flush();
  }
  return { today, context, getElementById, flush, advance, data: () => data,
    edit: () => changeHandler({ changes: [{ type: 'update', blockId: 1 }] }),
    visible: () => documentEvents.get('visibilitychange')?.(),
    rule: minutes => getElementById('contribution-rules').children.find(button => Number(button.dataset.minutes) === minutes),
    close: async () => { windowEvents.get('pagehide')(); await flush(); } };
}

function chartSnapshot(f) {
  return { calendarCalls: f.context.calendarCalls, thresholdCalls: f.context.thresholdCalls,
    regions: ['heatmap', 'months', 'recent-days'].map(id => {
      const element = f.getElementById(id);
      return { id, rebuilds: element.rebuilds, nodes: [...element.children] };
    }) };
}

function assertChartUnchanged(f, before) {
  assert.equal(f.context.calendarCalls, before.calendarCalls, 'unchanged display skips calendar generation');
  assert.equal(f.context.thresholdCalls, before.thresholdCalls, 'unchanged display skips threshold calculation');
  for (const { id, rebuilds, nodes } of before.regions) {
    const element = f.getElementById(id);
    assert.equal(element.rebuilds, rebuilds, `${id} is not rebuilt`);
    assert.equal(element.children.length, nodes.length);
    nodes.forEach((node, index) => assert.equal(element.children[index], node, `${id} retains node ${index}`));
  }
}

function assertChartRebuiltOnce(f, before) {
  assert.equal(f.context.calendarCalls, before.calendarCalls + 1);
  assert.equal(f.context.thresholdCalls, before.thresholdCalls + 1);
  for (const { id, rebuilds, nodes } of before.regions) {
    const element = f.getElementById(id);
    assert.equal(element.rebuilds, rebuilds + 1, `${id} is rebuilt once`);
    assert.notEqual(element.children[0], nodes[0]);
  }
}

for (const startedOn of ['2026-10-03', '2026-09-01', '2025-09-27', '2024-09-21']) {
test(`页面从启用周展开：${startedOn}；计数和失败重试正常`, async () => {
  const { today, context, getElementById, flush, advance, data, edit, close } = await uiFixture({ startedOn });
  await flush();
  assert.equal(getElementById('heatmap').children.length, 371);
  const cells = getElementById('heatmap').children;
  const page = activity.calendarPage(startedOn, today);
  assert.equal(cells[0].dataset.date, page.dates[0]);
  const enabledIndex = cells.findIndex(cell => cell.dataset.date === startedOn);
  if (page.pageCount === 1) assert.ok(enabledIndex >= 0 && enabledIndex < 7);
  const todayIndex = cells.findIndex(cell => cell.dataset.date === today);
  assert.equal(cells[todayIndex].dataset.status, 'pending');
  assert.equal(cells[todayIndex].className, 'cell level-0 pending');
  assert.ok(cells.slice(todayIndex + 1).every(cell => cell.dataset.status === 'future'));
  assert.ok(getElementById('months').children.length >= 12);
  assert.ok(getElementById('months').children.some(label => /年1月/.test(label.textContent)));
  assert.equal(getElementById('pagination').hidden, page.pageCount === 1);
  assert.equal(getElementById('page-number').textContent, `1 / ${page.pageCount}`);
  assert.equal(getElementById('newer-page').disabled, true);
  assert.equal(getElementById('older-page').disabled, page.pageCount === 1);
  assert.equal(getElementById('contribution-summary').textContent, '最近一年共有 0 次编辑');
  assert.equal(getElementById('recent-days').children.length, 7);
  assert.equal(getElementById('baseline-contributions').textContent, '0');
  assert.equal(getElementById('latest-contributions').textContent, '0');
  assert.equal(getElementById('saved-contributions').textContent, '0');
  assert.match(getElementById('status').textContent, /编辑文档后，会自动记录编辑次数/);
  assert.equal(cells[todayIndex].title, `${today}：编辑次数 0 · 统计中`);
  assert.match(getElementById('heatmap').getAttribute('aria-label'), /蓝色轮廓表示今日次数仍在更新/);
  assert.equal(getElementById('recent-days').children.at(-1).children[2].textContent, '统计中');
  assert.deepEqual(Object.keys(data()), [activity.STATE_KEY]);
  context.failWrite = true;
  edit();
  assert.equal(getElementById('status').textContent, '已检测到编辑。停止编辑 10 秒后，会记录并保存本次编辑次数。');
  await advance(9999);
  assert.equal(getElementById('latest-contributions').textContent, '0');
  await advance(1);
  assert.equal(getElementById('latest-contributions').textContent, '1');
  assert.equal(getElementById('contribution-summary').textContent, '最近一年共有 1 次编辑');
  assert.equal(getElementById('saved-contributions').textContent, '0');
  assert.equal(getElementById('heatmap').children[todayIndex].className, 'cell level-1 pending');
  assert.equal(getElementById('status').classList.contains('error'), true);
  context.failWrite = false;
  await advance(10000);
  assert.equal(getElementById('latest-contributions').textContent, '1');
  assert.equal(getElementById('saved-contributions').textContent, '1');
  assert.equal(getElementById('live-delta').textContent, '1');
  assert.equal(getElementById('heatmap').children[todayIndex].className, 'cell level-1 pending');
  assert.equal(getElementById('recent-days').children.at(-1).children[1].textContent, '1');
  assert.match(getElementById('status').textContent, /本次编辑次数已保存/);
  edit();
  await advance(10000);
  assert.equal(getElementById('latest-contributions').textContent, '1');
  await advance(50000);
  assert.equal(getElementById('latest-contributions').textContent, '1');
  assert.equal(data()[activity.STATE_KEY].pendingContribution, undefined);
  if (page.pageCount > 1) {
    getElementById('.chart-scroll').scrollLeft = 100;
    getElementById('older-page').click();
    assert.equal(getElementById('.chart-scroll').scrollLeft, 0);
    assert.equal(getElementById('page-number').textContent, `2 / ${page.pageCount}`);
    const historicalDates = getElementById('heatmap').children.map(cell => cell.dataset.date);
    assert.deepEqual(historicalDates, activity.calendarPage(startedOn, today, 1).dates);
    assert.equal(getElementById('newer-page').disabled, false);
    // A new contribution re-renders the selected historical page without jumping to today.
    edit();
    await advance(10000);
    assert.equal(getElementById('live-delta').textContent, '2');
    assert.equal(getElementById('page-number').textContent, `2 / ${page.pageCount}`);
    assert.deepEqual(getElementById('heatmap').children.map(cell => cell.dataset.date), historicalDates);
    while (!getElementById('older-page').disabled) getElementById('older-page').click();
    assert.equal(getElementById('page-number').textContent, `${page.pageCount} / ${page.pageCount}`);
    const oldestDates = activity.calendarPage(startedOn, today, page.pageCount - 1).dates;
    assert.equal(getElementById('heatmap').children[0].dataset.date, oldestDates[0]);
    assert.equal(getElementById('heatmap').children.length, 371);
    assert.ok(getElementById('heatmap').children.some(cell => cell.dataset.date === startedOn));
    getElementById('older-page').click();
    assert.equal(getElementById('heatmap').children[0].dataset.date, oldestDates[0]);
    while (!getElementById('newer-page').disabled) getElementById('newer-page').click();
    assert.equal(getElementById('page-number').textContent, `1 / ${page.pageCount}`);
    assert.equal(getElementById('heatmap').children[todayIndex].className, 'cell level-1 pending');
  }
  await close();
});
}

test('六档按钮默认选中 1 分钟，切换更新文案、存储和当前计时', async () => {
  const f = await uiFixture();
  await f.flush();
  assert.deepEqual(f.getElementById('contribution-rules').children.map(button => button.textContent),
    contribution.CONTRIBUTION_IDLE_MINUTES.map(minutes => `${minutes} 分钟`));
  assert.equal(f.rule(1).disabled, true);
  assert.equal(f.rule(1).getAttribute('aria-pressed'), 'true');
  assert.equal(f.rule(3).disabled, false);
  const initialWrites = f.context.writes;
  f.rule(1).click();
  await f.flush();
  assert.equal(f.context.writes, initialWrites);
  f.edit();
  await f.advance(10000);
  f.rule(3).click();
  await f.flush();
  assert.equal(f.rule(3).disabled, true);
  assert.equal(f.rule(1).disabled, false);
  assert.equal(f.rule(1).getAttribute('aria-pressed'), 'false');
  assert.equal(f.data()[activity.STATE_KEY].contributionIdleMinutes, 3);
  assert.match(f.getElementById('contribution-rule-explanation').textContent, /未满 3 分钟.*达到 3 分钟/);
  assert.match(f.getElementById('status').textContent, /设置已保存.*3 分钟.*本次编辑次数已保存.*3 分钟/);
  assert.doesNotMatch(f.getElementById('status').textContent, /已结束/);
  await f.advance(60000);
  assert.ok(f.data()[activity.STATE_KEY].pendingContribution);
  f.rule(1).click();
  await f.flush();
  assert.equal(f.data()[activity.STATE_KEY].pendingContribution, undefined);
  assert.equal(f.data()[activity.STATE_KEY].latestContributions, 1);
  assert.equal(f.getElementById('idle-seconds').textContent, '—');
  f.edit();
  assert.match(f.getElementById('status').textContent, /停止编辑 10 秒后/);
  await f.advance(10000);
  assert.equal(f.data()[activity.STATE_KEY].latestContributions, 2);
  await f.close();
});

test('配置保存失败保留选择和错误，10 秒后自动重试保存最新规则', async () => {
  const f = await uiFixture();
  await f.flush();
  f.context.failWrite = true;
  f.rule(30).click();
  await f.flush();
  assert.equal(f.rule(30).disabled, true);
  assert.equal(f.data()[activity.STATE_KEY].contributionIdleMinutes, 1);
  assert.match(f.getElementById('contribution-rule-explanation').textContent, /30 分钟/);
  assert.equal(f.getElementById('status').textContent, 'storage unavailable');
  f.rule(5).click();
  await f.flush();
  assert.equal(f.rule(5).disabled, true);
  assert.equal(f.getElementById('status').textContent, 'storage unavailable');
  f.context.failWrite = false;
  await f.advance(9999);
  assert.equal(f.data()[activity.STATE_KEY].contributionIdleMinutes, 1);
  await f.advance(1);
  assert.equal(f.data()[activity.STATE_KEY].contributionIdleMinutes, 5);
  assert.equal(f.data()[activity.STATE_KEY].latestContributions, 0);
  assert.equal(f.getElementById('status').classList.contains('error'), false);
  assert.match(f.getElementById('status').textContent, /设置已保存.*5 分钟/);
  const reopened = await uiFixture({ savedData: f.data() });
  await reopened.flush();
  assert.equal(reopened.rule(5).disabled, true);
  assert.equal(reopened.rule(5).getAttribute('aria-pressed'), 'true');
  assert.match(reopened.getElementById('contribution-rule-explanation').textContent, /5 分钟/);
  await f.close();
  await reopened.close();
});

test('加载期间及读取失败禁用所有配置按钮，本地预览切换仅修改页面', async () => {
  let release;
  const readGate = new Promise(resolve => { release = resolve; });
  const loading = await uiFixture({ readGate });
  await loading.flush();
  assert.ok(loading.getElementById('contribution-rules').children.every(button => button.disabled));
  release();
  await loading.flush();
  assert.equal(loading.rule(3).disabled, false);
  const failed = await uiFixture({ failRead: true });
  await failed.flush();
  assert.ok(failed.getElementById('contribution-rules').children.every(button => button.disabled));
  assert.equal(failed.context.writes, 0);
  assert.equal(failed.getElementById('status').textContent, 'read unavailable');
  const invalid = await uiFixture({ savedData: { [activity.STATE_KEY]: [] } });
  await invalid.flush();
  assert.equal(invalid.getElementById('status').textContent, '编辑记录格式有误，原有记录已保留。');
  assert.equal(invalid.context.writes, 0);
  const preview = await uiFixture({ preview: true });
  await preview.flush();
  preview.rule(60).click();
  assert.equal(preview.rule(60).disabled, true);
  assert.match(preview.getElementById('status').textContent, /60 分钟.*不会保存到飞书/);
  assert.match(preview.getElementById('contribution-rule-explanation').textContent, /60 分钟/);
  assert.equal(preview.context.writes, 0);
  await loading.close();
  await failed.close();
  await invalid.close();
  await preview.close();
});

test('缩短规则在慢网络保存完成前结束当前计时，确认接续原贡献', async () => {
  let release;
  let block = false;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await uiFixture({ writeGate: async () => { if (block) await gate; } });
  await f.flush();
  f.rule(3).click();
  await f.flush();
  f.edit();
  await f.advance(90000);
  block = true;
  f.rule(1).click();
  await f.flush();
  assert.equal(f.rule(1).disabled, true);
  assert.equal(f.getElementById('idle-seconds').textContent, '—');
  assert.match(f.getElementById('contribution-rule-explanation').textContent, /停止编辑达到 1 分钟/);
  assert.equal(f.data()[activity.STATE_KEY].contributionIdleMinutes, 3);
  release();
  await f.flush();
  assert.equal(f.data()[activity.STATE_KEY].contributionIdleMinutes, 1);
  assert.equal(f.data()[activity.STATE_KEY].pendingContribution, undefined);
  assert.equal(f.data()[activity.STATE_KEY].latestContributions, 1);
  await f.close();
});

test('首次加载与贡献变化各更新一次，慢保存成功仅更新保存指标', async () => {
  let releaseRead;
  let releaseWrite;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const f = await uiFixture({ readGate, writeGate: async (_, count) => { if (count === 2) await writeGate; } });
  await f.flush();
  assert.equal(f.getElementById('heatmap').rebuilds, 1);
  const loading = chartSnapshot(f);
  releaseRead();
  await f.flush();
  assertChartRebuiltOnce(f, loading);
  assert.equal(f.getElementById('heatmap').children.length, 371);
  const loaded = chartSnapshot(f);
  f.edit();
  await f.advance(9999);
  assertChartUnchanged(f, loaded);
  await f.advance(1);
  assertChartRebuiltOnce(f, loaded);
  assert.equal(f.getElementById('latest-contributions').textContent, '1');
  assert.equal(f.getElementById('saved-contributions').textContent, '0');
  const presaved = chartSnapshot(f);
  releaseWrite();
  await f.flush();
  assertChartUnchanged(f, presaved);
  assert.equal(f.getElementById('saved-contributions').textContent, '1');
  assert.match(f.getElementById('status').textContent, /编辑次数已保存.*本次编辑次数已保存/);
  await f.close();
});

test('预保存后的连续编辑、重复预保存与最终确认保留节点，编辑时间仍写入', async () => {
  const f = await uiFixture();
  await f.flush();
  f.edit();
  await f.advance(10000);
  const before = chartSnapshot(f);
  const original = f.data()[activity.STATE_KEY].pendingContribution;
  const writes = f.context.writes;
  for (let i = 0; i < 20; i += 1) {
    await f.advance(200);
    f.edit();
    await f.flush();
    assertChartUnchanged(f, before);
    assert.equal(f.getElementById('idle-seconds').textContent, '0');
    assert.match(f.getElementById('status').textContent, /本次编辑次数已保存/);
  }
  const latest = f.data()[activity.STATE_KEY].pendingContribution;
  assert.equal(latest.id, original.id);
  assert.equal(latest.lastChangedAt, original.lastChangedAt + 14000);
  assert.equal(f.context.writes, writes + 20);
  await f.advance(10000);
  assertChartUnchanged(f, before);
  await f.advance(50000);
  assertChartUnchanged(f, before);
  assert.equal(f.data()[activity.STATE_KEY].pendingContribution, undefined);
  assert.equal(f.data()[activity.STATE_KEY].latestContributions, 1);
  assert.equal(f.getElementById('idle-seconds').textContent, '—');
  assert.match(f.getElementById('status').textContent, /编辑文档后，会自动记录编辑次数/);
  f.edit();
  await f.advance(10000);
  assertChartRebuiltOnce(f, before);
  assert.equal(f.getElementById('live-delta').textContent, '2');
  await f.close();
});

test('贡献保存失败与重试不重复重建，指标和错误状态照常更新', async () => {
  const f = await uiFixture();
  await f.flush();
  const initial = chartSnapshot(f);
  f.context.failWrite = true;
  f.edit();
  await f.advance(10000);
  assertChartRebuiltOnce(f, initial);
  const failed = chartSnapshot(f);
  assert.equal(f.getElementById('saved-contributions').textContent, '0');
  assert.equal(f.getElementById('status').classList.contains('error'), true);
  await f.advance(10000);
  assertChartUnchanged(f, failed);
  f.context.failWrite = false;
  await f.advance(10000);
  assertChartUnchanged(f, failed);
  assert.equal(f.getElementById('saved-contributions').textContent, '1');
  assert.equal(f.getElementById('status').classList.contains('error'), false);
  await f.close();
});

test('配置切换、失败重试和本地预览不重建，缩短规则确认原贡献也不重建', async () => {
  const f = await uiFixture();
  await f.flush();
  f.edit();
  await f.advance(10000);
  const before = chartSnapshot(f);
  f.rule(3).click();
  await f.flush();
  assertChartUnchanged(f, before);
  assert.equal(f.rule(3).disabled, true);
  f.context.failWrite = true;
  f.rule(30).click();
  await f.flush();
  assertChartUnchanged(f, before);
  assert.equal(f.rule(30).getAttribute('aria-pressed'), 'true');
  assert.match(f.getElementById('contribution-rule-explanation').textContent, /30 分钟/);
  assert.equal(f.getElementById('status').textContent, 'storage unavailable');
  f.context.failWrite = false;
  await f.advance(10000);
  assertChartUnchanged(f, before);
  assert.equal(f.data()[activity.STATE_KEY].contributionIdleMinutes, 30);
  assert.match(f.getElementById('status').textContent, /设置已保存.*30 分钟/);
  await f.advance(50000);
  f.rule(1).click();
  await f.flush();
  assertChartUnchanged(f, before);
  assert.equal(f.data()[activity.STATE_KEY].pendingContribution, undefined);
  assert.equal(f.getElementById('idle-seconds').textContent, '—');
  const preview = await uiFixture({ preview: true });
  await preview.flush();
  assert.equal(preview.getElementById('heatmap').rebuilds, 1);
  const previewBefore = chartSnapshot(preview);
  preview.rule(60).click();
  assertChartUnchanged(preview, previewBefore);
  assert.equal(preview.rule(60).disabled, true);
  assert.match(preview.getElementById('status').textContent, /60 分钟.*不会保存到飞书/);
  await f.close();
  await preview.close();
});

test('跨日结算只更新一次，重复日期检查与保存保持节点', async () => {
  const f = await uiFixture({ startedOn: '2025-09-27' });
  await f.flush();
  f.edit();
  await f.advance(60000);
  const before = chartSnapshot(f);
  await f.advance(86400000);
  f.visible();
  await f.flush();
  assertChartRebuiltOnce(f, before);
  const nextDay = '2026-10-04';
  const cells = f.getElementById('heatmap').children;
  assert.equal(cells.find(cell => cell.dataset.date === f.today).className, 'cell level-1 settled');
  assert.equal(cells.find(cell => cell.dataset.date === nextDay).className, 'cell level-0 pending');
  assert.equal(f.getElementById('contribution-summary').textContent, '最近一年共有 1 次编辑');
  assert.equal(f.getElementById('baseline-contributions').textContent, '1');
  assert.equal(f.getElementById('live-delta').textContent, '0');
  const rows = f.getElementById('recent-days').children;
  assert.equal(rows.at(-2).children[2].textContent, '已完成');
  assert.equal(rows.at(-1).children[0].textContent, nextDay);
  assert.equal(rows.at(-1).children[1].textContent, '0');
  assert.equal(rows.at(-1).children[2].textContent, '统计中');
  const settled = chartSnapshot(f);
  f.visible();
  await f.context.tracker.rollover();
  await f.flush();
  assertChartUnchanged(f, settled);
  await f.close();
});

test('历史按内容比较，键顺序不影响渲染，零记录与缺失记录区分，页外历史影响颜色', async () => {
  const f = await uiFixture({ startedOn: '2024-09-21' });
  await f.flush();
  f.edit();
  await f.advance(60000);
  f.edit();
  await f.advance(60000);
  const before = chartSnapshot(f);
  const snapshot = f.context.tracker.snapshot();
  snapshot.state.history = Object.fromEntries(Object.entries(snapshot.state.history).reverse());
  f.context.publish(structuredClone(snapshot));
  assertChartUnchanged(f, before);
  const offPage = snapshot.state.startedOn;
  assert.ok(!f.getElementById('heatmap').children.some(cell => cell.dataset.date === offPage));
  snapshot.state.history[offPage] = 1;
  snapshot.state.baselineContributions = 1;
  snapshot.state.latestContributions = 3;
  activity.validateState(snapshot.state);
  f.context.publish(structuredClone(snapshot));
  assertChartRebuiltOnce(f, before);
  const withHistory = chartSnapshot(f);
  assert.equal(f.getElementById('heatmap').children.find(cell => cell.dataset.date === f.today).className, 'cell level-4 pending');
  snapshot.state.history[offPage] = 0;
  snapshot.state.baselineContributions = 0;
  snapshot.state.latestContributions = 2;
  f.context.publish(structuredClone(snapshot));
  assertChartRebuiltOnce(f, withHistory);
  assert.equal(f.getElementById('heatmap').children.find(cell => cell.dataset.date === f.today).className, 'cell level-1 pending');
  const zeroHistory = chartSnapshot(f);
  const zeroDate = activity.addDays(f.today, -1);
  assert.equal(f.getElementById('heatmap').children.find(cell => cell.dataset.date === zeroDate).dataset.status, 'settled');
  delete snapshot.state.history[zeroDate];
  f.context.publish(structuredClone(snapshot));
  assertChartRebuiltOnce(f, zeroHistory);
  assert.equal(f.getElementById('heatmap').children.find(cell => cell.dataset.date === zeroDate).dataset.status, 'no-data');
  const missingHistory = chartSnapshot(f);
  snapshot.state.history[zeroDate] = 0;
  f.context.publish(structuredClone(snapshot));
  assertChartRebuiltOnce(f, missingHistory);
  const restoredHistory = chartSnapshot(f);
  f.context.publish(structuredClone(snapshot));
  assertChartUnchanged(f, restoredHistory);
  await f.close();
});

test('切页重建一次，历史页贡献更新保留页码，返回最新页展示新贡献', async () => {
  const f = await uiFixture({ startedOn: '2024-09-21' });
  await f.flush();
  const latest = chartSnapshot(f);
  f.getElementById('.chart-scroll').scrollLeft = 100;
  f.getElementById('older-page').click();
  assertChartRebuiltOnce(f, latest);
  assert.equal(f.getElementById('.chart-scroll').scrollLeft, 0);
  const historical = chartSnapshot(f);
  const dates = f.getElementById('heatmap').children.map(cell => cell.dataset.date);
  const pageNumber = f.getElementById('page-number').textContent;
  f.edit();
  await f.advance(10000);
  assertChartRebuiltOnce(f, historical);
  assert.equal(f.getElementById('page-number').textContent, pageNumber);
  assert.deepEqual(f.getElementById('heatmap').children.map(cell => cell.dataset.date), dates);
  const contributed = chartSnapshot(f);
  await f.advance(200);
  f.edit();
  await f.flush();
  assertChartUnchanged(f, contributed);
  f.getElementById('newer-page').click();
  assertChartRebuiltOnce(f, contributed);
  assert.equal(f.getElementById('heatmap').children.find(cell => cell.dataset.date === f.today).className, 'cell level-1 pending');
  await f.close();
});

test('宽度变化继续调整布局与月份可见性，保留日期和月份节点', async () => {
  const f = await uiFixture();
  await f.flush();
  const before = chartSnapshot(f);
  const card = f.getElementById('.heatmap-card');
  let cellSize;
  card.style.setProperty = (_, value) => { cellSize = value; };
  card.style.getPropertyValue = () => cellSize;
  f.getElementById('.chart-scroll').clientWidth = 300;
  const label = f.getElementById('months').children[0];
  label.scrollWidth = 100;
  label.clientWidth = 50;
  f.context.resize();
  await f.advance(16);
  assertChartUnchanged(f, before);
  assert.equal(cellSize, '10px');
  assert.equal(label.style.visibility, 'hidden');
  f.getElementById('.chart-scroll').clientWidth = 1000;
  label.clientWidth = 150;
  f.context.resize();
  await f.advance(16);
  assertChartUnchanged(f, before);
  assert.ok(parseFloat(cellSize) > 10);
  assert.equal(label.style.visibility, 'visible');
  await f.close();
});
