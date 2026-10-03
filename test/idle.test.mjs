import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdleScheduler } from '../src/idle.mjs';
import { createTracker } from '../src/tracker.mjs';
import { STATE_KEY } from '../src/activity.mjs';
import { CONTRIBUTION_IDLE_MINUTES, contributionIdleMs } from '../src/contribution.mjs';

const change = { changes: [{ type: 'update', blockId: 1 }] };
function fixture(callbacks = {}, options = {}) {
  let clock = 0;
  let nextId = 0;
  const timers = new Map();
  const calls = [];
  const errors = [];
  const epoch = new Date(2026, 9, 1, 12).getTime();
  function create(restored) {
    return createIdleScheduler({
      ...options,
      now: () => epoch + clock, dateNow: () => new Date(epoch + clock), restored,
      createId: () => `session-${++nextId}`,
      ...Object.fromEntries(['presave', 'confirm', 'onActivity'].map(type => [type, session => {
        calls.push({ type, session, clock });
        return callbacks[type]?.(session);
      }])),
      setTimer: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: clock + delay }); return id; },
      clearTimer: id => timers.delete(id), onError: error => errors.push(error),
    });
  }
  async function advance(ms, deliver = true) {
    const target = clock + ms;
    while (deliver) {
      const item = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!item) break;
      clock = Math.max(clock, item[1].at);
      timers.delete(item[0]);
      item[1].fn();
      for (let index = 0; index < 20; index++) await Promise.resolve();
    }
    clock = target;
    for (let index = 0; index < 20; index++) await Promise.resolve();
  }
  return { scheduler: create(), create, calls, errors, advance, now: () => new Date(epoch + clock),
    saves: () => calls.filter(call => call.type === 'presave'), finishes: () => calls.filter(call => call.type === 'confirm') };
}

test('无编辑和无效事件即使等待一分钟也不计贡献', async () => {
  const f = fixture();
  for (const event of [undefined, {}, { changes: [] }, { changes: [{ type: 'selection' }] }]) f.scheduler.activity(event);
  await f.advance(60000);
  assert.deepEqual(f.calls, []);
  assert.equal(f.scheduler.idleSeconds(), null);
});

for (const minutes of CONTRIBUTION_IDLE_MINUTES) {
  test(`${minutes} 分钟规则：10 秒预保存、继续编辑合并、到达边界结束`, async () => {
    const f = fixture({}, { contributionIdleMinutes: minutes });
    f.scheduler.activity(change);
    await f.advance(10000);
    assert.equal(f.saves().length, 1);
    await f.advance(20000);
    f.scheduler.activity(change);
    await f.advance(10000);
    assert.equal(f.saves().length, 2);
    await f.advance(contributionIdleMs(minutes) - 10001);
    assert.equal(f.finishes().length, 0);
    await f.advance(1);
    assert.equal(f.finishes().length, 1);
    assert.equal(new Set(f.calls.map(call => call.session.id)).size, 1);
    assert.equal(f.scheduler.hasPending(), false);
  });
}

test('延长计时规则不重置最后编辑时间，旧定时器不提前结束', async () => {
  const f = fixture();
  f.scheduler.activity(change);
  await f.advance(30000);
  f.scheduler.setContributionIdleMinutes(3);
  assert.equal(f.scheduler.idleSeconds(), 30);
  await f.advance(30000);
  assert.equal(f.finishes().length, 0);
  await f.advance(119999);
  assert.equal(f.finishes().length, 0);
  await f.advance(1);
  assert.equal(f.finishes()[0].clock, 180000);
});

test('缩短规则立即重算边界，尚未超时与已经超时都只确认一次', async () => {
  for (const elapsed of [30000, 120000]) {
    const f = fixture({}, { contributionIdleMinutes: 3 });
    f.scheduler.activity(change);
    await f.advance(elapsed);
    f.scheduler.setContributionIdleMinutes(1);
    await f.advance(0);
    assert.equal(f.finishes().length, elapsed >= 60000 ? 1 : 0);
    if (elapsed < 60000) {
      await f.advance(29999);
      assert.equal(f.finishes().length, 0);
      await f.advance(1);
    }
    assert.equal(f.finishes().length, 1);
    assert.equal(f.saves().length, 1);
    f.scheduler.setContributionIdleMinutes(60);
    await f.advance(3600000);
    assert.equal(f.finishes().length, 1);
    assert.equal(f.scheduler.hasPending(), false);
  }
});

