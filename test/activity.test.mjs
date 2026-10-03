import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceActivity, recordContribution, validateState, dayActivity, colorThresholds, colorLevel, calendarDates, calendarPage, addDays, localDate } from '../src/activity.mjs';

const first = (date = '2026-10-01') => advanceActivity(undefined, date).state;

test('首次启用从零开始，启用前无数据，当天 pending', () => {
  const state = first();
  assert.equal(state.latestContributions, 0);
  assert.equal(state.baselineContributions, 0);
  assert.deepEqual(dayActivity(state, '2026-09-30', '2026-10-01'), { status: 'no-data', delta: null });
  assert.deepEqual(dayActivity(state, '2026-10-01', '2026-10-01'), { status: 'pending', delta: 0 });
});

test('每次确认加一，同日加载不重置基线或累计值', () => {
  const original = first();
  let state = recordContribution(original, '2026-10-01');
  state = recordContribution(state, '2026-10-01');
  state = advanceActivity(state, '2026-10-01').state;
  assert.equal(state.baselineContributions, 0);
  assert.equal(state.latestContributions, 2);
  assert.equal(dayActivity(state, '2026-10-01', '2026-10-01').delta, 2);
  assert.equal(original.latestContributions, 0);
});

test('T+1 结算已有贡献，下一日基线等于累计次数', () => {
  const state = advanceActivity(recordContribution(first(), '2026-10-01'), '2026-10-02').state;
  assert.deepEqual(state.history, { '2026-10-01': 1 });
  assert.equal(state.baselineContributions, 1);
  const next = recordContribution(state, '2026-10-02');
  assert.equal(next.latestContributions, 2);
  assert.equal(dayActivity(next, '2026-10-02', '2026-10-02').delta, 1);
  assert.deepEqual(next.history, state.history);
});

test('多日未加载只结算已确认贡献，中间自然日补零', () => {
  const state = advanceActivity(recordContribution(first(), '2026-10-01'), '2026-10-04').state;
  assert.deepEqual(state.history, { '2026-10-01': 1, '2026-10-02': 0, '2026-10-03': 0 });
  assert.equal(dayActivity(state, '2026-10-04', '2026-10-04').delta, 0);
  assert.equal(dayActivity(state, '2026-10-05', '2026-10-04').status, 'future');
});

test('跨午夜确认归属最后变化日；连续编辑跨日归属次日', () => {
  const state = recordContribution(first(), '2026-10-01', '2026-10-02');
  assert.equal(state.history['2026-10-01'], 1);
  assert.equal(dayActivity(state, '2026-10-02', '2026-10-02').delta, 0);
  const continued = recordContribution(first(), '2026-10-02', '2026-10-02');
  assert.equal(continued.history['2026-10-01'], 0);
  assert.equal(dayActivity(continued, '2026-10-02', '2026-10-02').delta, 1);
});

test('跨日排队的多个确认仍归属原日期，不增加今天次数', () => {
  let state = recordContribution(first(), '2026-10-01', '2026-10-02');
  state = recordContribution(state, '2026-10-01', '2026-10-02');
  assert.equal(state.history['2026-10-01'], 2);
  assert.equal(state.baselineContributions, 2);
  assert.equal(state.latestContributions, 2);
  assert.equal(dayActivity(state, '2026-10-02', '2026-10-02').delta, 0);
  validateState(state);
});

test('日期倒退或损坏数据拒绝修改，不重建统计基线', () => {
  const state = first();
  assert.throws(() => advanceActivity(state, '2026-09-30'), /时区/);
  assert.throws(() => recordContribution(state, '2026-10-02', '2026-10-01'), /日期/);
  assert.throws(() => advanceActivity(state, '2026-02-30'), /日期/);
  for (const latestContributions of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateState({ ...state, latestContributions }), /贡献/);
  }
  assert.throws(() => validateState({ ...state, baselineContributions: 1, latestContributions: 1 }), /基线/);
  assert.throws(() => validateState(null), /格式/);
  assert.throws(() => validateState({ ...state, unexpected: 0 }), /结构/);
  assert.equal(state.latestContributions, 0);
});

test('自然日历跨月、闰年和夏令时日期标签，网格为 371 天', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  const dates = calendarDates('2026-10-02');
  assert.equal(dates.length, 371);
  assert.equal(new Date(dates[0] + 'T12:00:00Z').getUTCDay(), 0);
  assert.equal(dates[0], '2026-09-27');
  assert.equal(dates.at(-1), '2027-10-02');
  assert.equal(localDate(new Date(2026, 9, 3, 0, 0, 0)), '2026-10-03');
});

