// 범위 바 — Explorer의 브레드크럼 자리(같은 모양·높이). Explorer에선 '어디를 보고 있나', 여기선 '어디를 지켜보나'.
//   [연결 이름] ▸ [DB ▾] ▸ [컬렉션 ▾]          [Open in Explorer] · 지난 1시간 · ● Live
// 앞 칸을 누르면 넓어지고, 드롭다운에서 고르면 좁혀진다. 사이드바 트리에서 골라도 여기가 바뀐다(page.tsx).
// 범위를 따르는 항목은 다음 단계(9-2~)부터 — 9-1의 Overview는 MongoDB가 서버 전체로만 알려 주는 값이다.
import { useState } from 'react';
import { ArrowUpRight, ChevronRight, Database, Folder, Server } from 'lucide-react';
import type { CollectionSummary, DatabaseSummary } from '../../types/explorer';
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
  windowLabel: string;
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
} as const;

const DOT = { ok: 'bg-emerald-500', warn: 'bg-amber-500', error: 'bg-rose-500', idle: 'bg-slate-300' } as const;

export function ScopeBar({ connectionName, scope, onScopeChange, databases, explorerDatabase, explorerCollections, live, windowLabel, onOpenInExplorer }: ScopeBarProps) {
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
            Explorer <ArrowUpRight size={13} />
          </button>
        )}
        <span className="hidden sm:inline">{windowLabel}</span>
        <span className={styles.live} data-tt={live.tip}>
          <span className={cn('h-2 w-2 rounded-full', DOT[live.tone])} aria-hidden="true" />
          {live.label}
        </span>
      </div>
    </section>
  );
}
