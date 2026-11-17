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

// 크기: 512 B / 12.3 KB / 4.5 MB / 1.2 GB / 2 TB
export const fmtBytes = (value: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(value);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const text = i === 0 ? String(Math.round(v)) : trim(v.toFixed(v < 10 ? 2 : 1));
  return `${value < 0 ? '-' : ''}${text} ${units[i]}`;
};

// 늘고 준 크기: +1.2 MB / -340 KB / 0 B
export const fmtBytesDelta = (value: number): string => (value > 0 ? `+${fmtBytes(value)}` : fmtBytes(value));

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
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 날짜 — 11/16, 11/16 14:05
export const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
export const fmtDateTime = (ms: number): string => `${fmtDate(ms)} ${fmtClock(ms)}`;

// 시간 축 눈금 — 창 길이에 맞춰 간격을 고르고(눈금 8개 이하), 이 브라우저 시간대의 시·자정에 맞춘다
const STEPS = [2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 5 * DAY, 7 * DAY, 15 * DAY, 30 * DAY, 90 * DAY, 365 * DAY];
export const timeTicks = (start: number, end: number): { t: number; label: string }[] => {
  const span = end - start;
  const step = STEPS.find((s) => span / s <= 8) ?? STEPS[STEPS.length - 1];
  const out: { t: number; label: string }[] = [];
  if (step < HOUR) {
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) out.push({ t, label: fmtClock(t) });
    return out;
  }
  if (step < DAY) {
    // 시 단위 — 그 간격의 배수 시각(0·3·6…시)
    const hours = step / HOUR;
    const d = new Date(start);
    d.setMinutes(0, 0, 0);
    while (d.getTime() < start || d.getHours() % hours !== 0) d.setHours(d.getHours() + 1);
    for (; d.getTime() <= end; d.setHours(d.getHours() + hours)) out.push({ t: d.getTime(), label: d.getHours() === 0 ? fmtDate(d.getTime()) : fmtClock(d.getTime()) });
    return out;
  }
  // 일 단위 — 자정. 여러 날 간격이면 1월 1일부터 센 날짜로 고른다(달이 바뀌어도 간격이 일정하게)
  const days = Math.round(step / DAY);
  const d = new Date(start);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() < start) d.setDate(d.getDate() + 1);
  const dayOfYear = (x: Date) => Math.round((x.getTime() - new Date(x.getFullYear(), 0, 1).getTime()) / DAY);
  for (; d.getTime() <= end; d.setDate(d.getDate() + 1)) {
    if (days === 1 || dayOfYear(d) % days === 0) out.push({ t: d.getTime(), label: fmtDate(d.getTime()) });
  }
  return out;
};

// 지난 시각 — 짧게: now / 12s / 3m / 2h / 3d
export const fmtAgo = (at: number, now: number): string => {
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 10) return 'now';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
};

// 기간 이름 — 범위 바·제목
export const RANGE_LABEL = {
  '5m': 'Last 5 min',
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All history',
} as const;

// 칸 길이 이름 — 5 min / 1 hour / 6 hours / 1 day
export const fmtSpan = (ms: number): string => {
  if (ms >= DAY) return `${Math.round(ms / DAY)} day${ms >= 2 * DAY ? 's' : ''}`;
  if (ms >= HOUR) return `${Math.round(ms / HOUR)} hour${ms >= 2 * HOUR ? 's' : ''}`;
  return `${Math.round(ms / MINUTE)} min`;
};

// 걸린 시간 — 3h 20m / 2d 4h
export const fmtDuration = (ms: number): string => {
  const m = Math.round(ms / MINUTE);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
