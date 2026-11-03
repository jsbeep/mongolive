// 변경 기록 (레거시 ChangeStreamLogs) — 서버 changeStream이 받은 클러스터 전체 변경, 최신이 위.
// 값은 오지 않고 '어디서 무엇이' 바뀌었는지만 온다. 범위(전체/이 DB/이 컬렉션)로 거르고, 일시정지·비우기.
// 비우기는 이 브라우저에서만 숨긴다(useActivityLog의 clearedAt) — 서버의 최근 기록은 그대로다.
import { useMemo, useState, type KeyboardEvent } from 'react';
import { CheckCheck, Pause, Play, Trash2 } from 'lucide-react';
import type { LiveLogEntry, LiveOperation } from '../../types/explorer';
import { cn } from '../../utils/cn';

type Scope = 'all' | 'database' | 'collection';
type OpGroup = 'insert' | 'update' | 'delete' | 'structure';

const opGroup = (op: LiveOperation): OpGroup =>
  op === 'insert' ? 'insert' : op === 'update' || op === 'replace' ? 'update' : op === 'delete' ? 'delete' : 'structure';

// 연산 종류 배지 — 글자(라벨)가 항상 같이 있으므로 색만으로 구분하지 않는다
const OP_BADGE: Record<OpGroup, string> = {
  insert: 'bg-emerald-100 text-emerald-700',
  update: 'bg-sky-100 text-sky-700',
  delete: 'bg-rose-100 text-rose-700',
  structure: 'bg-slate-200/80 text-slate-700',
};

const OP_LABEL: Record<LiveOperation, string> = {
  insert: 'INSERT', update: 'UPDATE', replace: 'REPLACE', delete: 'DELETE',
  create: 'CREATE', drop: 'DROP', rename: 'RENAME', dropDatabase: 'DROP DB',
};

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const styles = {
  toolbar: 'flex shrink-0 items-center gap-1.5 px-3 py-2 border-b border-slate-100',
  scopeSelect:
    'text-xs px-2 py-1 rounded-lg bg-slate-100/80 text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-400/60',
  iconBtn: 'p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors disabled:opacity-40 disabled:pointer-events-none',
  counts: 'flex shrink-0 items-center gap-1.5 px-3 py-2 text-[11px] font-mono text-slate-500 border-b border-slate-100',
  count: 'flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold uppercase',
  list: 'flex-1 min-h-0 overflow-y-auto px-2.5 py-2.5 flex flex-col gap-0',
  // 배경·테두리는 둘 중 하나만(안 읽음 / 읽음) — cn은 겹치는 클래스를 정리해 주지 않는다
  row: 'flex flex-col gap-1.5 px-3 py-2.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60',
  // 누르면 그 위치로 이동 / 삭제된 컬렉션·DB는 열 곳이 없다
  rowClickable: 'cursor-pointer',
  rowStatic: 'cursor-default',
  // 모서리: 목록 양 끝만 바깥쪽을 lg로, 나머지는 sm — 위치마다 하나만 붙인다(cn은 겹침을 정리해 주지 않음)
  roundOnly: 'rounded-lg',
  roundFirst: 'rounded-t-lg rounded-b-sm',
  roundLast: 'rounded-t-sm rounded-b-lg',
  roundMiddle: 'rounded-sm',
  rowRead: 'border-transparent hover:border-slate-100 hover:bg-slate-50',
  rowUnread: 'bg-sky-50 hover:bg-sky-100/60',
  rowTop: 'flex items-center gap-2.5 min-w-0',
  // 고정 너비 — 배지 길이가 달라도 위치(db.collection) 글자가 같은 세로줄에서 시작한다
  badge: 'shrink-0 w-[60px] py-[3px] rounded-lg text-center text-[10px] font-semibold tracking-wide',
  ns: 'min-w-0 flex-1 truncate text-xs font-mono text-slate-700',
  time: 'shrink-0 text-[11px] font-mono tabular-nums text-slate-400',
  // 배지 너비(60px) + 간격(10px)만큼 들여 위치 글자 아래에 맞춘다
  detail: 'pl-[70px] text-[11px] font-mono text-slate-500 truncate',
  empty: 'flex flex-col items-center justify-center gap-1 py-16 text-xs text-slate-400 text-center',
  newBanner: 'mx-3 mt-2 rounded-lg bg-sky-50 px-3 py-1.5 text-[11px] text-sky-700 text-center',
} as const;

interface ChangesTabProps {
  // 비운 시점 이후의 기록(최신이 앞) — 구독·보관은 useActivityLog가 한다
  entries: LiveLogEntry[];
  seenAt: number | null;
  unread: number;
  onClear: () => void;
  onMarkAllRead: () => void;
  onNavigate: (entry: LiveLogEntry) => void;
  activeDatabase: string | null;
  activeCollection: string | null;
}

