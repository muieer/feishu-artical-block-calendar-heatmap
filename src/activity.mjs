export const STATE_KEY = 'revisionHeatmapV1';

export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function isDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

// UTC is used only for arithmetic on calendar labels, never to determine today.
export function addDays(date, days) {
  if (!isDateKey(date)) throw new Error('统计日期无效。');
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function revisionNumber(value) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('revision_id 必须是非负安全整数。');
  return number;
}

export function validateState(state) {
  if (state === undefined || state === null) return null;
  if (state.version !== 1 || !isDateKey(state.startedOn) || !isDateKey(state.currentDate)
    || state.startedOn > state.currentDate || !state.history || Array.isArray(state.history)
    || typeof state.history !== 'object') throw new Error('Interaction 统计数据格式无效，已保留原数据。');
  if (!Number.isSafeInteger(state.baselineRevision) || !Number.isSafeInteger(state.latestRevision)) {
    throw new Error('保存的 revision 格式无效，已保留原数据。');
  }
  revisionNumber(state.baselineRevision);
  revisionNumber(state.latestRevision);
  if (state.latestRevision < state.baselineRevision) throw new Error('保存的 revision 基准无效，已保留原数据。');
  for (const [date, delta] of Object.entries(state.history)) {
    if (!isDateKey(date) || date < state.startedOn || date >= state.currentDate
      || !Number.isSafeInteger(delta) || delta < 0) throw new Error('历史结算数据无效，已保留原数据。');
  }
  return state;
}

export function advanceActivity(saved, today, revision) {
  if (!isDateKey(today)) throw new Error('当前日期无效。');
  revision = revisionNumber(revision);
  const previous = validateState(saved);
  if (!previous) {
    return { state: { version: 1, startedOn: today, currentDate: today,
      baselineRevision: revision, latestRevision: revision, history: {} }, notice: '' };
  }
  if (today < previous.currentDate) throw new Error('本地日期早于当前统计日期，暂停结算；请检查时区或系统日期。');
  const state = { ...previous, history: { ...previous.history }, latestRevision: revision };
  if (revision < previous.baselineRevision || revision < previous.latestRevision) {
    state.currentDate = today;
    state.baselineRevision = revision;
    state.lastReset = { date: today, previousRevision: previous.latestRevision, revision };
    return { state, notice: '检测到 revision 回退，已重建基准；已有历史不变，无法结算的日期保留为无数据。' };
  }
  if (today > previous.currentDate) {
    // The first observation on T+1 (or later) closes the previous observed day.
    state.history[previous.currentDate] = revision - previous.baselineRevision;
    for (let date = addDays(previous.currentDate, 1); date < today; date = addDays(date, 1)) {
      if (!Object.hasOwn(state.history, date)) state.history[date] = 0;
    }
    state.currentDate = today;
    state.baselineRevision = revision;
  }
  return { state, notice: '' };
}

// Nearest-rank quartiles, based exclusively on settled positive daily deltas.
export function colorThresholds(history) {
  const values = Object.values(history).filter(value => value > 0).sort((a, b) => a - b);
  return values.length ? [0.25, 0.5, 0.75].map(q => values[Math.ceil(values.length * q) - 1]) : [];
}

export function colorLevel(delta, thresholds) {
  if (!(delta > 0) || !thresholds.length) return 0;
  return 1 + thresholds.filter(threshold => delta > threshold).length;
}

export function dayActivity(state, date, today, revision = state?.latestRevision) {
  if (date > today) return { status: 'future', delta: null };
  if (!state || date < state.startedOn) return { status: 'no-data', delta: null };
  if (date === today && date === state.currentDate) {
    return { status: 'pending', delta: Math.max(0, revisionNumber(revision) - state.baselineRevision) };
  }
  if (Object.hasOwn(state.history, date)) return { status: 'settled', delta: state.history[date] };
  return { status: 'no-data', delta: null };
}

export function calendarDates(today, weeks = 26) {
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const start = addDays(today, -weekday - (weeks - 1) * 7);
  return Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index));
}
