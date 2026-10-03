export const STATE_KEY = 'contributionHeatmapV1';

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

export function validateState(state) {
  if (state === undefined) return null;
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Interaction 统计数据格式无效，已保留原数据。');
  if (state.version !== 1 || !isDateKey(state.startedOn) || !isDateKey(state.currentDate)
    || state.startedOn > state.currentDate || !state.history || Array.isArray(state.history)
    || typeof state.history !== 'object') throw new Error('Interaction 统计数据格式无效，已保留原数据。');
  if (!Number.isSafeInteger(state.baselineContributions) || state.baselineContributions < 0
    || !Number.isSafeInteger(state.latestContributions) || state.latestContributions < state.baselineContributions) {
    throw new Error('保存的贡献次数无效，已保留原数据。');
  }
  const fields = ['version', 'startedOn', 'currentDate', 'baselineContributions', 'latestContributions', 'history', 'pendingContribution'];
  if (Object.keys(state).some(key => !fields.includes(key))) throw new Error('Interaction 统计结构无效，已保留原数据。');
  let total = 0;
  for (const [date, delta] of Object.entries(state.history)) {
    if (!isDateKey(date) || date < state.startedOn || date >= state.currentDate
      || !Number.isSafeInteger(delta) || delta < 0) throw new Error('历史结算数据无效，已保留原数据。');
    total += delta;
  }
  if (!Number.isSafeInteger(total) || total !== state.baselineContributions) throw new Error('历史贡献次数与当日基线不一致，已保留原数据。');
  if (state.pendingContribution != null) {
    const pending = state.pendingContribution;
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)
      || Object.keys(pending).some(key => !['id', 'date', 'lastChangedAt'].includes(key))
      || typeof pending.id !== 'string' || !pending.id
      || !isDateKey(pending.date) || pending.date < state.startedOn || pending.date > state.currentDate
      || !Number.isSafeInteger(pending.lastChangedAt) || pending.lastChangedAt < 0
      || !((pending.date === state.currentDate ? state.latestContributions - state.baselineContributions : state.history[pending.date]) >= 1)) {
      throw new Error('预保存贡献状态无效，已保留原数据。');
    }
  }
  return state;
}

export function advanceActivity(saved, today) {
  if (!isDateKey(today)) throw new Error('当前日期无效。');
  const previous = validateState(saved);
  if (!previous) {
    return { state: { version: 1, startedOn: today, currentDate: today,
      baselineContributions: 0, latestContributions: 0, history: {} }, notice: '' };
  }
  if (today < previous.currentDate) throw new Error('本地日期早于当前统计日期，暂停结算；请检查时区或系统日期。');
  const state = { ...previous, history: { ...previous.history } };
  if (today > previous.currentDate) {
    state.history[previous.currentDate] = previous.latestContributions - previous.baselineContributions;
    for (let date = addDays(previous.currentDate, 1); date < today; date = addDays(date, 1)) {
      if (!Object.hasOwn(state.history, date)) state.history[date] = 0;
    }
    state.currentDate = today;
    state.baselineContributions = state.latestContributions;
  }
  return { state, notice: '' };
}

export function recordContribution(saved, date, today = date) {
  if (!isDateKey(date) || !isDateKey(today) || date > today) throw new Error('贡献日期不能晚于本地今天，且必须是有效日期。');
  const previous = validateState(saved);
  if (previous && today < previous.currentDate) throw new Error('本地日期早于当前统计日期，暂停结算；请检查时区或系统日期。');
  // A slow save can leave confirmed sessions queued across midnight.
  if (previous && date < previous.currentDate) {
    if (date < previous.startedOn || !Object.hasOwn(previous.history, date)) throw new Error('贡献日期不在已启用的统计区间内。');
    if (previous.latestContributions === Number.MAX_SAFE_INTEGER) throw new Error('贡献次数已达到安全整数上限。');
    const state = { ...previous, history: { ...previous.history, [date]: previous.history[date] + 1 },
      latestContributions: previous.latestContributions + 1, baselineContributions: previous.baselineContributions + 1 };
    return advanceActivity(state, today).state;
  }
  const state = advanceActivity(saved, date).state;
  if (state.latestContributions === Number.MAX_SAFE_INTEGER) throw new Error('贡献次数已达到安全整数上限。');
  state.latestContributions += 1;
  return advanceActivity(state, today).state;
}

// Nearest-rank quartiles, based exclusively on settled positive daily deltas.
export function colorThresholds(history) {
  const values = Object.values(history).filter(value => value > 0).sort((a, b) => a - b);
  return values.length ? [0.25, 0.5, 0.75].map(q => values[Math.ceil(values.length * q) - 1]) : [];
}

export function colorLevel(delta, thresholds) {
  if (!(delta > 0)) return 0;
  return 1 + thresholds.filter(threshold => delta > threshold).length;
}

export function dayActivity(state, date, today) {
  if (date > today) return { status: 'future', delta: null };
  if (!state || date < state.startedOn) return { status: 'no-data', delta: null };
  if (date === today && date === state.currentDate) {
    return { status: 'pending', delta: state.latestContributions - state.baselineContributions };
  }
  if (Object.hasOwn(state.history, date)) return { status: 'settled', delta: state.history[date] };
  return { status: 'no-data', delta: null };
}

export function calendarDates(startedOn, today = startedOn, weeks = 26) {
  const weekday = new Date(`${startedOn}T12:00:00Z`).getUTCDay();
  const start = addDays(startedOn, -weekday);
  const elapsedDays = (new Date(`${today}T12:00:00Z`) - new Date(`${start}T12:00:00Z`)) / 86400000;
  const visibleWeeks = Math.max(weeks, Math.floor(elapsedDays / 7) + 1);
  return Array.from({ length: visibleWeeks * 7 }, (_, index) => addDays(start, index));
}
