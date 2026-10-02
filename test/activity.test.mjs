import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { advanceActivity, dayActivity, colorThresholds, colorLevel, calendarDates, addDays, revisionNumber } from '../src/activity.mjs';

const first = (date = '2026-10-01', revision = 100) => advanceActivity(null, date, revision).state;

test('首次启用只建立当天基准，启用前是无数据而非零', () => {
  const state = first();
  assert.deepEqual(state.history, {});
  assert.equal(state.startedOn, '2026-10-01');
  assert.deepEqual(dayActivity(state, '2026-09-30', '2026-10-01'), { status: 'no-data', delta: null });
  assert.deepEqual(dayActivity(state, '2026-10-01', '2026-10-01'), { status: 'pending', delta: 0 });
});

test('同日反复加载只更新最新 revision，不重置基准、不结算今天', () => {
  const original = first();
  let state = advanceActivity(original, '2026-10-01', 110).state;
  state = advanceActivity(state, '2026-10-01', 117).state;
  assert.equal(state.baselineRevision, 100);
  assert.equal(state.latestRevision, 117);
  assert.deepEqual(state.history, {});
  assert.equal(dayActivity(state, '2026-10-01', '2026-10-01').delta, 17);
  assert.equal(original.latestRevision, 100);
});

test('T+1 用首次读取的 revision 结算 T 日，今天建立新基准', () => {
  const state = advanceActivity(advanceActivity(first(), '2026-10-01', 110).state, '2026-10-02', 125).state;
  assert.deepEqual(state.history, { '2026-10-01': 25 });
  assert.equal(state.baselineRevision, 125);
  assert.equal(state.currentDate, '2026-10-02');
  const later = advanceActivity(state, '2026-10-02', 130).state;
  assert.deepEqual(later.history, state.history);
  assert.equal(dayActivity(later, '2026-10-02', '2026-10-02').delta, 5);
});

test('跨多日补结算：上一统计日归入全部增量，中间自然日记零', () => {
  const state = advanceActivity(first('2026-09-29', 100), '2026-10-03', 140).state;
  assert.deepEqual(state.history, { '2026-09-29': 40, '2026-09-30': 0, '2026-10-01': 0, '2026-10-02': 0 });
  assert.equal(dayActivity(state, '2026-09-30', '2026-10-03').status, 'settled');
  assert.equal(dayActivity(state, '2026-10-03', '2026-10-03').status, 'pending');
  const next = advanceActivity(state, '2026-10-04', 140).state;
  assert.equal(next.history['2026-10-03'], 0);
  assert.equal(dayActivity(next, '2026-10-05', '2026-10-04').status, 'future');
});

test('revision 回退时不生成负数，重建基准并保留已有历史', () => {
  const saved = advanceActivity(first(), '2026-10-02', 150).state;
  const original = structuredClone(saved);
  const result = advanceActivity(saved, '2026-10-05', 70);
  assert.deepEqual(result.state.history, { '2026-10-01': 50 });
  assert.equal(result.state.baselineRevision, 70);
  assert.equal(result.state.currentDate, '2026-10-05');
  assert.equal(dayActivity(result.state, '2026-10-02', '2026-10-05').status, 'no-data');
  assert.deepEqual(saved, original);
  assert.ok(result.notice);
});

test('revision 低于已观察最新值但高于基准也视为异常', () => {
  const saved = advanceActivity(first(), '2026-10-01', 150).state;
  assert.equal(advanceActivity(saved, '2026-10-01', 120).state.baselineRevision, 120);
});

test('拒绝非法 revision、损坏历史和日期倒退，不覆盖历史', () => {
  for (const value of [-1, 1.5, undefined, null, '', '1.5', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => revisionNumber(value));
  }
  assert.equal(revisionNumber('123'), 123);
  assert.throws(() => advanceActivity(first(), '2026-09-30', 150), /时区/);
  assert.throws(() => advanceActivity({ ...first(), history: { '2026-10-01': 5 } }, '2026-10-02', 150), /历史/);
  assert.throws(() => advanceActivity(first(), '2026-02-30', 150), /日期/);
});

test('自然日计算跨月、闰年，26 周网格以周日开始，今天仍在网格内', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  const dates = calendarDates('2026-10-02');
  assert.equal(dates.length, 182);
  assert.equal(new Date(`${dates[0]}T12:00:00Z`).getUTCDay(), 0);
  assert.equal(dates.at(-1), '2026-10-03');
  assert.ok(dates.includes('2026-10-02'));
});

test('按本地时区识别自然日，夏令时不丢失或重复日期', () => {
  const moduleUrl = new URL('../src/activity.mjs', import.meta.url).href;
  const script = `import { localDate, calendarDates } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify([localDate(new Date('2026-10-01T20:00:00Z')),calendarDates('2026-03-09').length]));`;
  for (const [zone, date] of [['Asia/Shanghai', '2026-10-02'], ['America/Los_Angeles', '2026-10-01']]) {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(result), [date, 182]);
  }
});

test('只按正的已结算历史做四分位分级，零永远灰色，重算不改变原始值', () => {
  const history = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7, i: 8 };
  const original = structuredClone(history);
  const thresholds = colorThresholds(history);
  assert.deepEqual(thresholds, [2, 4, 6]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(x => colorLevel(x, thresholds)), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual(history, original);
  assert.deepEqual(colorThresholds({ a: 0 }), []);
  assert.equal(colorLevel(0, [1, 1, 1]), 0);
  assert.equal(colorLevel(5, colorThresholds({ a: 5, b: 5 })), 1);
});
