// 사이드바 Query 버튼으로 여는 쿼리 기록 — 겉모양은 SidebarPopover(누른 버튼 오른쪽, 바깥·Esc로 닫힘).
//   누르기 = 지금 열린 컬렉션에 그 쿼리 실행(열린 컬렉션이 없으면 원래 컬렉션을 열고 실행)
//   ↗      = 원래 컬렉션으로 가서 실행(다른 컬렉션의 기록에만)
// 지금 컬렉션의 기록을 위에, 다른 컬렉션 것을 아래에. 고르면 닫힌다.
import type { ReactNode } from 'react';
import { ArrowUpRight, History, Trash2, X } from 'lucide-react';
import type { QueryHistoryEntry } from '../../services/queryHistory';
import { SidebarPopover } from '../layout/SidebarPopover';

interface QueryHistoryPanelProps {
  // 패널을 붙일 자리(누른 버튼의 화면 위치)
  anchor: DOMRect;
  entries: QueryHistoryEntry[];
  current: { database: string; collection: string } | null;
  onApply: (entry: QueryHistoryEntry) => void;
  onOpenOriginal: (entry: QueryHistoryEntry) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}

const ago = (at: number): string => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function QueryHistoryPanel({ anchor, entries, current, onApply, onOpenOriginal, onRemove, onClear, onClose }: QueryHistoryPanelProps) {
  const isCurrent = (e: QueryHistoryEntry) => !!current && e.database === current.database && e.collection === current.collection;
  const mine = entries.filter(isCurrent);
  const others = entries.filter((e) => !isCurrent(e));

  const item = (entry: QueryHistoryEntry, showWhere: boolean) => (
    <li key={entry.id} className="group relative">
      <button
        type="button"
        className="flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-100"
        data-tt={current ? `Run on ${current.collection}` : `Open ${entry.collection} and run`}
        onClick={() => onApply(entry)}
      >
        {/* 여러 줄 쿼리도 목록에선 한 줄로 이어서(두 줄까지) — 실행은 원래 쿼리 그대로 */}
        <code className="line-clamp-2 break-all pr-12 font-mono text-xs leading-[18px] text-slate-700" title={entry.text}>{entry.text.replace(/\s+/g, ' ')}</code>
        <span className="truncate text-[11px] text-slate-400">
          {showWhere && <span className="font-mono">{entry.database}.{entry.collection} · </span>}
          {ago(entry.at)}
        </span>
      </button>
      <span className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {showWhere && current && (
          <button
            type="button"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
            aria-label={`Open ${entry.collection} and run`}
            data-tt={`Open ${entry.database}.${entry.collection} and run there`}
            onClick={() => onOpenOriginal(entry)}
          >
            <ArrowUpRight size={12} />
          </button>
        )}
        <button
          type="button"
          className="rounded-md p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
          aria-label="Remove from history"
          data-tt="Remove from history"
          onClick={() => onRemove(entry.id)}
        >
          <X size={12} />
        </button>
      </span>
    </li>
  );

  return (
    <SidebarPopover
      anchor={anchor}
      title="Query history"
      icon={<History size={14} />}
      onClose={onClose}
      actions={entries.length > 0 && (
        <button
          type="button"
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Clear history"
          data-tt="Clear all history"
          onClick={onClear}
        >
          <Trash2 size={13} />
        </button>
      )}
    >
      {entries.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs leading-5 text-slate-400">
          Queries you run show up here.
          <br />
          Open a collection and press <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono">q</kbd> to write one.
        </p>
      ) : (
        <>
          {current && (
            <Section title={`This collection · ${current.collection}`} empty="Nothing run here yet">
              {mine.map((e) => item(e, false))}
            </Section>
          )}
          {others.length > 0 && (
            <Section title={current ? 'Other collections' : 'All collections'}>
              {others.map((e) => item(e, true))}
            </Section>
          )}
        </>
      )}
    </SidebarPopover>
  );
}

function Section({ title, empty, children }: { title: string; empty?: string; children: ReactNode[] }) {
  return (
    <section className="mb-1">
      <h3 className="truncate px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</h3>
      {children.length ? <ul className="flex flex-col gap-0.5">{children}</ul> : empty && <p className="px-2.5 pb-2 text-[11px] text-slate-300">{empty}</p>}
    </section>
  );
}
