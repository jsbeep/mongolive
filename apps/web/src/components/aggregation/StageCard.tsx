// Pipeline 컬럼의 스테이지 카드 한 장 — "01 · $match / score > 100 / 31 → 12".
// 행 모양·선택 표시는 컬럼 목록(ColumnItem)과 같다. 손잡이로 끌어 순서를 바꾸고(놓을 때 저장), 스위치로 켜고 끈다.
// 누르면 고르기(그 스테이지까지의 출력), 연필(또는 더블클릭)이면 카드 바로 아래 편집기가 펼쳐진다 — 연필은 고르지 않는다.
// 키보드(utils/keyboardNav): Enter/→ = 고르기, e = 편집기 열기, Delete = 지우기(한 번 더 확인).
import type { ReactNode } from 'react';
import { AnimatePresence, m, Reorder, useDragControls } from 'framer-motion';
import { GripVertical, Pencil, Trash2, X } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useNavRow } from '../../utils/keyboardNav';

export interface StageCardCount {
  // 들어오는 개수 → 나가는 개수("500+"처럼 이미 글자로). 아직 모르면 undefined
  input?: string;
  output?: string;
  counting: boolean;
  // 이 스테이지에서 세다가 막혔다
  error?: string;
}

interface StageCardProps {
  id: string;
  index: number;
  name: string;
  summary: string;
  enabled: boolean;
  selected: boolean;
  // 편집기에 적용 안 한 글자가 있다
  edited: boolean;
  // 이 카드 아래 편집기가 열려 있다(editor가 그 내용)
  editing: boolean;
  editor: ReactNode;
  // 지우기를 한 번 눌렀다 — 한 번 더 누르면 지운다
  confirmingDelete: boolean;
  // 필드 메뉴로 모아서 새로 생긴, 아직 안 돌린 스테이지(점선) — 누르면 편집기, 스위치 대신 버리기
  pending: boolean;
  // 모아서 바뀐 횟수(+N) — Run 전까지
  collectedCount: number;
  count: StageCardCount | null;
  reduceMotion: boolean;
  onSelect: () => void;
  onEdit: () => void;
  // 연필 — 열려 있으면 닫는다
  onToggleEdit: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onDragEnd: () => void;
}

