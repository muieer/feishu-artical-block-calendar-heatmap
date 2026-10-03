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
    return { children: [], dataset: {}, style: { setProperty() {}, getPropertyValue() { return ''; } }, clientWidth: 768, scrollWidth: 0, scrollLeft: 0,
      addEventListener: (name, handler) => handlers.set(name, handler),
      click() { if (!this.disabled) handlers.get('click')?.(); },
      get textContent() { return text; }, set textContent(value) { text = String(value); },
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
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
  let data = savedData ?? (startedOn === today ? { obsoleteStatistics: { count: 100 } }
    : { [activity.STATE_KEY]: activity.advanceActivity(undefined, startedOn).state });
  const context = { failWrite: false, writes: 0 };
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
    createTracker: options => createTracker({ ...options, now: dateNow }),
    createIdleScheduler: options => createIdleScheduler({ ...options, now: () => dateNow().getTime(), dateNow, setTimer, clearTimer, createId: () => `ui-session-${++nextId}` }),
    connectFeishu: async () => host, LOCAL_PREVIEW: preview,
    document: { getElementById, createElement: element, querySelector: selector => getElementById(selector), addEventListener() {}, removeEventListener() {} },
    window: { addEventListener: (name, handler) => windowEvents.set(name, handler) },
    ResizeObserver: class { observe() {} disconnect() {} },
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
    rule: minutes => getElementById('contribution-rules').children.find(button => Number(button.dataset.minutes) === minutes),
    close: async () => { windowEvents.get('pagehide')(); await flush(); } };
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
  assert.equal(getElementById('visible-range').textContent, `${page.dates[0]} 至 ${page.dates.at(-1)}`);
  assert.equal(getElementById('recent-days').children.length, 7);
  assert.equal(getElementById('baseline-contributions').textContent, '0');
  assert.equal(getElementById('latest-contributions').textContent, '0');
  assert.equal(getElementById('saved-contributions').textContent, '0');
  assert.deepEqual(Object.keys(data()), [activity.STATE_KEY]);
  context.failWrite = true;
  edit();
  await advance(9999);
  assert.equal(getElementById('latest-contributions').textContent, '0');
  await advance(1);
  assert.equal(getElementById('latest-contributions').textContent, '1');
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
  assert.match(getElementById('status').textContent, /预保存/);
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
  assert.match(f.getElementById('contribution-rule-explanation').textContent, /3 分钟内.*空闲 3 分钟/);
  assert.match(f.getElementById('status').textContent, /计时规则已保存.*3 分钟.*预保存.*3 分钟/);
  assert.doesNotMatch(f.getElementById('status').textContent, /已结束/);
  await f.advance(60000);
  assert.ok(f.data()[activity.STATE_KEY].pendingContribution);
  f.rule(1).click();
  await f.flush();
  assert.equal(f.data()[activity.STATE_KEY].pendingContribution, undefined);
  assert.equal(f.data()[activity.STATE_KEY].latestContributions, 1);
  assert.equal(f.getElementById('idle-seconds').textContent, '—');
  f.edit();
  assert.match(f.getElementById('status').textContent, /空闲 1 分钟/);
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
  assert.match(f.getElementById('status').textContent, /计时规则已保存.*5 分钟/);
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
  const preview = await uiFixture({ preview: true });
  await preview.flush();
  preview.rule(60).click();
  assert.equal(preview.rule(60).disabled, true);
  assert.match(preview.getElementById('status').textContent, /60 分钟.*未写入飞书数据/);
  assert.match(preview.getElementById('contribution-rule-explanation').textContent, /60 分钟/);
  assert.equal(preview.context.writes, 0);
  await loading.close();
  await failed.close();
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
  assert.match(f.getElementById('contribution-rule-explanation').textContent, /空闲 1 分钟/);
  assert.equal(f.data()[activity.STATE_KEY].contributionIdleMinutes, 3);
  release();
  await f.flush();
  assert.equal(f.data()[activity.STATE_KEY].contributionIdleMinutes, 1);
  assert.equal(f.data()[activity.STATE_KEY].pendingContribution, undefined);
  assert.equal(f.data()[activity.STATE_KEY].latestContributions, 1);
  await f.close();
});
