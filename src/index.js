import { calendarPage, colorLevel, colorThresholds, dayActivity, addDays, localDate } from './activity.mjs';
import { createTracker } from './tracker.mjs';
import { createIdleScheduler } from './idle.mjs';
import { CONTRIBUTION_IDLE_MINUTES, DEFAULT_CONTRIBUTION_IDLE_MINUTES } from './contribution.mjs';
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
let renderedChart;
let host;
let tracker;
let idle;
let retryTimer;
let dayCheckInFlight = false;
let disposed = false;
let previewReady = false;
let previewContributionIdleMinutes = DEFAULT_CONTRIBUTION_IDLE_MINUTES;
let statusMode = 'connecting';

const ruleButtons = CONTRIBUTION_IDLE_MINUTES.map(minutes => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `${minutes} 分钟`;
  button.dataset.minutes = minutes;
  button.addEventListener('click', () => {
    if (button.disabled || disposed) return;
    if (LOCAL_PREVIEW) {
      previewContributionIdleMinutes = minutes;
      render(displayedResult);
      return;
    }
    persist(() => tracker.setContributionIdleMinutes(minutes), false, 'configuration');
  });
  document.getElementById('contribution-rules').append(button);
  return button;
});

function currentContributionIdleMinutes() {
  return displayedResult?.state?.contributionIdleMinutes ?? previewContributionIdleMinutes;
}

function sessionStatus() {
  const minutes = currentContributionIdleMinutes();
  if (idle?.hasPending() ?? Boolean(displayedResult?.state?.pendingContribution)) {
    return displayedResult?.state?.pendingContribution
      ? `本次贡献已预保存；继续编辑仍计为同一次，连续空闲 ${minutes} 分钟后结束。`
      : `检测到文档变化，空闲 10 秒后预保存，连续空闲 ${minutes} 分钟后结束本次编辑。`;
  }
  return '正在监听文档变化。';
}

function renderStatus() {
  if (status.classList.contains('error') || statusMode === 'connecting') return;
  const minutes = currentContributionIdleMinutes();
  if (statusMode === 'preview') {
    status.textContent = `本地外观预览，当前计时规则为 ${minutes} 分钟，仅在本页面生效，未写入飞书数据。文档变化和贡献存储需在飞书宿主中验证。`;
  } else if (statusMode === 'configuration-saving') {
    status.textContent = `正在保存计时规则到 Interaction，当前规则为 ${minutes} 分钟。`;
  } else if (statusMode === 'configuration-saved') {
    status.textContent = `计时规则已保存到 Interaction，当前规则为 ${minutes} 分钟。${sessionStatus()}`;
  } else if (statusMode === 'contribution-saving') {
    status.textContent = '正在保存贡献次数到 Interaction…';
  } else {
    status.textContent = statusMode === 'contribution-saved'
      ? `贡献次数已保存到 Interaction。${sessionStatus()}` : sessionStatus();
  }
}

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

function renderControls(result) {
  const { state, today } = result;
  const minutes = currentContributionIdleMinutes();
  for (const button of ruleButtons) {
    const selected = Number(button.dataset.minutes) === minutes;
    button.disabled = disposed || !(result.loaded || previewReady) || selected;
    button.setAttribute('aria-pressed', String(selected));
  }
  document.getElementById('contribution-rule-explanation').textContent = `空闲 10 秒时贡献加 1 并预保存到 Interaction；${minutes} 分钟内继续编辑仍计为同一次，连续空闲 ${minutes} 分钟后结束。保存失败会自动重试；pending 表示当天未结算。`;
  renderStatus();
  document.getElementById('latest-contributions').textContent = state?.latestContributions ?? '—';
  document.getElementById('saved-contributions').textContent = result.savedContributions ?? '—';
  document.getElementById('baseline-contributions').textContent = state?.baselineContributions ?? '—';
  document.getElementById('live-delta').textContent = state?.currentDate === today ? state.latestContributions - state.baselineContributions : '—';
  document.getElementById('current-date').textContent = state?.currentDate ?? '尚未开始';
  document.getElementById('timezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  document.getElementById('started-on').textContent = state?.startedOn ?? '—';
}

function renderChart({ state, today }) {
  const hasState = Boolean(state);
  const startedOn = state?.startedOn ?? today;
  const delta = state?.currentDate === today ? state.latestContributions - state.baselineContributions : null;
  const history = state?.history ?? {};
  // Snapshots are cloned; compare display values, never session metadata or object identity.
  if (renderedChart && renderedChart.hasState === hasState && renderedChart.startedOn === startedOn
    && renderedChart.today === today && renderedChart.pageIndex === selectedPage && renderedChart.delta === delta) {
    const dates = Object.keys(history);
    if (dates.length === Object.keys(renderedChart.history).length
      && dates.every(date => Object.hasOwn(renderedChart.history, date) && renderedChart.history[date] === history[date])) return;
  }
  const { dates, pageIndex, pageCount } = calendarPage(state?.startedOn ?? today, today, selectedPage);
  selectedPage = pageIndex;
  const thresholds = colorThresholds(history);
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
  renderedChart = { hasState, startedOn, today, pageIndex, delta, history: { ...history } };
}

function render(result = { state: null, today: localDate(), savedContributions: null }) {
  displayedResult = result;
  renderControls(result);
  renderChart(result);
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
    const snapshot = tracker.snapshot();
    const kind = snapshot.state.contributionIdleMinutes !== snapshot.savedContributionIdleMinutes ? 'configuration' : 'contribution';
    persist(() => tracker.save(), false, kind);
  }, SAVE_RETRY_MS);
}

async function persist(operation, quiet = false, kind = 'contribution') {
  if (disposed) return;
  if (!quiet) {
    statusMode = `${kind}-saving`;
    renderStatus();
  }
  try {
    const result = await operation();
    if (disposed) return;
    if (quiet && !result.written) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    status.classList.remove('error');
    statusMode = kind === 'configuration' ? 'configuration-saved' : result.written ? 'contribution-saved' : 'idle';
    renderStatus();
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
    for (const button of ruleButtons) button.disabled = true;
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
    previewReady = true;
    statusMode = 'preview';
    render(displayedResult);
    return;
  }
  try {
    host = await connectFeishu();
    if (disposed) { host.destroy(); return; }
    tracker = createTracker({ ...host, onChange: result => {
      if (!disposed) {
        idle?.setContributionIdleMinutes(result.state.contributionIdleMinutes);
        idleSeconds.textContent = idle?.idleSeconds() ?? '—';
        render(result);
        host.resize().catch(() => {});
      }
    } });
    await tracker.load();
    if (disposed) return;
    idle = createIdleScheduler({
      restored: tracker.snapshot().state?.pendingContribution,
      contributionIdleMinutes: tracker.snapshot().state.contributionIdleMinutes,
      presave: session => persist(() => tracker.presave(session)),
      confirm: session => persist(() => tracker.confirm(session)),
      onActivity: session => persist(() => tracker.touch(session), true),
      onError: showError,
    });
    stopListening = await host.listen(event => {
      if (!idle.activity(event)) return;
      idleSeconds.textContent = '0';
      statusMode = 'editing';
      renderStatus();
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