export function StageCard({ id, index, name, summary, enabled, selected, edited, editing, editor, confirmingDelete, pending, collectedCount, count, reduceMotion, onSelect, onEdit, onToggleEdit, onRemove, onToggle, onDragEnd }: StageCardProps) {
  const controls = useDragControls();
  const navRef = useNavRow({ open: onSelect, edit: onEdit, remove: onRemove });
  const number = String(index + 1).padStart(2, '0');

  return (
    // layout은 자리만(position) — 크기까지 animate하면 편집기가 열리고 닫힐 때 카드가 찌그러졌다 펴진다
    <Reorder.Item as="div" value={id} dragListener={false} dragControls={controls} onDragEnd={onDragEnd} layout={reduceMotion ? undefined : 'position'} className="relative">
      <div
        ref={navRef}
        data-nav-row=""
        data-nav-active={selected ? '' : undefined}
        className={cn(
          'group relative flex items-center gap-3 rounded-2xl border py-3 pl-4 pr-3 cursor-pointer select-none transition-colors',
          selected ? 'border-transparent bg-selected'
            : pending ? 'border-dashed border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50'
            : 'border-transparent hover:bg-slate-50/80 active:bg-slate-100/50',
        )}
        onClick={onSelect}
        onDoubleClick={onEdit}
      >
        {/* 선택 표시 — 컬럼 목록과 같은 왼쪽 막대. 세로 가운데는 inset-y-0 + my-auto로
            (framer-motion이 scaleY로 transform을 덮어써 -translate-y-1/2는 안 먹는다) */}
        <AnimatePresence>
          {selected && (
            <m.span
              className="absolute inset-y-0 left-1.5 my-auto h-8 w-1 rounded-full bg-emerald-500"
              initial={{ scaleY: 0, opacity: 0 }}
              animate={{ scaleY: 1, opacity: 1 }}
              exit={{ scaleY: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            />
          )}
        </AnimatePresence>

        {/* 번호 칸 — 올리면 손잡이 */}
        <span
          className={cn(
            'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-mono text-[11px] font-bold tabular-nums',
            selected ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500',
          )}
        >
          <span className={cn('transition-opacity', !editing && 'group-hover:opacity-0')}>{number}</span>
          {/* 편집하는 동안엔 끌지 않는다(편집기째 움직이면 헷갈린다) */}
          {!editing && (
            <span
              role="button"
              aria-label={`Drag stage ${index + 1} to reorder`}
              data-tt="Drag to reorder"
              className="absolute inset-0 flex cursor-grab touch-none items-center justify-center rounded-xl opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                controls.start(e);
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <GripVertical size={15} />
            </span>
          )}
        </span>

        <div className={cn('min-w-0 flex-1', !enabled && 'opacity-50')}>
          <p className="flex items-center gap-1.5">
            <span className={cn('truncate font-mono text-sm font-semibold', selected ? 'text-emerald-700' : 'text-slate-700', !enabled && 'line-through')}>
              {name || 'stage'}
            </span>
            {edited && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" data-tt="Edited — not applied yet" />}
            {/* 모아서 바뀐 것 — 새 스테이지는 NEW, 있던 스테이지는 +N(몇 번 쌓였나) */}
            {pending ? (
              <span className="shrink-0 rounded-md bg-emerald-100 px-1.5 py-px font-mono text-[10px] font-semibold uppercase text-emerald-700" data-tt="Collected — not run yet. Run adds it">
                new
              </span>
            ) : collectedCount > 0 && (
              <span className="shrink-0 rounded-md bg-amber-100 px-1.5 py-px font-mono text-[10px] font-semibold text-amber-700" data-tt={`${collectedCount} collected — Run applies it`}>
                +{collectedCount}
              </span>
            )}
          </p>
          <p className={cn('mt-0.5 truncate text-xs', selected ? 'text-emerald-600/80' : 'text-slate-500')} title={summary}>
            {summary}
          </p>
          {pending
            ? <p className="mt-1 truncate font-mono text-[11px] text-emerald-600/80" data-tt="Run adds it to the pipeline">not run yet</p>
            : <StageCountLine enabled={enabled} count={count} selected={selected} />}
        </div>

        {/* 지우기 확인 / 편집 — 스위치 왼쪽 */}
        {confirmingDelete ? (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded-xl bg-rose-500 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-rose-600"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <Trash2 size={12} />
            Delete?
          </button>
        ) : (
          <button
            type="button"
            aria-pressed={editing}
            aria-label={`${editing ? 'Close the editor of' : 'Edit'} stage ${index + 1}`}
            data-tt={editing ? 'Close the editor' : 'Edit this stage — e'}
            className={cn(
              'shrink-0 rounded-xl p-1.5 transition-colors',
              editing ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200/70' : 'text-slate-300 hover:bg-slate-200/70 hover:text-slate-600',
            )}
            onClick={(e) => {
              e.stopPropagation();
              onToggleEdit();
            }}
          >
            <Pencil size={14} />
          </button>
        )}

        {/* 켜짐 스위치 — 끄면 그 스테이지를 빼고 돌린다(지우지 않는다). 아직 안 붙인 스테이지는 대신 버리기 */}
        {pending ? (
          <button
            type="button"
            aria-label={`Discard stage ${index + 1}`}
            data-tt="Discard — it was never run"
            className="shrink-0 rounded-xl p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <X size={14} />
          </button>
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`${enabled ? 'Turn off' : 'Turn on'} stage ${index + 1}`}
            data-tt={enabled ? 'On — click to skip this stage' : 'Off — skipped when running'}
            className={cn(
              'flex h-[18px] w-8 shrink-0 items-center rounded-full p-0.5 transition-colors',
              enabled ? 'bg-emerald-500' : 'bg-slate-200 hover:bg-slate-300',
            )}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <span className={cn('h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform', enabled ? 'translate-x-3.5' : 'translate-x-0')} />
          </button>
        )}
      </div>
      {editing && editor}
    </Reorder.Item>
  );
}

function StageCountLine({ enabled, count, selected }: { enabled: boolean; count: StageCardCount | null; selected: boolean }) {
  if (!enabled) return <p className="mt-1 font-mono text-[11px] text-slate-400">off — skipped</p>;
  if (!count) return null;
  if (count.error) {
    return (
      <p className="mt-1 truncate font-mono text-[11px] text-rose-500" title={count.error}>
        {count.error}
      </p>
    );
  }
  if (count.counting && count.output === undefined) return <p className="mt-1 font-mono text-[11px] text-slate-300">counting…</p>;
  if (count.output === undefined) return <p className="mt-1 font-mono text-[11px] text-slate-300">—</p>;
  return (
    <p className={cn('mt-1 font-mono text-[11px] tabular-nums', selected ? 'text-emerald-600' : 'text-slate-400', count.counting && 'opacity-50')}>
      {count.input ?? '?'} → {count.output} {count.output === '1' ? 'doc' : 'docs'}
    </p>
  );
}
