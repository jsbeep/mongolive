// Changes 탭의 묶기 — 최신이 앞인 기록을 화면의 줄로
//   트랜잭션: txn이 같은 연속 기록(쓰기 2개 이상)은 한 묶음 — 그 안에서 다시 아래 규칙으로 묶는다(9-8b)
//            쓰기 하나뿐인 트랜잭션은 보통 기록처럼(이웃과 묶일 수 있게) — 줄에 tx 표시만
//   INSERT·DELETE — 같은 컬렉션이면 / UPDATE·REPLACE — 같은 문서면 (내 저장 / 남의 변경은 따로)
import type { LiveLogEntry } from '../../types/explorer';

export interface EntryGroup {
  kind: 'group';
  // 묶음의 가장 오래된 기록 id — 새 기록은 위(최신 쪽)에 붙으므로 펼침 상태가 유지된다
  key: string;
  match: string | null;
  entries: LiveLogEntry[];
}

export interface TxnGroup {
  kind: 'txn';
  // 'txn:' + 가장 오래된 기록 id — 안쪽 묶음의 key와 겹치지 않게
  key: string;
  txn: string;
  entries: LiveLogEntry[];
  groups: EntryGroup[];
}

export type LogItem = EntryGroup | TxnGroup;

// 묶음 기준 — 같은 값이면 연달아 온 기록을 한 줄로. null = 묶지 않음(구조 변경 등)
export const groupMatch = (e: LiveLogEntry): string | null => {
  const who = e.own ? 'own' : 'ext';
  if (e.op === 'insert' || e.op === 'delete') return e.collection ? `${e.op}\u0000${e.database}\u0000${e.collection}\u0000${who}` : null;
  if (e.documentId) return `doc\u0000${e.database}\u0000${e.collection}\u0000${e.documentId}\u0000${who}`;
  return null;
};

export const groupEntries = (list: LiveLogEntry[]): EntryGroup[] => {
  const out: EntryGroup[] = [];
  for (const e of list) {
    const match = groupMatch(e);
    const last = out[out.length - 1];
    if (match && last && last.match === match) {
      last.entries.push(e);
      last.key = e.id;
    } else {
      out.push({ kind: 'group', key: e.id, match, entries: [e] });
    }
  }
  return out;
};

export const buildItems = (visible: LiveLogEntry[]): LogItem[] => {
  const out: LogItem[] = [];
  let loose: LiveLogEntry[] = [];
  const flush = () => {
    if (loose.length) out.push(...groupEntries(loose));
    loose = [];
  };
  let i = 0;
  while (i < visible.length) {
    const txn = visible[i].txn;
    let j = i + 1;
    if (txn) while (j < visible.length && visible[j].txn === txn) j += 1;
    const run = visible.slice(i, j);
    if (txn && run.length > 1) {
      flush();
      out.push({ kind: 'txn', key: `txn:${run[run.length - 1].id}`, txn, entries: run, groups: groupEntries(run) });
    } else {
      loose.push(...run);
    }
    i = j;
  }
  flush();
  return out;
};

// 트랜잭션별 쓰기 수(거르기 전 전체) — 범위·종류로 걸러 일부만 보일 때 '5개 중 3개'를 알린다
export const txnTotals = (entries: LiveLogEntry[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const e of entries) if (e.txn) out.set(e.txn, (out.get(e.txn) ?? 0) + 1);
  return out;
};

// 트랜잭션 묶음 한 줄 — 위치(한 DB면 'shop · orders, stock')와 연산 수('2 inserts, 1 update')
export const txnSummary = (entries: LiveLogEntry[]) => {
  const dbs = new Set<string>();
  const namespaces: string[] = [];
  const ops = { insert: 0, update: 0, delete: 0, other: 0 };
  // 오래된 것부터 — 트랜잭션 안에서 쓴 차례대로
  for (const e of [...entries].reverse()) {
    dbs.add(e.database);
    const ns = e.collection ? `${e.database}.${e.collection}` : e.database;
    if (!namespaces.includes(ns)) namespaces.push(ns);
    if (e.op === 'insert') ops.insert += 1;
    else if (e.op === 'update' || e.op === 'replace') ops.update += 1;
    else if (e.op === 'delete') ops.delete += 1;
    else ops.other += 1;
  }
  const [db] = dbs;
  const where = dbs.size === 1 ? `${db} · ${namespaces.map((ns) => ns.slice(db.length + 1) || db).join(', ')}` : namespaces.join(', ');
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [
    ops.insert ? plural(ops.insert, 'insert') : '',
    ops.update ? plural(ops.update, 'update') : '',
    ops.delete ? plural(ops.delete, 'delete') : '',
    ops.other ? plural(ops.other, 'other change') : '',
  ].filter(Boolean);
  return { where, ops: parts.join(', ') };
};
