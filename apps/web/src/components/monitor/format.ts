// Monitor 화면의 숫자 모양 — 작은 값은 소수까지, 큰 값은 줄여서(12.3K)

const trim = (text: string) => (text.includes('.') ? text.replace(/\.?0+$/, '') : text);

// 초당 값·개수: 0 / 0.25 / 3.5 / 42 / 1,234 / 12.3K / 4.5M
export const fmtNumber = (value: number): string => {
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs < 1) return trim(value.toFixed(2));
  if (abs < 10) return trim(value.toFixed(1));
  if (abs < 10_000) return Math.round(value).toLocaleString('en-US');
  if (abs < 1_000_000) return `${trim((value / 1000).toFixed(1))}K`;
  return `${trim((value / 1_000_000).toFixed(1))}M`;
};

// 지연: 0.42 ms / 3.2 ms / 42 ms / 1.2 s
export const fmtMs = (value: number): string => {
  if (value >= 1000) return `${trim((value / 1000).toFixed(1))} s`;
  if (value >= 10) return `${Math.round(value)} ms`;
  if (value >= 1) return `${trim(value.toFixed(1))} ms`;
  return `${trim(value.toFixed(2))} ms`;
};

// 초당 바이트: 512 B/s / 12.3 KB/s / 1.2 MB/s
export const fmtBytesRate = (value: number): string => {
  if (value < 1024) return `${Math.round(value)} B/s`;
  if (value < 1024 * 1024) return `${trim((value / 1024).toFixed(1))} KB/s`;
  return `${trim((value / 1024 / 1024).toFixed(1))} MB/s`;
};

export const fmtUptime = (sec: number): string => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const pad = (n: number) => String(n).padStart(2, '0');
// 시간 축·툴팁 — 이 브라우저의 시간대
export const fmtClock = (ms: number, seconds = false): string => {
  const d = new Date(ms);
  return seconds ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// 차트 시간 창 — 기록이 짧으면(막 연결함) 10분부터 시작해 5분 단위로 늘리고 1시간에서 멈춘다.
// 1시간 창에 1분치만 그리면 선이 오른쪽 끝에 몰려 읽을 수 없어서
const MINUTE = 60_000;
export const MAX_WINDOW_MS = 60 * MINUTE;
export const chartWindow = (firstAt: number | undefined, now: number): { ms: number; label: string } => {
  const span = firstAt === undefined ? 0 : now - firstAt;
  const ms = Math.min(MAX_WINDOW_MS, Math.max(10 * MINUTE, Math.ceil(span / (5 * MINUTE)) * 5 * MINUTE));
  return { ms, label: ms === MAX_WINDOW_MS ? 'Last hour' : `Last ${ms / MINUTE} min` };
};
// 시간 축 눈금 간격 — 창이 짧으면 촘촘하게
export const tickStepFor = (windowMs: number): number => (windowMs <= 15 * MINUTE ? 2 * MINUTE : windowMs <= 30 * MINUTE ? 5 * MINUTE : 15 * MINUTE);

// 지난 시각 — 짧게: now / 12s / 3m / 2h / 3d
export const fmtAgo = (at: number, now: number): string => {
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 10) return 'now';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
};
