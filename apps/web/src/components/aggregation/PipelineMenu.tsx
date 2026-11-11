// Pipeline 컬럼 헤더의 ⋯ 메뉴 — 이름 붙여 저장 / 저장한 것 열기 / 최근 버전 열기 / mongosh로 복사.
// 저장·기록은 이 브라우저에만(services/savedPipelines). 여는 건 지금 파이프라인을 바꾸는 일이라 부른 쪽이 Undo 알림을 띄운다.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ClipboardCopy, History, MoreHorizontal, Save, X } from 'lucide-react';
import { parseStageText, stageName } from '../../types/explorer';
import { deleteSavedPipeline, savePipeline, usePipelineHistory, useSavedPipelines, type StoredStage } from '../../services/savedPipelines';
import type { PipelineStage } from '../../services/pipelines';
import { cn } from '../../utils/cn';

const MENU_WIDTH = 300;

interface PipelineMenuProps {
  database: string;
  collection: string;
  stages: PipelineStage[];
  // 아직 안 붙인 변경(초안·새 스테이지) 수 — 저장에는 안 들어간다
  changeCount: number;
  onOpen: (stages: StoredStage[], label: string) => void;
  onCopy: () => Promise<void>;
}

// "$match → $group → $sort" — 스테이지 이름만 차례로(사이드바 Aggregation 패널도 쓴다)
export const outline = (stages: StoredStage[]): string => {
  const names = stages.map((s) => {
    const parsed = parseStageText(s.text);
    return parsed.ok ? stageName(parsed.stage) : 'stage';
  });
  return names.length ? names.join(' → ') : 'empty';
};

export const ago = (at: number): string => {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

export function PipelineMenu({ database, collection, stages, changeCount, onOpen, onCopy }: PipelineMenuProps) {
  const saved = useSavedPipelines(database, collection);
  const history = usePipelineHistory(database, collection);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  const [top, setTop] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const applied = stages.filter((s) => !s.pending);

  useLayoutEffect(() => {
    if (!anchor) return;
    const height = menuRef.current?.offsetHeight ?? 0;
    setTop(anchor.bottom + 4 + height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - 8 - height) : anchor.bottom + 4);
  }, [anchor, saved.length, history.length]);

  // 바깥을 누르거나 Esc면 닫는다
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    const onPointer = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor]);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || !applied.length) return;
    savePipeline(database, collection, trimmed, stages);
    setName('');
  };
  const open = (list: StoredStage[], label: string) => {
    setAnchor(null);
    onOpen(list, label);
  };

  const section = 'px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400';
  const row = 'group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-slate-100';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label="Pipeline menu"
        data-tt={anchor ? undefined : 'Save, open saved or recent pipelines, copy for mongosh'}
        className={cn(
          'shrink-0 rounded-lg p-1.5 transition-colors',
          anchor ? 'bg-slate-200/70 text-slate-700' : 'bg-slate-100 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600',
        )}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        <MoreHorizontal size={13} />
      </button>
      {anchor && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Pipeline menu"
          className="fixed z-[120] flex max-h-[calc(100vh-16px)] flex-col overflow-hidden rounded-xl bg-white p-1 shadow-elevated ring-1 ring-slate-100"
          style={{ top, left: Math.max(8, Math.min(anchor.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)), width: MENU_WIDTH }}
        >
          {/* 둥근 모서리·여백은 바깥, 스크롤은 여기 — 스크롤바가 모서리 밖으로 삐져나오지 않게.
              항목은 줄어들지 않게(shrink-0) — truncate(overflow hidden) 항목은 flex 안에서 납작해져 스크롤 대신 겹쳤다 */}
          <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto [&>*]:shrink-0">
            {/* 이름 붙여 저장 — 같은 이름이면 덮어쓴다 */}
            <p className={section}>Save as</p>
            <form
              className="flex items-center gap-1 px-1.5 pb-1"
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={applied.length ? 'Name this pipeline' : 'No stages to save'}
                disabled={!applied.length}
                aria-label="Pipeline name"
                className="min-w-0 flex-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-[13px] text-slate-700 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400/60 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!name.trim() || !applied.length}
                aria-label="Save"
                className="shrink-0 rounded-lg p-1.5 text-emerald-600 transition-colors hover:bg-emerald-50 disabled:opacity-30"
              >
                <Save size={14} />
              </button>
            </form>
            {changeCount > 0 && (
              <p className="px-2.5 pb-1 text-[11px] leading-snug text-amber-600">
                {changeCount} unapplied change{changeCount > 1 ? 's' : ''} won’t be saved — Run first
              </p>
            )}

            {saved.length > 0 && (
              <>
                <p className={section}>Saved</p>
                {saved.map((p) => (
                  <div key={p.id} className={row}>
                    <button type="button" role="menuitem" className="min-w-0 flex-1 text-left" onClick={() => open(p.stages, `“${p.name}”`)}>
                      <span className="block truncate text-[13px] font-medium text-slate-700">{p.name}</span>
                      <span className="block truncate font-mono text-[11px] text-slate-400">{outline(p.stages)} · {ago(p.at)}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${p.name}`}
                      data-tt="Delete this saved pipeline"
                      className="shrink-0 rounded-md p-1 text-slate-300 opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                      onClick={() => deleteSavedPipeline(database, collection, p.id)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </>
            )}

            {history.length > 0 && (
              <>
                <p className={section}>Recent versions</p>
                {history.map((v, i) => (
                  <button key={v.at} type="button" role="menuitem" className={row} onClick={() => open(v.stages, `the version from ${ago(v.at)}`)}>
                    <History size={13} className="shrink-0 text-slate-300" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-600">{outline(v.stages)}</span>
                    <span className="shrink-0 text-[11px] text-slate-400">{i === 0 ? 'current' : ago(v.at)}</span>
                  </button>
                ))}
              </>
            )}

            <div className="my-0.5 h-px bg-slate-100" />
            <button
              type="button"
              role="menuitem"
              disabled={!applied.length}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40"
              onClick={() => {
                void onCopy().then(() => {
                  setCopied(true);
                  setTimeout(() => {
                    setCopied(false);
                    setAnchor(null);
                  }, 700);
                });
              }}
            >
              {copied ? <Check size={13} className="shrink-0 text-emerald-500" /> : <ClipboardCopy size={13} className="shrink-0 text-slate-400" />}
              <span className="flex-1">{copied ? 'Copied' : 'Copy as a mongosh command'}</span>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