test('预保存前切换规则仍在最后编辑后 10 秒预保存，无编辑切换不计数', async () => {
  const f = fixture();
  f.scheduler.setContributionIdleMinutes(60);
  await f.advance(3600000);
  assert.equal(f.calls.length, 0);
  f.scheduler.activity(change);
  await f.advance(5000);
  f.scheduler.setContributionIdleMinutes(3);
  await f.advance(4999);
  assert.equal(f.saves().length, 0);
  await f.advance(1);
  assert.equal(f.saves().length, 1);
  assert.throws(() => f.scheduler.setContributionIdleMinutes(2), /计时规则无效/);
});

test('非默认规则的后台延迟边界和恢复按配置处理', async () => {
  for (const gap of [179999, 180000]) {
    const f = fixture({}, { contributionIdleMinutes: 3 });
    f.scheduler.activity(change);
    await f.advance(10000);
    const restored = f.saves()[0].session;
    f.scheduler.dispose();
    await f.advance(gap - 10000, false);
    const resumed = f.create(restored);
    resumed.activity(change);
    await f.advance(10000);
    assert.equal(f.finishes().length, gap === 180000 ? 1 : 0);
    assert.equal(new Set(f.calls.map(call => call.session.id)).size, gap === 180000 ? 2 : 1);
  }
});

test('10 秒预保存，60 秒结束；两个边界前均不提前执行', async () => {
  const f = fixture();
  f.scheduler.activity(change);
  await f.advance(9999);
  assert.equal(f.saves().length, 0);
  await f.advance(1);
  assert.equal(f.saves().length, 1);
  assert.equal(f.scheduler.hasPending(), true);
  await f.advance(49999);
  assert.equal(f.finishes().length, 0);
  await f.advance(1);
  assert.equal(f.finishes().length, 1);
  assert.equal(f.scheduler.hasPending(), false);
  await f.advance(60000);
  assert.equal(f.finishes().length, 1);
  assert.equal(f.saves().length, 1);
});

test('预保存后 60 秒内继续编辑，重置两个窗口并保留贡献身份', async () => {
  const f = fixture();
  f.scheduler.activity(change);
  await f.advance(40000);
  f.scheduler.activity({ changes: [{ type: 'insert' }, { type: 'remove' }] });
  await f.advance(9999);
  assert.equal(f.saves().length, 1);
  await f.advance(1);
  assert.equal(f.saves().length, 2);
  await f.advance(49999);
  assert.equal(f.finishes().length, 0);
  await f.advance(1);
  assert.equal(f.finishes()[0].clock, 100000);
  assert.equal(new Set(f.calls.map(call => call.session.id)).size, 1);
});

test('持续变化重置窗口，多块批量变化合为一次贡献', async () => {
  const f = fixture();
  f.scheduler.activity(change);
  await f.advance(9000);
  f.scheduler.activity({ changes: [{ type: 'insert' }, { type: 'remove' }, { type: 'update' }] });
  await f.advance(9999);
  assert.equal(f.saves().length, 0);
  await f.advance(1);
  assert.equal(f.saves()[0].clock, 19000);
});

test('后台延迟计时：59.999 秒继续合并，恰好 60 秒开启新贡献', async () => {
  for (const gap of [59999, 60000]) {
    const f = fixture();
    f.scheduler.activity(change);
    await f.advance(gap, false);
    f.scheduler.activity(change);
    await f.advance(10000);
    assert.equal(f.finishes().length, gap === 60000 ? 1 : 0);
    assert.equal(new Set(f.calls.map(call => call.session.id)).size, gap === 60000 ? 2 : 1);
  }
});

