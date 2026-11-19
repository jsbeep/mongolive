// 범위 바 — Explorer의 브레드크럼 자리(같은 모양·높이). Explorer에선 '어디를 보고 있나', 여기선 '어디를 지켜보나'.
//   [연결 이름] ▸ [DB ▾] ▸ [컬렉션 ▾]          [Explorer ↗] [5m 30m 1h 6h 12h 24h 7d More ▾] ● Live
// 기간은 모든 탭에 같이 적용된다(5m·30m·1h = 실시간, 그보다 길면 기록 파일 — 9-3b, C1). 30d·90d·All은 More 메뉴에.
// 앞 칸을 누르면 넓어지고, 드롭다운에서 고르면 좁혀진다. 사이드바 트리에서 골라도 여기가 바뀐다(page.tsx).
// 범위를 따르는 항목은 다음 단계(9-2~)부터 — 9-1의 Overview는 MongoDB가 서버 전체로만 알려 주는 값이다.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Database, Folder, Server } from 'lucide-react';
import type { CollectionSummary, DatabaseSummary, MonitorRange } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { ScopeMenu, type ScopeMenuItem } from './ScopeMenu';

export interface MonitorScope {
  database: string | null;
  collection: string | null;
}

export interface LiveIndicator {
  tone: 'ok' | 'warn' | 'error' | 'idle';
  label: string;
  tip: string;
}

interface ScopeBarProps {
  connectionName: string;
  scope: MonitorScope;
  onScopeChange: (scope: MonitorScope) => void;
  databases: DatabaseSummary[];
  // Explorer가 이미 받아 둔 컬렉션 목록(그 DB면 다시 받지 않는다)
  explorerDatabase: string | null;
  explorerCollections: CollectionSummary[];
  live: LiveIndicator;
  range: MonitorRange;
  onRangeChange: (range: MonitorRange) => void;
  onOpenInExplorer: (scope: MonitorScope) => void;
}

const styles = {
  // Breadcrumbs의 container와 같은 모양
  container: 'relative flex h-12 min-h-12 items-center gap-2 overflow-hidden rounded-[14px] m-3 mb-0 border border-slate-200/80 bg-white/80 px-3 shadow-soft backdrop-blur',
  track: 'flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap scrollbar-hide',
  segment: 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
  segmentIdle: 'cursor-pointer text-slate-600 hover:bg-slate-100/30 hover:text-slate-800',
  segmentLast: 'cursor-default bg-slate-100/60 font-semibold text-slate-900',
  chevron: 'h-3 w-3 shrink-0 text-slate-300',
  side: 'flex shrink-0 items-center gap-3 text-[12px] text-slate-500',
  open: 'inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-800',
  live: 'inline-flex items-center gap-1.5 font-medium',
  // 기간 — 작은 세그먼트(켜짐/꺼짐은 둘 중 하나만)
  ranges: 'inline-flex shrink-0 rounded-lg bg-slate-100 p-0.5',
  range: 'rounded-md px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors',
  rangeOn: 'bg-white text-slate-800 shadow-soft',
  rangeOff: 'text-slate-500 hover:text-slate-800',
} as const;

const DOT = { ok: 'bg-emerald-500', warn: 'bg-amber-500', error: 'bg-rose-500', idle: 'bg-slate-300' } as const;

type RangeOption = { value: MonitorRange; label: string; tip: string };
const RANGES: RangeOption[] = [
  { value: '5m', label: '5m', tip: 'Last 5 minutes — live, every 10 s' },
  { value: '30m', label: '30m', tip: 'Last 30 minutes — live, every 10 s' },
  { value: '1h', label: '1h', tip: 'Last hour — live, every 10 s' },
  { value: '6h', label: '6h', tip: 'Last 6 hours — from history, per minute' },
  { value: '12h', label: '12h', tip: 'Last 12 hours — from history, per 2 minutes' },
  { value: '24h', label: '24h', tip: 'Last 24 hours — from history, per 5 minutes' },
  { value: '7d', label: '7d', tip: 'Last 7 days — from history, per hour' },
];
// 자주 안 쓰는 긴 기간 — More 메뉴
const MORE_RANGES: RangeOption[] = [
  { value: '30d', label: '30d', tip: 'per 2 hours' },
  { value: '90d', label: '90d', tip: 'per 6 hours' },
  { value: 'all', label: 'All', tip: 'everything recorded, per day' },
];

const menuStyles = {
  panel: 'fixed z-[101] flex min-w-[200px] flex-col gap-0.5 rounded-xl bg-white p-1.5 shadow-elevated ring-1 ring-slate-100',
  item: 'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors',
  itemIdle: 'text-slate-700 hover:bg-slate-50',
  itemActive: 'bg-selected font-semibold text-emerald-700',
  meta: 'ml-auto pl-3 text-[11px] text-slate-400',
} as const;

