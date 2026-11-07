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

// "2026-11-08 22:42:25" (+ ".123")
const stamp = (d: Date, utc: boolean, withMs: boolean) => {
  const [y, mo, da, h, mi, s, ms] = parts(d, utc);
  return `${y}-${pad(mo)}-${pad(da)} ${pad(h)}:${pad(mi)}:${pad(s)}${withMs ? `.${pad(ms, 3)}` : ''}`;
};

// iso = '저장된 그대로'라서 밀리초 설정과 상관없이 늘 전부 보여 준다
export const formatDate = (ms: number, mode: DateDisplay, withMs = true): string => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  if (mode === 'iso') return d.toISOString();
  if (mode === 'utc') return `${stamp(d, true, withMs)} UTC`;
  return `${stamp(d, false, withMs)} ${offsetLabel(ms)}`;
};

// 툴팁 — 세 가지를 밀리초까지 다 보여 준다(어느 걸로 보고 있든 헷갈리지 않게)
export const dateTooltip = (ms: number): string =>
  [formatDate(ms, 'local'), formatDate(ms, 'utc'), formatDate(ms, 'iso')].join('\n');

// datetime-local 입력과 주고받기 — 표시 설정과 같은 시간대로(iso는 UTC).
// "YYYY-MM-DDTHH:mm:ss" (+ ".SSS" — 밀리초를 보일 때)
export const toDateInput = (ms: number, mode: DateDisplay, withMs: boolean): string => {
  const [y, mo, da, h, mi, s, msec] = parts(new Date(ms), mode !== 'local');
  return `${y}-${pad(mo)}-${pad(da)}T${pad(h)}:${pad(mi)}:${pad(s)}${withMs ? `.${pad(msec, 3)}` : ''}`;
};
// keepMsFrom: 밀리초를 안 보이게 편집한 경우, 원래 값의 밀리초를 이어 붙인다(분만 고쳐도 .484가 남게).
// 입력에 밀리초가 있으면(밀리초를 보일 때) 입력한 그대로.
export const fromDateInput = (value: string, mode: DateDisplay, keepMsFrom?: number): number => {
  // 시간대 표시가 없는 문자열은 브라우저가 이 기기 시간으로 읽는다 — UTC로 읽으려면 Z를 붙인다
  const ms = mode === 'local' ? new Date(value).getTime() : Date.parse(`${value}Z`);
  if (keepMsFrom === undefined || value.includes('.') || Number.isNaN(ms)) return ms;
  return ms + (((keepMsFrom % 1000) + 1000) % 1000);
};
export const dateInputZone = (mode: DateDisplay): string => (mode === 'local' ? offsetLabel() : 'UTC');

// ObjectId 앞 8자리(hex) = 만든 시각(초)
export const oidCreatedAt = (hex: string): number | null => {
  const seconds = Number.parseInt(hex.slice(0, 8), 16);
  return /^[0-9a-f]{24}$/i.test(hex) && Number.isFinite(seconds) ? seconds * 1000 : null;
};

export const formatOid = (hex: string, mode: OidDisplay): string => (mode === 'short' && hex.length > 8 ? `…${hex.slice(-8)}` : hex);

export const oidTooltip = (hex: string, dateMode: DateDisplay): string => {
  const created = oidCreatedAt(hex);
  // 만든 시각은 초 단위라 밀리초는 뺀다
  return created === null ? hex : `${hex}\nCreated ${formatDate(created, dateMode, false)}`;
};
