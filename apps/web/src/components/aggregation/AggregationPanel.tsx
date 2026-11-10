// 사이드바 Aggregation 버튼으로 여는 패널 — 모든 컬렉션의 파이프라인을 카드로.
//   Saved   이름 붙여 저장한 것(Pipeline 헤더 ⋯ › Save as). 누르면 그 컬렉션의 집계 모드로 열고 파이프라인을 그것으로 바꾼다(Undo)
//   Recent  만들던 파이프라인 — 컬렉션마다 한 장(최근에 쓴 것부터). 누르면 그대로 이어서. 펼치면 최근 버전들(누르면 그 버전으로, Undo)
// 모두 이 브라우저(localStorage)에만 — services/pipelines(지금 파이프라인), services/savedPipelines(저장·기록).
// 집계 모드를 켜고 끄는 건 Collections 헤더의 Aggregation 버튼(나오는 건 Pipeline 헤더의 ×로도).
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Database, Folder, History, Search, Star, Workflow, X } from 'lucide-react';
import { parseStageText, stageName } from '../../types/explorer';
import { splitPipelineKey, useAllPipelines } from '../../services/pipelines';
import { deleteSavedPipeline, useAllSavedPipelines, type PipelineVersion, type StoredStage } from '../../services/savedPipelines';
import { SidebarPopover } from '../layout/SidebarPopover';
import { cn } from '../../utils/cn';
import { ago, outline } from './PipelineMenu';

interface AggregationPanelProps {
  anchor: DOMRect;
  // 지금 열린 집계(그 카드에 'Open' 표시)
  current: { database: string; collection: string } | null;
  // stages가 있으면 그 파이프라인으로 바꿔서, null이면 그 컬렉션의 지금 파이프라인 그대로 연다
  onOpen: (database: string, collection: string, stages: StoredStage[] | null, label: string) => void;
  onClose: () => void;
}

// 스테이지 종류마다 색 — 거르기 / 모양 / 묶기 / 순서·개수 / 잇기
const TONES: [string[], string][] = [
  [['$match'], 'bg-emerald-50 text-emerald-700 ring-emerald-200/80'],
  [['$project', '$addFields', '$set', '$unset', '$replaceRoot', '$replaceWith'], 'bg-sky-50 text-sky-700 ring-sky-200/80'],
  [['$group', '$bucket', '$bucketAuto', '$sortByCount', '$count', '$facet'], 'bg-violet-50 text-violet-700 ring-violet-200/80'],
  [['$sort', '$limit', '$skip', '$sample'], 'bg-amber-50 text-amber-700 ring-amber-200/80'],
  [['$lookup', '$unwind', '$graphLookup', '$unionWith'], 'bg-rose-50 text-rose-700 ring-rose-200/80'],
];
const toneOf = (name: string) => TONES.find(([names]) => names.includes(name))?.[1] ?? 'bg-slate-100 text-slate-600 ring-slate-200/80';
const nameOf = (stage: StoredStage) => {
  const parsed = parseStageText(stage.text);
  return parsed.ok ? stageName(parsed.stage) : 'stage';
};
// 카드 한 줄에 들어가는 만큼(나머지는 +N)
const MAX_PILLS = 3;

// 스테이지 흐름 — $match › $group › $sort (+2). 꺼진 스테이지는 흐리게 줄을 긋는다
function StageFlow({ stages }: { stages: StoredStage[] }) {
  if (!stages.length) return <p className="mt-2 text-[11px] italic text-slate-400">No stages now</p>;
  const shown = stages.slice(0, MAX_PILLS);
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((stage, i) => {
        const name = nameOf(stage);
        return (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={10} className="shrink-0 text-slate-300" aria-hidden="true" />}
            <span className={cn('rounded-md px-1.5 py-px font-mono text-[10.5px] font-semibold ring-1 ring-inset', toneOf(name), !stage.enabled && 'line-through opacity-50')}>
              {name}
            </span>
          </span>
        );
      })}
      {stages.length > MAX_PILLS && <span className="font-mono text-[10.5px] text-slate-400">+{stages.length - MAX_PILLS}</span>}
    </div>
  );
}

// 카드 왼쪽 위의 스테이지 수
function CountBadge({ count, tone }: { count: number; tone: 'saved' | 'recent' }) {
  return (
    <span
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-[11px] font-bold tabular-nums ring-1 ring-inset',
        tone === 'saved' ? 'bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-700 ring-emerald-200/70' : 'bg-slate-50 text-slate-500 ring-slate-200/80',
      )}
      aria-label={`${count} stage${count === 1 ? '' : 's'}`}
    >
      {count}
    </span>
  );
}

