import { calendarPage, colorLevel, colorThresholds, dayActivity, addDays, localDate } from './activity.mjs';
import { createTracker } from './tracker.mjs';
import { createIdleScheduler } from './idle.mjs';
import { connectFeishu } from './feishu';
import './index.css';

const grid = document.getElementById('heatmap');
const months = document.getElementById('months');
const status = document.getElementById('status');
const recent = document.getElementById('recent-days');
const idleSeconds = document.getElementById('idle-seconds');
const card = document.querySelector('.heatmap-card');
const chartScroll = document.querySelector('.chart-scroll');
const olderPage = document.getElementById('older-page');
const newerPage = document.getElementById('newer-page');
const SAVE_RETRY_MS = 10000;
let selectedPage = 0;
let displayedResult;
let host;
let tracker;
let idle;
let retryTimer;
let dayCheckInFlight = false;
let disposed = false;

function describe(day) {
  if (day.status === 'pending') return `${day.delta} · pending（未结算）`;
  if (day.status === 'no-data') return '无数据';
  if (day.status === 'future') return '未来日期';
  return `${day.delta} · 已结算`;
}

function updateChartLayout() {
  // Leave room for weekday labels, gaps and the pending cell's outline.
  const cellSize = Math.max(10, Math.floor((chartScroll.clientWidth - 4 - 28 - 52 * 3) / 53 * 1000) / 1000);
  const size = `${cellSize}px`;
  if (card.style.getPropertyValue('--cell-size') !== size) card.style.setProperty('--cell-size', size);
  for (const label of months.children) {
    label.style.visibility = label.scrollWidth > label.clientWidth ? 'hidden' : 'visible';
  }
}

function renderMonths(dates) {
  months.replaceChildren();
  const boundaries = [];
  dates.forEach((date, index) => {
    if (index !== 0 && !date.endsWith('-01')) return;
    const column = Math.floor(index / 7);
    const month = date.slice(0, 7);
    // A partial opening month may share a column with the next month.
    if (boundaries.at(-1)?.column === column) boundaries.pop();
    boundaries.push({ column, month });
  });
  boundaries.forEach(({ column, month }, index) => {
    const label = document.createElement('span');
    const yearBoundary = Number(month.slice(5)) === 1;
    label.textContent = `${yearBoundary ? `${month.slice(0, 4)}年` : ''}${Number(month.slice(5))}月`;
    if (yearBoundary) label.className = 'year-boundary';
    label.style.gridColumn = `${column + 1} / span ${(boundaries[index + 1]?.column ?? 53) - column}`;
    months.append(label);
  });
}

