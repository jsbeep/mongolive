// 스테이지 편집기 — 카드 바로 아래 펼쳐지는 인라인 편집기(필드의 InlineSegmentEditor와 같은 모양), 또는 통 JSON 모드의 전체 입력.
// 글자는 mongosh 모양 그대로({ $group: { _id: "$story" } }, ObjectId("…") 등). 적용하면 읽어 보고(파서) 허용 스테이지인지 본 뒤에만 저장한다.
//   Ctrl+Enter = Apply(저장하고 닫는다) · Ctrl+Shift+Enter = Preview(저장 없이 출력만, 열어 둔다) · Esc = 닫기(고친 글자는 남는다)
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Copy, CornerDownLeft, Eye, Trash2, Undo2, X } from 'lucide-react';
import { cn } from '../../utils/cn';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';
// leading-5 = 20px/줄, 위아래 py-2 + 테두리
const LINE_PX = 20;
const CHROME_PX = 18;

interface EditorBoxProps {
  text: string;
  error: string | null;
  dirty: boolean;
  // 0이 아니면 입력칸으로 커서(+ 고를 범위)를 보내고 onFocused로 알린다 — 부른 쪽이 0으로 돌려놓는다
  // (그래서 편집기가 다시 그려져도 커서를 다시 가져가지 않는다)
  focusSignal?: number;
  selectRange?: [number, number] | null;
  onFocused?: () => void;
  placeholder: string;
  ariaLabel: string;
  // 내용에 맞춰 늘리는 줄 수 — fill이면 남은 높이를 다 쓴다
  minRows?: number;
  maxRows?: number;
  fill?: boolean;
  hint: ReactNode;
  onChange: (text: string) => void;
  onApply: () => void;
  onPreview: () => void;
  onRevert: () => void;
  // Esc — 없으면 입력칸에서 나가기만
  onEscape?: () => void;
}