// 카드 — 다른 목록처럼 올리면 배경만 바뀐다. 지금 열린 컬렉션은 초록 테두리
const CARD = 'group relative rounded-xl border transition-colors';
const CARD_IDLE = 'border-slate-200/70 bg-white hover:bg-slate-50';
const CARD_HERE = 'border-emerald-200 bg-white hover:bg-slate-50';

interface SavedEntry { id: string; name: string; database: string; collection: string; stages: StoredStage[]; at: number }
interface RecentEntry { key: string; database: string; collection: string; stages: StoredStage[]; versions: PipelineVersion[]; at: number }

export function AggregationPanel({ anchor, current, onOpen, onClose }: AggregationPanelProps) {
  const store = useAllSavedPipelines();
  const pipelines = useAllPipelines();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const saved = useMemo<SavedEntry[]>(() => Object.entries(store.saved)
    .flatMap(([key, list]) => list.map((p) => ({ ...splitPipelineKey(key), id: p.id, name: p.name, stages: p.stages, at: p.at })))
    .sort((a, b) => b.at - a.at), [store.saved]);

  // 만들던 파이프라인 — 지금 파이프라인(붙인 스테이지만)과 최근 버전을 컬렉션마다 한 장으로
  const recent = useMemo<RecentEntry[]>(() => {
    const keys = new Set([...Object.keys(pipelines), ...Object.keys(store.history)]);
    return [...keys].map((key) => {
      const now = pipelines[key];
      const versions = store.history[key] ?? [];
      const stages = (now?.stages ?? []).filter((s) => !s.pending).map((s) => ({ text: s.text, enabled: s.enabled }));
      return { key, ...splitPipelineKey(key), stages, versions, at: Math.max(now?.at ?? 0, versions[0]?.at ?? 0) };
    }).filter((r) => r.stages.length || r.versions.length).sort((a, b) => b.at - a.at);
  }, [pipelines, store.history]);

  const q = query.trim().toLowerCase();
  const hit = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const savedShown = saved.filter((s) => hit(s.name, s.database, s.collection, outline(s.stages)));
  const recentShown = recent.filter((r) => hit(r.database, r.collection, outline(r.stages)));
  const isCurrent = (database: string, collection: string) => current?.database === database && current.collection === collection;
  const total = saved.length + recent.length;

  const section = (icon: ReactNode, label: string, count: number) => (
    <p className="sticky -top-1.5 z-10 flex items-center gap-1.5 bg-white px-2 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
      {icon}
      {label}
      <span className="font-mono font-normal normal-case tracking-normal text-slate-300">{count}</span>
    </p>
  );

  const openTag = <span className="shrink-0 rounded-md bg-emerald-100 px-1.5 py-px text-[10px] font-semibold text-emerald-700">Open</span>;

  return (
    <SidebarPopover anchor={anchor} title="Aggregation" icon={<Workflow size={14} />} width={360} onClose={onClose}>
      {total === 0 ? (
        <div className="px-5 py-7 text-center">
          <div className="mx-auto mb-2.5 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-500 ring-1 ring-inset ring-emerald-100">
            <Workflow size={18} />
          </div>
          <p className="text-[13px] font-medium text-slate-600">No pipelines yet</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            Pick a collection and click <Workflow size={12} className="inline align-[-2px]" aria-label="Aggregation" /> in the Collections header to start one.
            Name it from the pipeline’s ⋯ menu to keep it here.
          </p>
        </div>
      ) : (
        <>
          {total > 5 && (
            <label className="mx-1 mb-1 flex items-center gap-2 rounded-lg bg-slate-100 px-2.5 py-1.5 focus-within:bg-white focus-within:ring-2 focus-within:ring-emerald-400/60">
              <Search size={12} className="shrink-0 text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name, collection or stage"
                aria-label="Filter pipelines"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-slate-700 placeholder:text-slate-400 focus:outline-none"
              />
            </label>
          )}

          {savedShown.length > 0 && (
            <section>
              {section(<Star size={11} />, 'Saved', savedShown.length)}
              <ul className="flex flex-col gap-1.5 px-1 pb-2">
                {savedShown.map((s) => (
                  <li key={s.id} className={cn(CARD, isCurrent(s.database, s.collection) ? CARD_HERE : CARD_IDLE)}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-2.5 p-2.5 text-left"
                      data-tt={`Open “${s.name}” on ${s.collection}`}
                      onClick={() => onOpen(s.database, s.collection, s.stages, `“${s.name}”`)}
                    >
                      <CountBadge count={s.stages.length} tone="saved" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 pr-5">
                          <span className="truncate text-[13px] font-semibold text-slate-800">{s.name}</span>
                          <span className="ml-auto shrink-0 text-[11px] text-slate-400">{ago(s.at)}</span>
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[11px] text-slate-400">
                          <Folder size={11} className="shrink-0" />
                          <span className="truncate">{s.database} › {s.collection}</span>
                        </span>
                        <StageFlow stages={s.stages} />
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${s.name}`}
                      data-tt="Delete this saved pipeline"
                      className="absolute right-1.5 top-2 rounded-md p-1 text-slate-300 opacity-0 transition hover:bg-red-50 hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => deleteSavedPipeline(s.database, s.collection, s.id)}
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {recentShown.length > 0 && (
            <section>
              {section(<History size={11} />, 'Recent', recentShown.length)}
              <ul className="flex flex-col gap-1.5 px-1 pb-1">
                {recentShown.map((r) => {
                  const open = expanded === r.key;
                  const here = isCurrent(r.database, r.collection);
                  // 지금 파이프라인과 다른 옛 버전 — 없으면 펼칠 것도 없다
                  const earlier = r.versions.filter((v) => JSON.stringify(v.stages) !== JSON.stringify(r.stages)).length;
                  return (
                    <li key={r.key} className={cn(CARD, here ? CARD_HERE : CARD_IDLE)}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-2.5 p-2.5 text-left"
                        data-tt={here ? 'This pipeline is open' : `Continue the pipeline on ${r.collection}`}
                        onClick={() => onOpen(r.database, r.collection, null, r.collection)}
                      >
                        <CountBadge count={r.stages.length} tone="recent" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate font-mono text-[13px] font-semibold text-slate-800">{r.collection}</span>
                            {here && openTag}
                            <span className="ml-auto shrink-0 text-[11px] text-slate-400">{ago(r.at)}</span>
                          </span>
                          <span className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[11px] text-slate-400">
                            <Database size={11} className="shrink-0" />
                            <span className="truncate">{r.database}</span>
                          </span>
                          <StageFlow stages={r.stages} />
                        </span>
                      </button>
                      {earlier > 0 && (
                        <div className="border-t border-slate-100 px-2.5 pb-1.5 pt-1">
                          <button
                            type="button"
                            aria-expanded={open}
                            className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                            onClick={() => setExpanded(open ? null : r.key)}
                          >
                            <History size={11} />
                            {earlier} earlier version{earlier > 1 ? 's' : ''}
                            <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} />
                          </button>
                          {open && (
                            // 버전 타임라인 — 위가 최근. 지금 파이프라인과 같은 버전은 'current'
                            <ol className="relative ml-[7px] mt-1 border-l border-slate-200 pl-2.5">
                              {r.versions.map((v) => {
                                const same = JSON.stringify(v.stages) === JSON.stringify(r.stages);
                                return (
                                  <li key={v.at} className="relative">
                                    <span className={cn('absolute -left-[14px] top-[9px] h-[7px] w-[7px] rounded-full ring-2 ring-white', same ? 'bg-emerald-500' : 'bg-slate-300')} />
                                    <button
                                      type="button"
                                      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-slate-100 disabled:cursor-default disabled:hover:bg-transparent"
                                      disabled={same && here}
                                      data-tt={same ? 'The current pipeline' : 'Open this version (Undo brings yours back)'}
                                      onClick={() => onOpen(r.database, r.collection, same ? null : v.stages, `the version from ${ago(v.at)}`)}
                                    >
                                      <span className={cn('min-w-0 flex-1 truncate font-mono text-[11px]', same ? 'text-emerald-700' : 'text-slate-600')}>{outline(v.stages)}</span>
                                      <span className="shrink-0 text-[10.5px] text-slate-400">{same ? 'current' : ago(v.at)}</span>
                                    </button>
                                  </li>
                                );
                              })}
                            </ol>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {!savedShown.length && !recentShown.length && <p className="px-3 py-5 text-center text-xs text-slate-400">No pipelines match “{query}”</p>}
        </>
      )}
    </SidebarPopover>
  );
}
