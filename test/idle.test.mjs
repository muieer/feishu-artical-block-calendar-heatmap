import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdleScheduler } from '../src/idle.mjs';

function fixture() {
  let time = 0;
  let id = 0;
  const timers = new Map();
  const calls = [];
  const scheduler = createIdleScheduler({
    refresh: options => calls.push({ kind: 'refresh', time, options }),
    save: options => calls.push({ kind: 'save', time, options }),
    now: () => time,
    setTimer: (callback, delay) => { timers.set(++id, { callback, at: time + delay }); return id; },
    clearTimer: key => timers.delete(key),
  });
  async function advance(ms) {
    const end = time + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await Promise.resolve();
    }
    time = end;
  }
  return { scheduler, calls, advance };
}

test('闲置 10 秒刷新、60 秒保存，不提前执行', async () => {
  const { scheduler, calls, advance } = fixture();
  scheduler.activity();
  await advance(9999);
  assert.equal(calls.length, 0);
  await advance(1);
  assert.deepEqual(calls.map(c => [c.kind, c.time]), [['refresh', 10000]]);
  await advance(49999);
  assert.equal(calls.length, 1);
  await advance(1);
  assert.deepEqual(calls.map(c => [c.kind, c.time]), [['refresh', 10000], ['save', 60000]]);
});

test('持续编辑重置两个窗口；旧异步操作的有效性失效', async () => {
  const { scheduler, calls, advance } = fixture();
  scheduler.activity();
  await advance(10000);
  const old = calls[0].options.canApply;
  assert.equal(old(), true);
  await advance(45000);
  scheduler.activity();
  assert.equal(old(), false);
  await advance(5000);
  assert.equal(calls.length, 1);
  await advance(5000);
  assert.equal(calls[1].kind, 'refresh');
  await advance(50000);
  assert.equal(calls[2].time, 115000);
  assert.equal(calls[2].kind, 'save');
  scheduler.activity();
  assert.equal(calls[2].options.canSave(), false);
});

test('销毁后取消计时及已发出回调的有效性', async () => {
  const { scheduler, calls, advance } = fixture();
  scheduler.activity();
  await advance(10000);
  scheduler.dispose();
  assert.equal(calls[0].options.canApply(), false);
  scheduler.activity();
  await advance(60000);
  assert.equal(calls.length, 1);
});


test('跨日检查也遵守 10 秒闲置窗口，手动保存窗口被编辑失效', async () => {
  const { scheduler, calls, advance } = fixture();
  scheduler.activity();
  const manualWindow = scheduler.captureWindow();
  assert.equal(manualWindow(), true);
  await advance(9000);
  scheduler.refreshIfIdle();
  await Promise.resolve();
  assert.equal(calls.length, 0);
  await advance(1000);
  scheduler.refreshIfIdle();
  await Promise.resolve();
  assert.equal(calls.length, 2);
  scheduler.activity();
  assert.equal(manualWindow(), false);
});
