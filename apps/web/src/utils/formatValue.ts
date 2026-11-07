// 값 표시 형식(설정 창의 '값 표시') — Date 시간대, ObjectId 줄임/생성 시각.
// MongoDB는 Date를 UTC 밀리초로 저장한다. 표시만 바꾸고 저장 값은 건드리지 않는다.
import type { DateDisplay, OidDisplay } from '../services/preferences';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

// 이 기기의 시간대 오프셋 — "UTC+9", "UTC-3:30"
export const offsetLabel = (ms: number = Date.now()): string => {
  const minutes = -new Date(ms).getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ''}`;
};

const parts = (d: Date, utc: boolean) =>
  utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];

// "2026-11-08 22:42:25.123"
const stamp = (d: Date, utc: boolean) => {
  const [y, mo, da, h, mi, s, ms] = parts(d, utc);
  return `${y}-${pad(mo)}-${pad(da)} ${pad(h)}:${pad(mi)}:${pad(s)}.${pad(ms, 3)}`;
};

export const formatDate = (ms: number, mode: DateDisplay): string => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  if (mode === 'iso') return d.toISOString();
  if (mode === 'utc') return `${stamp(d, true)} UTC`;
  return `${stamp(d, false)} ${offsetLabel(ms)}`;
};

// 툴팁 — 세 가지를 다 보여 준다(어느 걸로 보고 있든 헷갈리지 않게)
export const dateTooltip = (ms: number): string =>
  [formatDate(ms, 'local'), formatDate(ms, 'utc'), formatDate(ms, 'iso')].join('\n');

// datetime-local 입력과 주고받기 — 표시 설정과 같은 시간대로(iso는 UTC). 밀리초까지 남긴다.
// "YYYY-MM-DDTHH:mm:ss.SSS"
export const toDateInput = (ms: number, mode: DateDisplay): string => {
  const [y, mo, da, h, mi, s, msec] = parts(new Date(ms), mode !== 'local');
  return `${y}-${pad(mo)}-${pad(da)}T${pad(h)}:${pad(mi)}:${pad(s)}.${pad(msec, 3)}`;
};
export const fromDateInput = (value: string, mode: DateDisplay): number =>
  // 시간대 표시가 없는 문자열은 브라우저가 이 기기 시간으로 읽는다 — UTC로 읽으려면 Z를 붙인다
  mode === 'local' ? new Date(value).getTime() : Date.parse(`${value}Z`);
export const dateInputZone = (mode: DateDisplay): string => (mode === 'local' ? offsetLabel() : 'UTC');

// ObjectId 앞 8자리(hex) = 만든 시각(초)
export const oidCreatedAt = (hex: string): number | null => {
  const seconds = Number.parseInt(hex.slice(0, 8), 16);
  return /^[0-9a-f]{24}$/i.test(hex) && Number.isFinite(seconds) ? seconds * 1000 : null;
};

export const formatOid = (hex: string, mode: OidDisplay): string => (mode === 'short' && hex.length > 8 ? `…${hex.slice(-8)}` : hex);

export const oidTooltip = (hex: string, dateMode: DateDisplay): string => {
  const created = oidCreatedAt(hex);
  return created === null ? hex : `${hex}\nCreated ${formatDate(created, dateMode)}`;
};