// 기간 줄의 마지막 칸 — 30d·90d·All 중 골랐으면 그 이름, 아니면 More
function MoreRanges({ range, onRangeChange }: { range: MonitorRange; onRangeChange: (range: MonitorRange) => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const chosen = MORE_RANGES.find((r) => r.value === range) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) return setOpen(false);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    setOpen(true);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        role="radio"
        aria-checked={chosen !== null}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(styles.range, 'inline-flex items-center gap-0.5', chosen ? styles.rangeOn : styles.rangeOff)}
        onClick={toggle}
        data-tt={open ? undefined : 'Longer ranges — 30 days, 90 days, all history'}
      >
        {chosen ? chosen.label : 'More'}
        <ChevronDown className={cn('h-3 w-3 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open &&
        createPortal(
          <div ref={panelRef} role="listbox" aria-label="Longer ranges" className={menuStyles.panel} style={{ top: pos.top, right: pos.right }}>
            {MORE_RANGES.map((r) => {
              const active = r.value === range;
              return (
                <button
                  key={r.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={cn(menuStyles.item, active ? menuStyles.itemActive : menuStyles.itemIdle)}
                  onClick={() => {
                    setOpen(false);
                    if (!active) onRangeChange(r.value);
                  }}
                >
                  {active ? <Check size={13} className="shrink-0" /> : <span className="w-[13px] shrink-0" />}
                  <span>{r.value === 'all' ? 'All history' : `Last ${r.label}`}</span>
                  <span className={menuStyles.meta}>{r.tip}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

export function ScopeBar({ connectionName, scope, onScopeChange, databases, explorerDatabase, explorerCollections, live, range, onRangeChange, onOpenInExplorer }: ScopeBarProps) {
  // 다른 DB의 컬렉션 목록은 드롭다운을 열 때 받아 둔다(DB마다 한 번)
  const [fetched, setFetched] = useState<Record<string, ScopeMenuItem[]>>({});
  const toItems = (list: CollectionSummary[]): ScopeMenuItem[] => list.map((c) => ({ value: c.name, label: c.label || c.name, meta: c.documentCount.toLocaleString() }));
  const collectionItems = scope.database === null ? null
    : scope.database === explorerDatabase && explorerCollections.length ? toItems(explorerCollections)
      : fetched[scope.database] ?? null;
  const loadCollections = () => {
    const database = scope.database;
    if (!database || fetched[database]) return;
    void api.getCollections(database)
      .then((list) => setFetched((prev) => ({ ...prev, [database]: toItems(list) })))
      .catch(() => setFetched((prev) => ({ ...prev, [database]: [] })));
  };

  const atCluster = scope.database === null;

  return (
    <section className={styles.container} aria-label="Monitor scope">
      <div className={styles.track}>
        <button
          type="button"
          className={cn(styles.segment, atCluster ? styles.segmentLast : styles.segmentIdle)}
          onClick={() => !atCluster && onScopeChange({ database: null, collection: null })}
          aria-current={atCluster ? 'page' : undefined}
          data-tt={atCluster ? 'Whole server' : 'Widen to the whole server'}
        >
          <Server className="h-3.5 w-3.5" />
          <span className="max-w-48 truncate">{connectionName}</span>
        </button>
        <ChevronRight className={styles.chevron} strokeWidth={2.5} aria-hidden="true" />
        <ScopeMenu
          icon={<Database className="h-3.5 w-3.5" />}
          value={scope.database}
          allLabel="All databases"
          isLast={scope.database !== null && scope.collection === null}
          tooltip="Database scope"
          items={databases.map((d) => ({ value: d.name, label: d.label || d.name, meta: String(d.collectionCount) }))}
          onChange={(database) => onScopeChange({ database, collection: null })}
        />
        {scope.database !== null && (
          <>
            <ChevronRight className={styles.chevron} strokeWidth={2.5} aria-hidden="true" />
            <ScopeMenu
              icon={<Folder className="h-3.5 w-3.5" />}
              value={scope.collection}
              allLabel="All collections"
              isLast={scope.collection !== null}
              tooltip="Collection scope"
              items={collectionItems}
              loadItems={loadCollections}
              onChange={(collection) => onScopeChange({ database: scope.database, collection })}
            />
          </>
        )}
      </div>

      <div className={styles.side}>
        {scope.database !== null && (
          <button type="button" className={styles.open} onClick={() => onOpenInExplorer(scope)} data-tt="Open this scope in Explorer">
            {/* 좁으면 아이콘만 — 범위·기간 칸에 자리를 준다 */}
            <span className="hidden xl:inline">Explorer</span> <ArrowUpRight size={13} />
          </button>
        )}
        <div className={styles.ranges} role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={range === r.value}
              className={cn(styles.range, range === r.value ? styles.rangeOn : styles.rangeOff)}
              onClick={() => onRangeChange(r.value)}
              data-tt={r.tip}
            >
              {r.label}
            </button>
          ))}
          <MoreRanges range={range} onRangeChange={onRangeChange} />
        </div>
        <span className={styles.live} data-tt={live.tip}>
          <span className={cn('h-2 w-2 rounded-full', DOT[live.tone])} aria-hidden="true" />
          {live.label}
        </span>
      </div>
    </section>
  );
}
