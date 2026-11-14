// "3m ago" 같은 짧은 상대 시각 — 쿼리 기록, 최근 연결
export const timeAgo = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
