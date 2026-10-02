import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/tracker.mjs';
import { STATE_KEY } from '../src/activity.mjs';

function fixture() {
  const context = { data: {}, revision: 100, day: '2026-10-01', writes: [] };
  const dependencies = {
    readData: async () => structuredClone(context.data),
    readRevision: async () => context.revision,
    writeData: async (key, value) => {
      context.writes.push(structuredClone(value));
      context.data[key] = structuredClone(value);
    },
    now: () => new Date(`${context.day}T12:00:00`),
  };
  return { context, dependencies, tracker: createTracker(dependencies) };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('刷新只更新内存，保存更新 Interaction；重新加载保留基准', async () => {
  const { context, tracker, dependencies } = fixture();
  const first = await tracker.refresh();
  assert.equal(first.savedRevision, null);
  assert.equal(context.writes.length, 0);
  context.revision = 120;
  const live = await tracker.refresh();
  assert.equal(live.revision, 120);
  assert.equal(live.state.baselineRevision, 100);
  assert.equal(context.writes.length, 0);
  assert.equal((await tracker.save()).savedRevision, 120);
  const reloaded = await createTracker(dependencies).refresh();
  assert.equal(reloaded.state.baselineRevision, 100);
  await tracker.save();
  assert.equal(context.writes.length, 1);
});

test('跨日首次观察的结算保留到延迟保存，不把后续编辑计入前一天', async () => {
  const { context, tracker } = fixture();
  await tracker.refresh();
  context.day = '2026-10-02';
  context.revision = 125;
  await tracker.refresh();
  context.revision = 140;
  await tracker.save();
  assert.equal(context.data[STATE_KEY].baselineRevision, 125);
  assert.deepEqual(context.data[STATE_KEY].history, { '2026-10-01': 25 });
  assert.equal(context.data[STATE_KEY].latestRevision, 140);
});

test('旧 blocked 标记不再阻止统计，也不重置已有历史', async () => {
  const { context, dependencies, tracker } = fixture();
  await tracker.save();
  context.data.revisionHeatmapWriteGuard = { status: 'blocked' };
  context.revision = 125;
  context.day = '2026-10-03';
  const other = createTracker(dependencies);
  const result = await other.save();
  assert.equal(result.savedRevision, 125);
  assert.deepEqual(result.state.history, { '2026-10-01': 25, '2026-10-02': 0 });
  assert.equal(context.writes.length, 2);
});

test('读取 Interaction 失败提供观察值但不初始化或写入，恢复后可重试', async () => {
  const { context, dependencies } = fixture();
  let failing = true;
  dependencies.readData = async () => {
    if (failing) throw new Error('storage unavailable');
    return context.data;
  };
  const tracker = createTracker(dependencies);
  await assert.rejects(tracker.save(), error => {
    assert.equal(error.observation.revision, 100);
    return /storage unavailable/.test(error.message);
  });
  assert.equal(context.writes.length, 0);
  failing = false;
  assert.equal((await tracker.save()).savedRevision, 100);
});

test('保存请求发出前恢复编辑取消本次保存和观察', async () => {
  const { context, dependencies } = fixture();
  const gate = deferred();
  const entered = deferred();
  dependencies.readRevision = async () => { entered.resolve(); await gate.promise; return 120; };
  const tracker = createTracker(dependencies);
  let idle = true;
  const saving = tracker.save({ canSave: () => idle });
  await entered.promise;
  idle = false;
  gate.resolve();
  assert.equal((await saving).cancelled, true);
  assert.equal(context.writes.length, 0);
});

test('已发出的写入完成，继续编辑后的下一轮保存最新 revision', async () => {
  const { context, dependencies } = fixture();
  const gate = deferred();
  const entered = deferred();
  const write = dependencies.writeData;
  dependencies.writeData = async (...args) => { entered.resolve(); await gate.promise; await write(...args); };
  const tracker = createTracker(dependencies);
  let idle = true;
  const saving = tracker.save({ canSave: () => idle });
  await entered.promise;
  idle = false;
  context.revision = 130;
  gate.resolve();
  assert.equal((await saving).savedRevision, 100);
  assert.equal(context.data[STATE_KEY].latestRevision, 100);
  idle = true;
  const result = await tracker.save({ canSave: () => idle });
  assert.equal(result.savedRevision, 130);
  assert.equal(result.state.baselineRevision, 100);
  assert.equal(context.data.revisionHeatmapWriteGuard, undefined);
});

test('失败的写入不冒充已保存，后续重试保持内存基准', async () => {
  const { context, dependencies } = fixture();
  const write = dependencies.writeData;
  let failing = true;
  dependencies.writeData = async (...args) => {
    if (failing) throw new Error('write failed');
    await write(...args);
  };
  const tracker = createTracker(dependencies);
  await assert.rejects(tracker.save(), /write failed/);
  context.revision = 130;
  assert.equal((await tracker.refresh()).savedRevision, null);
  failing = false;
  const result = await tracker.save();
  assert.equal(result.savedRevision, 130);
  assert.equal(result.state.baselineRevision, 100);
});

test('并发刷新和保存串行执行，各自完成所请求的操作', async () => {
  const { context, tracker } = fixture();
  await Promise.all([tracker.refresh(), tracker.save(), tracker.save()]);
  assert.equal(context.writes.length, 1);
});
