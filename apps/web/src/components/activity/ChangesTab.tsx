// 변경 기록 (레거시 ChangeStreamLogs) — 서버 changeStream이 받은 클러스터 전체 변경, 최신이 위.
// 값은 오지 않고 '어디서 무엇이' 바뀌었는지만 온다. 범위(전체/이 DB/이 컬렉션)로 거르고, 일시정지·비우기.
// 비우기는 이 브라우저에서만 숨긴다(useActivityLog의 clearedAt) — 서버의 최근 기록은 그대로다.
// 같은 문서에 연속으로 생긴 변경은 한 줄로 묶는다(내 저장 / 남의 변경은 따로). 묶음을 누르면 그 문서로,
// ×n을 누르면 펼쳐서 하나씩 본다.
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CheckCheck, ChevronDown, Pause, Play, Trash2 } from 'lucide-react';
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
  list: 'flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-px',
  // 한 줄: [배지] [위치 / 바뀐 경로] [시각 / 문서 id] — 안 읽음·읽음 배경은 둘 중 하나만(cn은 겹침을 정리해 주지 않는다)
  row: 'flex items-start gap-2.5 px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60',
  // 모서리: 목록의 맨 처음 행은 위쪽만, 맨 마지막 행은 아래쪽만(하나뿐이면 둘 다) — 위치마다 하나만 붙인다
  roundTop: 'rounded-t-lg',
  roundBottom: 'rounded-b-lg',
  roundBoth: 'rounded-lg',
  // 누르면 그 위치로 이동 / 삭제된 컬렉션·DB는 열 곳이 없다
  rowClickable: 'cursor-pointer',
  rowStatic: 'cursor-default',
  rowRead: 'hover:bg-slate-50',
  rowUnread: 'bg-sky-50 hover:bg-sky-100/60',
  // 고정 너비 — 배지 길이가 달라도 위치 글자가 같은 세로줄에서 시작한다
  badge: 'mt-px shrink-0 w-[60px] py-px rounded-md text-center text-[10px] font-semibold tracking-wide',
  main: 'min-w-0 flex-1',
  nsLine: 'flex min-w-0 items-center gap-1.5',
  ns: 'min-w-0 truncate text-xs font-mono text-slate-700',
  // 이 탭에서 한 저장 표시
  youTag: 'shrink-0 px-1.5 rounded-md bg-emerald-50 text-[10px] font-semibold leading-4 text-emerald-600',
  // 묶음 펼치기(×n)
  // 안 읽은 행(하늘색 배경) 위에서도 보이게 진하게
  countBtn: 'inline-flex shrink-0 items-center gap-0.5 rounded-md bg-slate-200 px-1.5 text-[10px] font-semibold leading-4 text-slate-700 transition-colors hover:bg-slate-300',
  detail: 'truncate text-[11px] font-mono text-slate-500',
  // 오른쪽: 시각 위, 문서 id 아래
  side: 'flex shrink-0 flex-col items-end',
  time: 'text-[11px] font-mono tabular-nums leading-4 text-slate-400',
  docId: 'max-w-[96px] truncate text-[10px] font-mono leading-4 text-slate-400',
  // 펼친 묶음의 항목들 — 위치는 묶음 줄과 같으니 빼고, 배지 아래로 들여 쓴다
  children: 'ml-[34px] flex flex-col gap-px border-l border-slate-100 pl-2',
  empty: 'flex flex-col items-center justify-center gap-1 py-16 text-xs text-slate-400 text-center',
  newBanner: 'mx-3 mt-2 rounded-lg bg-sky-50 px-3 py-1.5 text-[11px] text-sky-700 text-center',
} as const;

const shortId = (id: string) => (id.length > 12 ? `…${id.slice(-8)}` : id);

// 바뀐 경로 한 줄 — rename이면 새 이름
const entryDetail = (e: LiveLogEntry) =>
  e.to
    ? `→ ${e.to.database}.${e.to.collection}`
    : [e.paths?.length ? `set ${e.paths.join(', ')}` : '', e.removed?.length ? `unset ${e.removed.join(', ')}` : ''].filter(Boolean).join(' · ');

// 묶음: 묶인 기록들의 경로를 겹치지 않게 모아서
const mergedDetail = (entries: LiveLogEntry[]) => {
  const set = new Set<string>();
  const unset = new Set<string>();
  for (const e of entries) {
    e.paths?.forEach((p) => set.add(p));
    e.removed?.forEach((p) => unset.add(p));
  }
  return [set.size ? `set ${[...set].join(', ')}` : '', unset.size ? `unset ${[...unset].join(', ')}` : ''].filter(Boolean).join(' · ');
};