function render(result = { state: null, today: localDate(), savedContributions: null }) {
  displayedResult = result;
  const { state, today } = result;
  const { dates, pageIndex, pageCount } = calendarPage(state?.startedOn ?? today, today, selectedPage);
  selectedPage = pageIndex;
  const thresholds = colorThresholds(state?.history || {});
  grid.replaceChildren();
  renderMonths(dates);
  dates.forEach(date => {
    const day = dayActivity(state, date, today);
    const level = day.status === 'settled' || day.status === 'pending' ? colorLevel(day.delta, thresholds) : 0;
    const cell = document.createElement('span');
    cell.className = `cell level-${level} ${day.status}`;
    cell.dataset.date = date;
    cell.dataset.status = day.status;
    cell.title = `${date}：贡献次数 ${describe(day)}`;
    cell.setAttribute('aria-hidden', 'true');
    grid.append(cell);
  });
  grid.setAttribute('aria-label', `${dates[0]} 至 ${dates.at(-1)} 的每日编辑活跃度；绿色表示贡献次数，今天随贡献次数更新颜色，蓝色轮廓表示当天未结算。`);
  document.getElementById('date-range').textContent = `${today} · 本地日期`;
  document.getElementById('visible-range').textContent = `${dates[0]} 至 ${dates.at(-1)}`;
  document.getElementById('pagination').hidden = pageCount === 1;
  document.getElementById('page-number').textContent = `${pageIndex + 1} / ${pageCount}`;
  olderPage.disabled = pageIndex === pageCount - 1;
  newerPage.disabled = pageIndex === 0;
  document.getElementById('latest-contributions').textContent = state?.latestContributions ?? '—';
  document.getElementById('saved-contributions').textContent = result.savedContributions ?? '—';
  document.getElementById('baseline-contributions').textContent = state?.baselineContributions ?? '—';
  document.getElementById('live-delta').textContent = state?.currentDate === today ? state.latestContributions - state.baselineContributions : '—';
  document.getElementById('current-date').textContent = state?.currentDate ?? '尚未开始';
  document.getElementById('timezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.getElementById('started-on').textContent = state?.startedOn ?? '—';
  recent.replaceChildren();
  for (let offset = -6; offset <= 0; offset += 1) {
    const date = addDays(today, offset);
    const day = dayActivity(state, date, today);
    const row = document.createElement('tr');
    for (const value of [date, day.delta ?? '—', date === today ? 'pending' : day.status === 'settled' ? '已结算' : '无数据']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    recent.append(row);
  }
  updateChartLayout();
}

function changePage(offset) {
  if (disposed) return;
  selectedPage += offset;
  render(displayedResult);
  chartScroll.scrollLeft = 0;
  host?.resize().catch(() => {});
}

olderPage.addEventListener('click', () => changePage(1));
newerPage.addEventListener('click', () => changePage(-1));

function showError(error) {
  if (disposed) return;
  status.textContent = error.message || '读取或保存失败。';
  status.classList.add('error');
}

function scheduleRetry() {
  if (disposed || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    persist(() => tracker.save());
  }, SAVE_RETRY_MS);
}

async function persist(operation, quiet = false) {
  if (disposed) return;
  if (!quiet) {
    status.textContent = '正在保存贡献次数到 Interaction…';
    status.classList.remove('error');
  }
  try {
    const result = await operation();
    if (disposed) return;
    if (quiet && !result.written) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    status.classList.remove('error');
    status.textContent = result.state?.pendingContribution
      ? '本次贡献已预保存；继续编辑仍计为同一次，连续空闲 60 秒后结束。'
      : result.written ? '贡献次数已保存到 Interaction，本次编辑已结束。' : '正在监听文档变化。';
    document.getElementById('updated-at').textContent = new Date().toLocaleTimeString();
  } catch (error) {
    showError(error);
    // Retry persistence only: a presaved session must never increment again.
    scheduleRetry();
  }
}

function checkDay() {
  if (disposed || !idle || dayCheckInFlight) return;
  // Finish a session from the previous day before closing that day's total.
  if (idle.finishIfIdle() || idle.hasPending()) return;
  if (tracker.snapshot().state?.currentDate === localDate()) return;
  dayCheckInFlight = true;
  persist(() => tracker.rollover()).finally(() => { dayCheckInFlight = false; });
}

render();
async function start() {
  let stopListening;
  let heightTimer;
  let dayTimer;
  let idleTimer;
  let layoutFrame;
  let observer;
  function cleanup() {
    if (disposed) return;
    disposed = true;
    idle?.dispose();
    clearTimeout(retryTimer);
    clearTimeout(heightTimer);
    clearInterval(dayTimer);
    clearInterval(idleTimer);
    cancelAnimationFrame(layoutFrame);
    observer?.disconnect();
    document.removeEventListener('visibilitychange', checkDay);
    Promise.resolve().then(() => stopListening?.()).catch(() => {}).finally(() => host?.destroy());
  }
  window.addEventListener('pagehide', cleanup, { once: true });
  observer = new ResizeObserver(() => {
    cancelAnimationFrame(layoutFrame);
    // Changing observed dimensions inside the callback would trigger a resize loop.
    layoutFrame = requestAnimationFrame(() => {
      if (disposed) return;
      updateChartLayout();
      if (!host) return;
      clearTimeout(heightTimer);
      heightTimer = setTimeout(() => host.resize().catch(() => {}), 150);
    });
  });
  observer.observe(card);
  if (LOCAL_PREVIEW) {
    status.textContent = '本地外观预览，无飞书数据。文档变化和贡献存储需在飞书宿主中验证。';
    return;
  }
  try {
    host = await connectFeishu();
    if (disposed) { host.destroy(); return; }
    tracker = createTracker({ ...host, onChange: result => {
      if (!disposed) { render(result); host.resize().catch(() => {}); }
    } });
    await tracker.load();
    if (disposed) return;
    idle = createIdleScheduler({
      restored: tracker.snapshot().state?.pendingContribution,
      presave: session => persist(() => tracker.presave(session)),
      confirm: session => persist(() => tracker.confirm(session)),
      onActivity: session => persist(() => tracker.touch(session), true),
      onError: showError,
    });
    stopListening = await host.listen(event => {
      if (!idle.activity(event)) return;
      idleSeconds.textContent = '0';
      if (!status.classList.contains('error')) status.textContent = '检测到文档变化，空闲 10 秒后预保存，连续空闲 60 秒后结束本次编辑。';
    });
    if (disposed) { await stopListening(); return; }
    idleTimer = setInterval(() => { idleSeconds.textContent = idle.idleSeconds() ?? '—'; }, 1000);
    dayTimer = setInterval(checkDay, 30000);
    document.addEventListener('visibilitychange', checkDay);
    await persist(() => tracker.save());
  } catch (error) {
    showError(error);
    cleanup();
  }
}

start();