test('跨午夜沿用本次贡献日期，跨日检查不提前结束', async () => {
  const f = fixture();
  await f.advance(12 * 3600000 - 20000);
  f.scheduler.activity(change);
  await f.advance(30000);
  assert.equal(f.scheduler.finishIfIdle(), false);
  f.scheduler.activity(change);
  await f.advance(60000);
  assert.equal(f.finishes()[0].session.date, '2026-10-01');
});

test('回调失败不因闲置重复计数；销毁取消尚未预保存的编辑', async () => {
  const f = fixture({ presave: async () => { throw new Error('failed'); } });
  f.scheduler.activity(change);
  await f.advance(60000);
  assert.equal(f.saves().length, 1);
  assert.equal(f.errors.length, 1);
  f.scheduler.activity(change);
  f.scheduler.dispose();
  f.scheduler.activity(change);
  await f.advance(60000);
  assert.equal(f.saves().length, 1);
});

function integration() {
  let data = {};
  let tracker;
  const f = fixture({ presave: session => tracker.presave(session), confirm: session => tracker.confirm(session),
    onActivity: session => tracker.touch(session) });
  const open = async () => {
    tracker = createTracker({ readData: async () => structuredClone(data),
      writeData: async (key, value) => { data = { [key]: structuredClone(value) }; }, now: f.now });
    await tracker.load();
    return tracker;
  };
  return { f, open, data: () => data, tracker: () => tracker };
}

test('事件到存储：反复预保存和最终确认只加一，下一段贡献再加一', async () => {
  const i = integration();
  await i.open();
  await i.tracker().save();
  i.f.scheduler.activity(change);
  await i.f.advance(10000);
  assert.equal(i.data()[STATE_KEY].latestContributions, 1);
  i.f.scheduler.activity(change);
  await i.f.advance(10000);
  assert.equal(i.data()[STATE_KEY].latestContributions, 1);
  await i.f.advance(50000);
  assert.equal(i.data()[STATE_KEY].latestContributions, 1);
  assert.equal(i.data()[STATE_KEY].pendingContribution, undefined);
  i.f.scheduler.activity(change);
  await i.f.advance(10000);
  assert.equal(i.data()[STATE_KEY].latestContributions, 2);
});

test('10 秒预保存后关闭恢复，60 秒内再次编辑仍只算一次', async () => {
  const i = integration();
  await i.open();
  i.f.scheduler.activity(change);
  await i.f.advance(10000);
  i.f.scheduler.dispose();
  await i.f.advance(30000);
  const reopened = await i.open();
  const resumed = i.f.create(reopened.snapshot().state.pendingContribution);
  resumed.activity(change);
  await i.f.advance(60000);
  assert.equal(i.data()[STATE_KEY].latestContributions, 1);
  assert.equal(i.data()[STATE_KEY].pendingContribution, undefined);
});

test('预保存后继续编辑立即记录最新时间，刷新时不会按旧时间提前结束', async () => {
  const i = integration();
  await i.open();
  i.f.scheduler.activity(change);
  await i.f.advance(50000);
  i.f.scheduler.activity(change);
  await i.f.advance(0);
  assert.equal(i.data()[STATE_KEY].pendingContribution.lastChangedAt, i.f.now().getTime());
  i.f.scheduler.dispose();
  await i.f.advance(20000);
  const reopened = await i.open();
  const resumed = i.f.create(reopened.snapshot().state.pendingContribution);
  resumed.activity(change);
  await i.f.advance(60000);
  assert.equal(i.data()[STATE_KEY].latestContributions, 1);
});

test('关闭后超过 60 秒恢复，保留原贡献并允许新贡献', async () => {
  const i = integration();
  await i.open();
  i.f.scheduler.activity(change);
  await i.f.advance(10000);
  i.f.scheduler.dispose();
  await i.f.advance(50000);
  const reopened = await i.open();
  assert.equal(reopened.snapshot().state.pendingContribution, undefined);
  const resumed = i.f.create(reopened.snapshot().state.pendingContribution);
  resumed.activity(change);
  await i.f.advance(10000);
  assert.equal(i.data()[STATE_KEY].latestContributions, 2);
});