test('首列固定在启用周，跨月、跨年和跨周后不向前回溯', () => {
  for (const [startedOn, start] of [
    ['2026-10-03', '2026-09-27'],
    ['2026-10-04', '2026-10-04'],
    ['2027-01-01', '2026-12-27'],
    ['2024-02-29', '2024-02-25'],
  ]) {
    const dates = calendarDates(startedOn, addDays(startedOn, 14));
    assert.equal(dates[0], start);
    assert.equal(dates.length, 371);
    assert.equal(dates.indexOf(startedOn), new Date(`${startedOn}T12:00:00Z`).getUTCDay());
  }
});

test('第 53 周仍为单页，第 54 周默认滚动到最近 53 周，历史页补足', () => {
  const lastDay = calendarPage('2026-10-03', '2027-10-02');
  assert.equal(lastDay.pageCount, 1);
  assert.equal(lastDay.dates[0], '2026-09-27');
  const latest = calendarPage('2026-10-03', '2027-10-03');
  assert.equal(latest.pageCount, 2);
  assert.equal(latest.pageIndex, 0);
  assert.equal(latest.dates[0], '2026-10-04');
  assert.equal(latest.dates.at(-1), '2027-10-09');
  const oldest = calendarPage('2026-10-03', '2027-10-03', 1);
  assert.equal(oldest.dates[0], '2026-09-27');
  assert.equal(oldest.dates.at(-1), '2027-10-02');
  assert.equal(oldest.dates.length, 371);
  assert.deepEqual(calendarDates('2026-10-03', '2027-10-03'), latest.dates);
});

test('整页边界和多页历史连续，最早页与前页重叠且不早于启用周', () => {
  const start = '2024-02-25';
  for (const totalWeeks of [1, 53, 54, 105, 106, 107, 159, 160]) {
    const today = addDays(start, (totalWeeks - 1) * 7 + 6);
    const count = Math.ceil(totalWeeks / 53);
    const covered = new Set();
    for (let index = 0; index < count; index++) {
      const page = calendarPage('2024-02-29', today, index);
      assert.equal(page.pageCount, count);
      assert.equal(page.pageIndex, index);
      assert.equal(page.dates.length, 371);
      assert.ok(page.dates[0] >= start);
      assert.equal(new Date(`${page.dates[0]}T12:00:00Z`).getUTCDay(), 0);
      for (let day = 0; day < page.dates.length; day++) {
        assert.equal(page.dates[day], addDays(page.dates[0], day));
        covered.add(page.dates[day]);
      }
    }
    for (let day = 0; day < totalWeeks * 7; day++) assert.ok(covered.has(addDays(start, day)));
    assert.equal(calendarPage('2024-02-29', today, -1).pageIndex, 0);
    const oldest = calendarPage('2024-02-29', today, count + 1);
    assert.equal(oldest.pageIndex, count - 1);
    assert.equal(oldest.dates[0], start);
  }
});

test('颜色按正贡献分位数分档，相同贡献同色、零贡献灰色', () => {
  const thresholds = colorThresholds({ a: 0, b: 1, c: 2, d: 3, e: 4 });
  assert.deepEqual(thresholds, [1, 2, 3]);
  assert.deepEqual([0, 1, 2, 3, 4].map(value => colorLevel(value, thresholds)), [0, 1, 2, 3, 4]);
  assert.deepEqual(colorThresholds({ a: 2, b: 2 }), [2, 2, 2]);
  assert.equal(colorLevel(2, [2, 2, 2]), 1);
  assert.equal(colorLevel(0, []), 0);
  assert.equal(colorLevel(1, []), 1);
});

test('已保存的旧统计仍可读取，损坏的预保存状态拒绝覆盖', () => {
  const state = recordContribution(first(), '2026-10-01');
  assert.equal(validateState(state), state);
  const pending = { id: 'editing', date: '2026-10-01', lastChangedAt: new Date(2026, 9, 1, 12).getTime() };
  validateState({ ...state, pendingContribution: pending });
  for (const invalid of [{ ...pending, id: '' }, { ...pending, lastChangedAt: -1 },
    { ...pending, date: '2026-10-02' }, { ...pending, extra: true }]) {
    assert.throws(() => validateState({ ...state, pendingContribution: invalid }), /预保存/);
  }
  assert.throws(() => validateState({ ...first(), pendingContribution: pending }), /预保存/);
  const later = advanceActivity(state, '2026-10-03').state;
  assert.throws(() => validateState({ ...later, pendingContribution: { ...pending, date: '2026-10-02' } }), /预保存/);
});
