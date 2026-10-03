export const CONTRIBUTION_IDLE_MINUTES = Object.freeze([1, 3, 5, 10, 30, 60]);
export const DEFAULT_CONTRIBUTION_IDLE_MINUTES = 1;

export function contributionIdleMs(minutes) {
  if (!CONTRIBUTION_IDLE_MINUTES.includes(minutes)) {
    throw new Error('贡献计时规则无效，仅支持 1、3、5、10、30、60 分钟，已保留原数据。');
  }
  return minutes * 60 * 1000;
}
