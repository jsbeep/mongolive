// 문서 컬럼 머리 아래의 쿼리 입력 — mongosh 모양으로 쓰고 Ctrl+Enter로 실행.
// 순서: 글자 → 파싱(parseQueryText) → 허용 연산자 검사(validateQueryFilter) → 서버. 어느 단계든 틀리면 아래 줄에 알린다.
// 빈 입력이나 {}로 실행하면 쿼리를 푼다. Esc = 닫기(쿼리는 그대로, 머리 버튼의 점으로 남는다).
import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, X } from 'lucide-react';
import { parseQueryText, validateQueryFilter, type JsonObject } from '../../../types/explorer';
import { cn } from '../../../utils/cn';

interface QueryBarProps {
  // 지금 적용된 쿼리(글자 그대로) — 없으면 undefined
  appliedText: string | undefined;
  isApplied: boolean;
  // 실패하면 오류 메시지
  onRun: (filter: JsonObject | undefined, text: string) => Promise<string | null>;
  onClose: () => void;
  // 바뀔 때마다 입력창으로 커서를 보낸다(q 단축키·breadcrumb 칩). 없으면 열려도 커서를 가져가지 않는다(위의 필터 입력칸 몫)
  focusSignal?: number;
}

const MIN_ROWS = 2;
const MAX_ROWS = 8;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function QueryBar({ appliedText, isApplied, onRun, onClose, focusSignal }: QueryBarProps) {
  const [text, setText] = useState(appliedText ?? '');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 밖에서 쿼리가 바뀌면(다른 컬렉션을 열어 풀림 등) 입력창도 맞춘다
  useEffect(() => {
    setText(appliedText ?? '');
    setError(null);
  }, [appliedText]);

  useEffect(() => {
    if (focusSignal !== undefined) inputRef.current?.focus();
  }, [focusSignal]);

  const run = async () => {
    if (running) return;
    const parsed = parseQueryText(text);
    if (!parsed.ok) {
      const { message, line, column } = parsed.error;
      setError(`${message} · line ${line}, col ${column}`);
      // 틀린 자리로 커서를 옮긴다
      inputRef.current?.setSelectionRange(parsed.error.offset, parsed.error.offset);
      return;
    }
    const isEmpty = Object.keys(parsed.filter).length === 0;
    if (!isEmpty) {
      const invalid = validateQueryFilter(parsed.filter);
      if (invalid) {
        setError(invalid.path ? `${invalid.message} · ${invalid.path}` : invalid.message);
        return;
      }
    }
    if (isEmpty && !isApplied) {
      setError(null);
      return;
    }
    setRunning(true);
    const failure = await onRun(isEmpty ? undefined : parsed.filter, text.trim());
    setRunning(false);
    setError(failure);
    if (isEmpty) setText('');
  };

  const dirty = text.trim() !== (appliedText ?? '').trim();
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, text.split('\n').length));

  return (
    <div
      className="shrink-0 border-b border-slate-100 bg-slate-50/60 px-3 py-2"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void run();
        }
      }}
    >
      <textarea
        ref={inputRef}
        value={text}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={'{ age: { $gt: 51 }, _id: ObjectId("…") }'}
        aria-label="MongoDB query"
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        className={cn(
          'block w-full resize-none rounded-lg border bg-white px-2.5 py-1.5 font-mono text-xs leading-5 text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-2 transition-all',
          error ? 'border-rose-300 focus:ring-rose-300/60' : 'border-slate-200 focus:ring-emerald-400/60',
        )}
      />
      {error && (
        <p role="alert" className="mt-1.5 break-words font-mono text-[11px] leading-4 text-rose-600">
          {error}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={cn('min-w-0 flex-1 truncate text-[11px]', isApplied && !dirty ? 'text-emerald-600' : 'text-slate-400')}>
          {running ? 'Running…' : isApplied && !dirty ? 'Applied — live' : `${isMac ? '⌘' : 'Ctrl'}+Enter to run`}
        </span>
        {(isApplied || text) && (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-700"
            data-tt="Remove the query"
            onClick={() => {
              setText('');
              setError(null);
              if (isApplied) void onRun(undefined, '');
              inputRef.current?.focus();
            }}
          >
            <X size={12} />
            Clear
          </button>
        )}
        <button
          type="button"
          disabled={running}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50',
            dirty ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-slate-100 text-slate-500 hover:bg-slate-200/70',
          )}
          onClick={() => void run()}
        >
          Run
          <CornerDownLeft size={12} />
        </button>
      </div>
    </div>
  );
}