interface LogRowProps {
  entry: LiveLogEntry;
  unread: boolean;
  detail: string;
  onNavigate: (entry: LiveLogEntry) => void;
  // 묶음 줄의 ×n 버튼
  extra?: ReactNode;
  // 펼친 묶음 안의 항목 — 위치·문서 id는 묶음 줄과 같으니 뺀다
  compact?: boolean;
  // 목록 맨 처음/맨 마지막 행이면 그쪽 모서리만 둥글게
  first?: boolean;
  last?: boolean;
}

function LogRow({ entry: e, unread, detail, onNavigate, extra, compact = false, first = false, last = false }: LogRowProps) {
  const canOpen = e.op !== 'drop' && e.op !== 'dropDatabase';
  const ns = e.collection ? `${e.database}.${e.collection}` : e.database;
  const lag = e.serverTime - e.clusterTime;
  return (
    <div
      className={cn(
        styles.row,
        first && last ? styles.roundBoth : first ? styles.roundTop : last ? styles.roundBottom : undefined,
        canOpen ? styles.rowClickable : styles.rowStatic,
        unread ? styles.rowUnread : styles.rowRead,
      )}
      {...(canOpen
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: () => onNavigate(e),
            onKeyDown: (ev: KeyboardEvent) => {
              if (ev.target !== ev.currentTarget) return;
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onNavigate(e);
              }
            },
          }
        : { 'data-tt': 'Dropped — nothing to open' })}
    >
      <span className={cn(styles.badge, OP_BADGE[opGroup(e.op)])}>{OP_LABEL[e.op]}</span>
      <div className={styles.main}>
        {compact ? (
          detail ? <div className={styles.detail} title={detail}>{detail}</div> : <div className={styles.detail}>&nbsp;</div>
        ) : (
          <>
            <div className={styles.nsLine}>
              <span className={styles.ns} title={ns}>{ns}</span>
              {e.own && <span className={styles.youTag} data-tt="Saved from this tab">you</span>}
              {extra}
            </div>
            {detail && <div className={styles.detail} title={detail}>{detail}</div>}
          </>
        )}
      </div>
      <div className={styles.side}>
        <span className={styles.time} data-tt={`DB → server ${lag} ms`}>{clock(e.serverTime)}</span>
        {!compact && e.documentId && <span className={styles.docId} title={e.documentId}>{shortId(e.documentId)}</span>}
      </div>
    </div>
  );
}

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

  // 같은 문서(+ 같은 출처: 내 저장/남의 변경)에 연속으로 생긴 기록을 묶는다. 최신이 앞.
  // key = 묶음의 가장 오래된 기록 id — 새 기록은 위(최신 쪽)에 붙으므로 펼침 상태가 유지된다.
  const groups = useMemo(() => {
    const out: { key: string; match: string | null; entries: LiveLogEntry[] }[] = [];
    for (const e of visible) {
      const match = e.documentId ? `${e.database}\u0000${e.collection}\u0000${e.documentId}\u0000${e.own ? 1 : 0}` : null;
      const last = out[out.length - 1];
      if (match && last && last.match === match) {
        last.entries.push(e);
        last.key = e.id;
      } else {
        out.push({ key: e.id, match, entries: [e] });
      }
    }
    return out;
  }, [visible]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleGroup = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
          groups.map((group, gi) => {
            const latest = group.entries[0];
            const isLastGroup = gi === groups.length - 1;
            const isGroup = group.entries.length > 1;
            const isOpen = isGroup && expanded.has(group.key);
            const isUnread = (e: LiveLogEntry) => seenAt !== null && e.serverTime > seenAt && !e.own;
            return (
              <div key={group.key} className="flex flex-col gap-px">
                <LogRow
                  entry={latest}
                  unread={group.entries.some(isUnread)}
                  detail={isGroup ? mergedDetail(group.entries) : entryDetail(latest)}
                  onNavigate={onNavigate}
                  first={gi === 0}
                  // 펼친 묶음이면 마지막 행은 그 안의 마지막 항목
                  last={isLastGroup && !isOpen}
                  extra={isGroup && (
                    <button
                      type="button"
                      className={styles.countBtn}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        toggleGroup(group.key);
                      }}
                      aria-expanded={isOpen}
                      data-tt={isOpen ? 'Collapse' : `${group.entries.length} changes to this document in a row — click to list them`}
                    >
                      ×{group.entries.length}
                      <ChevronDown size={10} className={cn('transition-transform', isOpen && 'rotate-180')} />
                    </button>
                  )}
                />
                {isOpen && (
                  <div className={styles.children}>
                    {group.entries.map((e, ci) => (
                      <LogRow
                        key={e.id}
                        entry={e}
                        unread={isUnread(e)}
                        detail={entryDetail(e)}
                        onNavigate={onNavigate}
                        compact
                        last={isLastGroup && ci === group.entries.length - 1}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
