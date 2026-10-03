import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as activity from '../src/activity.mjs';
import { createTracker } from '../src/tracker.mjs';
import { createIdleScheduler } from '../src/idle.mjs';
import { createInteractionStorage } from '../src/interaction.mjs';

for (const startedOn of ['2026-10-03', '2026-09-01', '2025-09-27', '2024-09-21']) {
test(`页面从启用周展开：${startedOn}；计数和失败重试正常`, async () => {
  const dateNow = () => new Date(2026, 9, 3, 12);
  const today = activity.localDate(dateNow());
  const elements = new Map();
  function element() {
    const classes = new Set();
    const handlers = new Map();
    let text = '';
    return { children: [], dataset: {}, style: { setProperty() {}, getPropertyValue() { return ''; } }, clientWidth: 768, scrollWidth: 0, scrollLeft: 0,
      addEventListener: (name, handler) => handlers.set(name, handler),
      click() { if (!this.disabled) handlers.get('click')?.(); },
      get textContent() { return text; }, set textContent(value) { text = String(value); },
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
      setAttribute() {}, classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } };
  }
  function getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  }
  let clock = 0;
  let nextId = 0;
  const timers = new Map();
  const setTimer = (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: clock + delay }); return id; };
  const clearTimer = id => timers.delete(id);
  const windowEvents = new Map();
  let data = startedOn === today ? { obsoleteStatistics: { count: 100 } }
    : { [activity.STATE_KEY]: activity.advanceActivity(undefined, startedOn).state };
  let failWrite = false;
  let changeHandler;
  const storage = createInteractionStorage({ Interaction: {
    getData: async () => data,
    setData: async change => {
      if (failWrite) throw new Error('storage unavailable');
      assert.deepEqual(change.data.path, []);
      data = structuredClone(change.data.value);
      return data;
    },
  } });
  const host = { ...storage, listen: async handler => { changeHandler = handler; return () => {}; }, resize: async () => {}, destroy() {} };
  const source = (await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, {
    ...activity, localDate: () => today,
    createTracker: options => createTracker({ ...options, now: dateNow }),
    createIdleScheduler: options => createIdleScheduler({ ...options, now: () => dateNow().getTime() + clock, dateNow, setTimer, clearTimer, createId: () => 'ui-session' }),
    connectFeishu: async () => host, LOCAL_PREVIEW: false,
    document: { getElementById, createElement: element, querySelector: selector => getElementById(selector), addEventListener() {}, removeEventListener() {} },
    window: { addEventListener: (name, handler) => windowEvents.set(name, handler) },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: fn => setTimer(fn, 16), cancelAnimationFrame: clearTimer,
    setTimeout: setTimer, clearTimeout: clearTimer, setInterval: () => ++nextId, clearInterval() {},
  }, { filename: 'src/index.js' });
  async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
  async function advance(ms) {
    clock += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    }
    await flush();
  }
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
  assert.deepEqual(Object.keys(data), [activity.STATE_KEY]);
  failWrite = true;
  changeHandler({ changes: [{ type: 'update', blockId: 1 }] });
  await advance(9999);
  assert.equal(getElementById('latest-contributions').textContent, '0');
  await advance(1);
  assert.equal(getElementById('latest-contributions').textContent, '1');
  assert.equal(getElementById('saved-contributions').textContent, '0');
  assert.equal(getElementById('heatmap').children[todayIndex].className, 'cell level-1 pending');
  assert.equal(getElementById('status').classList.contains('error'), true);
  failWrite = false;
  await advance(10000);
  assert.equal(getElementById('latest-contributions').textContent, '1');
  assert.equal(getElementById('saved-contributions').textContent, '1');
  assert.equal(getElementById('live-delta').textContent, '1');
  assert.equal(getElementById('heatmap').children[todayIndex].className, 'cell level-1 pending');
  assert.equal(getElementById('recent-days').children.at(-1).children[1].textContent, '1');
  assert.match(getElementById('status').textContent, /预保存/);
  changeHandler({ changes: [{ type: 'update' }] });
  await advance(10000);
  assert.equal(getElementById('latest-contributions').textContent, '1');
  await advance(50000);
  assert.equal(getElementById('latest-contributions').textContent, '1');
  assert.equal(data[activity.STATE_KEY].pendingContribution, undefined);
  if (page.pageCount > 1) {
    getElementById('.chart-scroll').scrollLeft = 100;
    getElementById('older-page').click();
    assert.equal(getElementById('.chart-scroll').scrollLeft, 0);
    assert.equal(getElementById('page-number').textContent, `2 / ${page.pageCount}`);
    const historicalDates = getElementById('heatmap').children.map(cell => cell.dataset.date);
    assert.deepEqual(historicalDates, activity.calendarPage(startedOn, today, 1).dates);
    assert.equal(getElementById('newer-page').disabled, false);
    // A new contribution re-renders the selected historical page without jumping to today.
    changeHandler({ changes: [{ type: 'update', blockId: 1 }] });
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
  windowEvents.get('pagehide')();
  await flush();
});
}
