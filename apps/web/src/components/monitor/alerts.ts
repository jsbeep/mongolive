// 알림(9-8a)의 글자와 이동할 곳 — 토스트(page.tsx)와 Alerts 카드가 같이 쓴다
import type { AlertKind, MonitorAlert } from '../../types/explorer';
import type { MonitorScope } from './ScopeBar';

const count = (n: number) => n.toLocaleString('en-US');
const ns = (database: string, collection: string) => `${database}.${collection}`;

export const ALERT_LABEL: Record<AlertKind, string> = {
  'mass-delete': 'Mass delete',
  burst: 'Write burst',
  drop: 'Dropped',
  'drop-database': 'DB dropped',
  rename: 'Renamed',
};

// 대상 — shop.orders / shop · 3 collections / shop → shop.new
export const alertTarget = (a: MonitorAlert): string => {
  if (a.kind === 'drop-database') return a.database;
  if (a.kind === 'drop' && a.count > 1) return `${a.database} · ${count(a.count)} collections`;
  if (a.kind === 'rename' && a.to) {
    const to = a.to.database === a.database ? a.to.collection : ns(a.to.database, a.to.collection);
    return `${ns(a.database, a.collections[0] ?? '')} → ${to}`;
  }
  return ns(a.database, a.collections[0] ?? '');
};

// 토스트·System 탭 한 줄 — 넘은 순간의 숫자(카드는 그 뒤로 늘어난 합계를 보여 준다)
export const alertMessage = (a: MonitorAlert): string => {
  switch (a.kind) {
    case 'mass-delete':
      return `Mass delete on ${alertTarget(a)} — ${count(a.count)} documents deleted within a minute`;
    case 'burst':
      return `Write burst on ${alertTarget(a)} — ${count(a.count)} writes within a minute${a.usual !== null ? ` (usually ${count(a.usual)}/min)` : ''}`;
    case 'drop':
      return a.count > 1 ? `${count(a.count)} collections dropped in ${a.database}` : `Collection dropped: ${alertTarget(a)}`;
    case 'drop-database':
      return `Database dropped: ${a.database}${a.count > 0 ? ` (${count(a.count)} collection${a.count === 1 ? '' : 's'})` : ''}`;
    case 'rename':
      return `Collection renamed: ${alertTarget(a)}`;
  }
};

// 'Show'·행 클릭으로 좁힐 범위 — 지워진 컬렉션은 그 DB, 지워진 DB는 서버 전체, 이름을 바꿨으면 새 이름
export const alertFocus = (a: MonitorAlert): MonitorScope => {
  if (a.kind === 'drop-database') return { database: null, collection: null };
  if (a.kind === 'drop') return { database: a.database, collection: null };
  if (a.kind === 'rename' && a.to) return { database: a.to.database, collection: a.to.collection };
  return { database: a.database, collection: a.collections[0] ?? null };
};