function EditorBox({ text, error, dirty, focusSignal, selectRange, onFocused, placeholder, ariaLabel, minRows = 3, maxRows = 14, fill = false, hint, onChange, onApply, onPreview, onRevert, onEscape }: EditorBoxProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusSignal === undefined || focusSignal === 0) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (selectRange) el.setSelectionRange(selectRange[0], selectRange[1]);
    onFocused?.();
  }, [focusSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // 높이는 내용에 맞춰(긴 줄이 접혀도 끝까지) — fill 모드는 CSS가 정한다
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || fill) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(maxRows * LINE_PX + CHROME_PX, Math.max(minRows * LINE_PX + CHROME_PX, el.scrollHeight + 2))}px`;
  }, [text, fill, minRows, maxRows]);

  return (
    <div
      className={cn('flex flex-col', fill && 'min-h-0 flex-1')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (e.shiftKey) onPreview();
          else onApply();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          if (onEscape) onEscape();
          else inputRef.current?.blur();
        }
      }}
    >
      <textarea
        ref={inputRef}
        value={text}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        // 통 JSON은 코드처럼 줄을 접지 않는다(들여쓰기가 흐트러지지 않게 — 긴 줄은 가로로 굴린다)
        wrap={fill ? 'off' : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'block w-full resize-none rounded-lg border bg-white px-2.5 py-2 font-mono text-[13px] leading-5 text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-2 transition-[box-shadow,border-color]',
          error ? 'border-rose-300 focus:ring-rose-300/60' : 'border-slate-200 focus:ring-emerald-400/60',
          fill && 'min-h-0 flex-1',
        )}
      />
      {error && (
        <p role="alert" className="mt-1.5 break-words font-mono text-xs leading-4 text-rose-600">
          {error}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{hint}</span>
        {dirty && (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-700"
            data-tt="Throw away the edit"
            onClick={onRevert}
          >
            <Undo2 size={12} />
            Revert
          </button>
        )}
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-200/70"
          data-tt={`Preview the output without saving — ${MOD}+Shift+Enter`}
          onClick={onPreview}
        >
          <Eye size={12} />
          Preview
        </button>
        <button
          type="button"
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
            dirty ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-slate-100 text-slate-500 hover:bg-slate-200/70',
          )}
          data-tt={`Save and show the output — ${MOD}+Enter`}
          onClick={onApply}
        >
          Apply
          <CornerDownLeft size={12} />
        </button>
      </div>
    </div>
  );
}

interface StageEditorProps {
  text: string;
  dirty: boolean;
  error: string | null;
  focusSignal: number;
  selectRange: [number, number] | null;
  onFocused: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  // 지우기는 한 번 더 눌러야 — 그 사이면 true
  confirmingDelete: boolean;
  onChange: (text: string) => void;
  onApply: () => void;
  onPreview: () => void;
  onRevert: () => void;
  onClose: () => void;
  onMove: (dir: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

const iconBtn = 'shrink-0 rounded-xl p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-30';

// 카드 아래 펼쳐지는 편집기 — 위 줄은 순서·복제·지우기·닫기, 아래는 입력칸과 Revert / Preview / Apply.
// 애니메이션 없이 바로 열고 닫는다(카드 크기가 바뀌는 걸 늘였다 줄였다 보이게 하지 않는다)
export function StageEditor({ text, dirty, error, focusSignal, selectRange, onFocused, canMoveUp, canMoveDown, confirmingDelete, onChange, onApply, onPreview, onRevert, onClose, onMove, onDuplicate, onDelete }: StageEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 열리면 다 보이게(목록 끝의 카드라도)
  useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Stage editor"
      className="relative z-10 mx-1 mb-1.5 mt-1 rounded-2xl bg-white p-3 shadow-panel ring-1 ring-slate-200/70"
      // 편집기 안을 눌러도 카드가 골라지지 않게(드래그 시작도 막는다)
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-0.5">
        {/* 좁은 컬럼에서도 잘리지 않게 짧게 — 고친 글자가 있으면 카드의 점과 같은 색 */}
        <span className={cn('min-w-0 flex-1 truncate text-xs font-medium', dirty ? 'text-amber-600' : 'text-slate-400')}>
          {dirty ? 'Edited' : 'Edit'}
        </span>
        <button type="button" className={iconBtn} disabled={!canMoveUp} aria-label="Move stage up" data-tt="Move up" onClick={() => onMove(-1)}>
          <ArrowUp size={14} />
        </button>
        <button type="button" className={iconBtn} disabled={!canMoveDown} aria-label="Move stage down" data-tt="Move down" onClick={() => onMove(1)}>
          <ArrowDown size={14} />
        </button>
        <button type="button" className={iconBtn} aria-label="Duplicate stage" data-tt="Duplicate" onClick={onDuplicate}>
          <Copy size={14} />
        </button>
        {confirmingDelete ? (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded-xl bg-rose-500 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-rose-600"
            onClick={onDelete}
          >
            <Trash2 size={12} />
            Delete?
          </button>
        ) : (
          <button type="button" className={cn(iconBtn, 'hover:bg-red-50 hover:text-red-500')} aria-label="Delete stage" data-tt="Delete" onClick={onDelete}>
            <Trash2 size={14} />
          </button>
        )}
        <button type="button" className={iconBtn} aria-label="Close the editor" data-tt="Close — Esc (the edit is kept)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <EditorBox
        text={text}
        error={error}
        dirty={dirty}
        focusSignal={focusSignal}
        selectRange={selectRange}
        onFocused={onFocused}
        placeholder={'{ $match: { score: { $gt: 100 } } }'}
        ariaLabel="Stage"
        hint={`${MOD}+Enter to apply`}
        onChange={onChange}
        onApply={onApply}
        onPreview={onPreview}
        onRevert={onRevert}
        onEscape={onClose}
      />
    </div>
  );
}

interface PipelineTextEditorProps {
  text: string;
  dirty: boolean;
  error: string | null;
  hint: ReactNode;
  focusSignal: number;
  onChange: (text: string) => void;
  onApply: () => void;
  onPreview: () => void;
  onRevert: () => void;
}

// 통 JSON 모드 — 파이프라인 전체를 배열 하나로
export function PipelineTextEditor({ text, dirty, error, hint, focusSignal, onChange, onApply, onPreview, onRevert }: PipelineTextEditorProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-3">
      <EditorBox
        fill
        text={text}
        error={error}
        dirty={dirty}
        focusSignal={focusSignal}
        placeholder={'[\n  { $match: { … } },\n  { $group: { _id: "$field" } }\n]'}
        ariaLabel="Aggregation pipeline"
        hint={hint}
        onChange={onChange}
        onApply={onApply}
        onPreview={onPreview}
        onRevert={onRevert}
      />
    </div>
  );
}