export function ChangesTab({ entries: liveEntries, seenAt, unread, onClear, onMarkAllRead, onNavigate, activeDatabase, activeCollection }: ChangesTabProps) {
  // 일시정지 = 그 순간의 목록을 얼려서 보여준다. 그동안 들어온 건 개수만 알려주고, 재개하면 다시 실시간.
  const [frozen, setFrozen] = useState<LiveLogEntry[] | null>(null);
  const paused = frozen !== null;
  const entries = frozen ?? liveEntries;
  const heldCount = useMemo(() => {
    if (!frozen) return 0;
    const ids = new Set(frozen.map((e) => e.id));
    return liveEntries.filter((e) => !ids.has(e.id)).length;
  }, [frozen, liveEntries]);
  const [scope, setScope] = useState<Scope>('all');

  const togglePause = () => setFrozen((current) => (current ? null : liveEntries));

  const visible = useMemo(() => entries.filter((e) => {
    if (scope === 'all') return true;
    if (e.database !== activeDatabase) return false;
    return scope === 'database' || e.collection === activeCollection || e.collection === undefined;
  }), [entries, scope, activeDatabase, activeCollection]);

  const counts = useMemo(() => {
    const c: Record<OpGroup, number> = { insert: 0, update: 0, delete: 0, structure: 0 };
    for (const e of visible) c[opGroup(e.op)] += 1;
    return c;
  }, [visible]);

  return (
    <>
      <div className={styles.toolbar}>
        <select className={styles.scopeSelect} value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="Scope">
          <option value="all">All databases</option>
          <option value="database" disabled={!activeDatabase}>This database{activeDatabase ? ` (${activeDatabase})` : ''}</option>
          <option value="collection" disabled={!activeCollection}>This collection{activeCollection ? ` (${activeCollection})` : ''}</option>
        </select>
        <span className="flex-1" />
        <button type="button" className={cn(styles.iconBtn, paused && 'bg-amber-50 text-amber-600')} onClick={togglePause} data-tt={paused ? 'Resume' : 'Pause — keep collecting, stop updating the list'}>
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <button type="button" className={styles.iconBtn} onClick={onMarkAllRead} disabled={unread === 0} data-tt={unread ? `Mark all as read (${unread} unread)` : 'All read'}>
          <CheckCheck size={14} />
        </button>
        <button type="button" className={styles.iconBtn} onClick={() => { setFrozen(null); onClear(); }} data-tt="Clear the list (only in this browser — the server keeps its recent history)">
          <Trash2 size={14} />
        </button>
      </div>

      <div className={styles.counts}>
        <span className="text-slate-600">{visible.length} events</span>
        <span className="flex-1" />
        {(Object.keys(counts) as OpGroup[]).map((g) => (
          <span key={g} className={cn(styles.count, OP_BADGE[g])}>
            {g === 'structure' ? 'ddl' : g} {counts[g]}
          </span>
        ))}
      </div>

      {paused && heldCount > 0 && <div className={styles.newBanner}>{heldCount} new while paused</div>}

      <div className={styles.list}>
        {visible.length === 0 ? (
          <div className={styles.empty}>
            <span>No changes yet</span>
            <span>Edit something in mongosh or Compass — it shows up here.</span>
          </div>
        ) : (
          visible.map((e, index) => {
            const isFirst = index === 0;
            const isLast = index === visible.length - 1;
            const canOpen = e.op !== 'drop' && e.op !== 'dropDatabase';
            const round = isFirst && isLast ? styles.roundOnly : isFirst ? styles.roundFirst : isLast ? styles.roundLast : styles.roundMiddle;
            const group = opGroup(e.op);
            const ns = e.collection ? `${e.database}.${e.collection}` : e.database;
            const detail = e.to
              ? `→ ${e.to.database}.${e.to.collection}`
              : [e.paths?.length ? `set ${e.paths.join(', ')}` : '', e.removed?.length ? `unset ${e.removed.join(', ')}` : ''].filter(Boolean).join(' · ');
            const lag = e.serverTime - e.clusterTime;
            return (
              <div
                key={e.id}
                className={cn(styles.row, round, canOpen ? styles.rowClickable : styles.rowStatic, seenAt !== null && e.serverTime > seenAt ? styles.rowUnread : styles.rowRead)}
                {...(canOpen
                  ? {
                      role: 'button',
                      tabIndex: 0,
                      onClick: () => onNavigate(e),
                      onKeyDown: (ev: KeyboardEvent) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          onNavigate(e);
                        }
                      },
                    }
                  : { 'data-tt': 'Dropped — nothing to open' })}
              >
                <div className={styles.rowTop}>
                  <span className={cn(styles.badge, OP_BADGE[group])}>{OP_LABEL[e.op]}</span>
                  <span className={styles.ns} title={ns}>
                    {ns}
                    {e.documentId && <span className="text-slate-400"> · {e.documentId.length > 12 ? `…${e.documentId.slice(-8)}` : e.documentId}</span>}
                  </span>
                  <span className={styles.time} data-tt={`DB → server ${lag} ms`}>{clock(e.serverTime)}</span>
                </div>
                {detail && <div className={styles.detail} title={detail}>{detail}</div>}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
