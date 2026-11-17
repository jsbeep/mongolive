// 시작할 때의 경고 (9-7b) — Monitor › Server의 Startup warnings 카드
//
// mongod·mongos는 켜질 때 설정 문제를 로그에 'startupWarnings'로 따로 모아 둔다(인증 꺼짐, root로 실행, 파일 한도 낮음,
// transparent huge pages 등). getLog: 'startupWarnings'로 그 줄들을 읽기만 한다 — 화면이 열 때와 새로고침 버튼을 누를 때만.
// 4.4+는 줄마다 JSON(구조화 로그: t·s·c·id·msg·attr), 그 전엔 글자 그대로 보여 준다.
// 연결한 멤버(primary가 없으면 다른 멤버)의 경고다. 권한: getLog 액션(clusterMonitor) — 없으면 안내.
import type { MongoClient } from 'mongodb';
import type { StartupWarning, StartupWarningsReport } from '@mongolive/shared';
import { isUnauthorized } from './operations';
import { withTimeout } from './sampler';

const COMMAND_NOT_FOUND = 59;
const ATLAS_ERROR = 8000;
// 옛 글자 로그의 앞부분: '2020-08-10T09:00:00.000+0000 I  CONTROL  [initandlisten] '
const LEGACY_PREFIX = /^(\S+)\s+([A-Z]\d?)\s+(\S+)\s+\[[^\]]*\]\s?/;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown) => Number((e as { code?: unknown })?.code);

// {"$date": "..."} 또는 {"$date": {"$numberLong": "..."}} → ms
const dateOf = (t: unknown): number | null => {
  const raw = (t as { $date?: unknown } | null)?.$date;
  const value = typeof raw === 'object' && raw !== null ? Number((raw as { $numberLong?: unknown }).$numberLong) : raw;
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const flatten = (attr: unknown): Record<string, string> => {
  if (!attr || typeof attr !== 'object') return {};
  return Object.fromEntries(Object.entries(attr).map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)]));
};

export const parseStartupWarnings = (lines: unknown[]): StartupWarning[] => {
  const out: StartupWarning[] = [];
  for (const line of lines) {
    if (typeof line !== 'string' || line.trim() === '') continue;
    if (line.startsWith('{')) {
      try {
        const doc = JSON.parse(line) as Record<string, unknown>;
        out.push({
          at: dateOf(doc.t),
          severity: typeof doc.s === 'string' ? doc.s : null,
          component: typeof doc.c === 'string' ? doc.c : null,
          id: typeof doc.id === 'number' ? doc.id : null,
          message: typeof doc.msg === 'string' ? doc.msg : line,
          attr: flatten(doc.attr),
        });
        continue;
      } catch {
        // JSON이 아니면 아래에서 글자로
      }
    }
    const legacy = LEGACY_PREFIX.exec(line);
    const message = (legacy ? line.slice(legacy[0].length) : line).trim();
    if (message === '') continue;
    const at = legacy ? Date.parse(legacy[1]) : NaN;
    out.push({ at: Number.isFinite(at) ? at : null, severity: legacy?.[2] ?? null, component: legacy?.[3] ?? null, id: null, message, attr: {} });
  }
  return out;
};

export const readStartupWarnings = async (client: () => Promise<MongoClient>, clock: () => number = Date.now): Promise<StartupWarningsReport> => {
  const at = clock();
  try {
    const c = await client();
    const reply = await withTimeout(c.db('admin').command({ getLog: 'startupWarnings' }, { readPreference: 'primaryPreferred' }));
    return { status: 'ok', error: null, at, warnings: parseStartupWarnings(Array.isArray(reply.log) ? reply.log : []) };
  } catch (e) {
    if (isUnauthorized(e)) return { status: 'denied', error: null, at, warnings: [] };
    if (codeOf(e) === COMMAND_NOT_FOUND || codeOf(e) === ATLAS_ERROR) return { status: 'unsupported', error: null, at, warnings: [] };
    return { status: 'error', error: errorMessage(e), at, warnings: [] };
  }
};
