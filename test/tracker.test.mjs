import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/tracker.mjs';
import { STATE_KEY, dayActivity } from '../src/activity.mjs';

let nextSession = 0;
const session = date => ({ id: `session-${++nextSession}`, date, lastChangedAt: new Date(date + 'T12:00:00').getTime() });

function fixture(data = {}) {
  const context = { data, day: '2026-10-01', writes: [], observations: [], fail: false, readFail: false };
  const tracker = createTracker({
    readData: async () => { if (context.readFail) throw new Error('read failed'); return structuredClone(context.data); },
    writeData: async (key, value) => {
      if (context.fail) throw new Error('write failed');
      context.data = { [key]: structuredClone(value) };
      context.writes.push(structuredClone(value));
    },
    now: () => new Date(context.day + 'T12:00:00'),
    onChange: result => context.observations.push(result),
  });
  return { context, tracker };
}

test('首次启用保存零贡献，刷新接续已保存累计和基线', async () => {
  const { context, tracker } = fixture();
  await tracker.load();
  await tracker.save();
  await tracker.confirm(session(context.day));
  const { tracker: reopened } = fixture(context.data);
  const result = await reopened.load();
  assert.equal(result.state.latestContributions, 1);
  assert.equal(result.state.baselineContributions, 0);
  assert.equal(result.savedContributions, 1);
  assert.equal((await reopened.save()).written, false);
});

test('新状态保存替换存储根，不保留其它格式数据', async () => {
  const { context, tracker } = fixture({ obsoleteStatistics: { count: 999 }, obsoleteGuard: true });
  await tracker.load();
  await tracker.save();
  assert.deepEqual(Object.keys(context.data), [STATE_KEY]);
  assert.equal(context.data[STATE_KEY].latestContributions, 0);
});

test('保存失败后内存贡献保留，重试不会再次计数', async () => {
  const { context, tracker } = fixture();
  await tracker.save();
  context.fail = true;
  await assert.rejects(tracker.confirm(session(context.day)), /write failed/);
  assert.equal(tracker.snapshot().state.latestContributions, 1);
  assert.equal(tracker.snapshot().savedContributions, 0);
  context.fail = false;
  await tracker.save();
  assert.equal(tracker.snapshot().savedContributions, 1);
  assert.equal(tracker.snapshot().state.latestContributions, 1);
  assert.equal((await tracker.save()).written, false);
});

test('保存失败期间下一段贡献继续累计，后续一次写入保存全部', async () => {
  const { context, tracker } = fixture();
  await tracker.save();
  context.fail = true;
  await assert.rejects(tracker.confirm(session(context.day)));
  await assert.rejects(tracker.confirm(session(context.day)));
  context.fail = false;
  await tracker.save();
  assert.equal(context.data[STATE_KEY].latestContributions, 2);
});

test('读取失败或新结构损坏不能当作首次启用覆盖数据', async () => {
  const { context, tracker } = fixture();
  context.readFail = true;
  await assert.rejects(tracker.save(), /read failed/);
  assert.equal(tracker.snapshot().loaded, false);
  assert.deepEqual(context.writes, []);
  context.readFail = false;
  await tracker.save();
  const broken = fixture({ [STATE_KEY]: { version: 1 } });
  await assert.rejects(broken.tracker.save(), /格式/);
  assert.deepEqual(broken.context.writes, []);
});

test('跨日结算保存不会凭空增加贡献，基线和历史可恢复', async () => {
  const { context, tracker } = fixture();
  await tracker.confirm(session(context.day));
  context.day = '2026-10-04';
  const result = await tracker.rollover();
  assert.equal(result.state.latestContributions, 1);
  assert.equal(result.state.baselineContributions, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.state.history)), { '2026-10-01': 1, '2026-10-02': 0, '2026-10-03': 0 });
  assert.equal(dayActivity(result.state, context.day, context.day).delta, 0);
});

test('慢写入期间的下一段确认串行处理，累计和保存不会被旧结果覆盖', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const tracker = createTracker({
    readData: async () => ({}), now: () => new Date(2026, 9, 1, 12),
    writeData: async (key, state) => {
      writes.push(state.latestContributions);
      if (writes.length === 1) { entered(); await gate; }
    },
  });
  const first = tracker.confirm(session('2026-10-01'));
  await started;
  const second = tracker.confirm(session('2026-10-01'));
  assert.equal(tracker.snapshot().state.latestContributions, 1);
  assert.equal(tracker.snapshot().savedContributions, null);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [1, 2]);
  assert.equal(tracker.snapshot().savedContributions, 2);
});

test('快照由独立副本组成，界面读取不会改写统计', async () => {
  const { tracker } = fixture();
  const result = await tracker.load();
  result.state.latestContributions = 999;
  assert.equal(tracker.snapshot().state.latestContributions, 0);
});

test('预保存失败后继续编辑、再次预保存和最终确认都不会重复增加', async () => {
  const { context, tracker } = fixture();
  await tracker.save();
  const editing = session(context.day);
  context.fail = true;
  await assert.rejects(tracker.presave(editing), /write failed/);
  await assert.rejects(tracker.touch({ ...editing, lastChangedAt: editing.lastChangedAt + 20000 }));
  await assert.rejects(tracker.presave({ ...editing, lastChangedAt: editing.lastChangedAt + 20000 }));
  assert.equal(tracker.snapshot().state.latestContributions, 1);
  context.fail = false;
  await tracker.confirm({ ...editing, lastChangedAt: editing.lastChangedAt + 20000 });
  assert.equal(context.data[STATE_KEY].latestContributions, 1);
  assert.equal(context.data[STATE_KEY].pendingContribution, undefined);
});

test('慢预保存期间继续编辑，后续时间更新和确认接续同一笔贡献', async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const writes = [];
  const tracker = createTracker({
    readData: async () => ({}), now: () => new Date(2026, 9, 1, 12),
    writeData: async (key, state) => {
      writes.push(structuredClone(state));
      if (writes.length === 1) { entered(); await gate; }
    },
  });
  const editing = session('2026-10-01');
  const first = tracker.presave(editing);
  await started;
  const continued = { ...editing, lastChangedAt: editing.lastChangedAt + 40000 };
  const touched = tracker.touch(continued);
  const updated = tracker.presave(continued);
  const finished = tracker.confirm(continued);
  release();
  await Promise.all([first, touched, updated, finished]);
  assert.ok(writes.every(state => state.latestContributions === 1));
  assert.equal(writes[1].pendingContribution.lastChangedAt, continued.lastChangedAt);
  assert.equal(writes.at(-1).pendingContribution, undefined);
});

test('跨日恢复预保存贡献，继续编辑仍归属原日期且不重复计数', async () => {
  const { context, tracker } = fixture();
  const editing = session(context.day);
  await tracker.presave(editing);
  context.day = '2026-10-02';
  await tracker.rollover();
  await tracker.touch({ ...editing, lastChangedAt: editing.lastChangedAt + 86400000 });
  await tracker.confirm({ ...editing, lastChangedAt: editing.lastChangedAt + 86400000 });
  assert.equal(context.data[STATE_KEY].latestContributions, 1);
  assert.equal(context.data[STATE_KEY].history['2026-10-01'], 1);
  assert.equal(dayActivity(context.data[STATE_KEY], context.day, context.day).delta, 0);
});
