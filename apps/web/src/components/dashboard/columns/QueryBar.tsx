// 문서 컬럼 헤더 아래의 쿼리 입력 — mongosh 모양으로 쓰고 Ctrl+Enter로 실행.
// 순서: 글자 → 파싱(parseQueryText) → 허용 연산자 검사(validateQueryFilter) → 서버. 어느 단계든 틀리면 아래 줄에 알린다.
// 빈 입력이나 {}로 실행하면 쿼리를 푼다. Esc = 닫기(쿼리는 그대로, 헤더 버튼의 점으로 남는다).
// 텍스트 위의 조건 칩(ConditionChips)은 텍스트에서 뽑은 것 — 칩을 고치면 텍스트를 새로 쓰고(formatQueryText) 바로 실행한다.
// Explain(9-9): 같은 파싱·검사 뒤 서버가 find(쿼리).explain('executionStats') — 결과는 아래 칸(ExplainPanel). 컬렉션이 바뀌면 지운다.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, ScanSearch, SquareTerminal, X } from 'lucide-react';
import { formatQueryText, parseQueryText, validateQueryFilter, type ExplainSummary, type JsonObject } from '../../../types/explorer';
import { api } from '../../../services/api';
import { cn } from '../../../utils/cn';
import { ConditionChips } from '../../query/ConditionChips';
import { ExplainPanel } from '../../query/ExplainPanel';
import { CopyBtn } from './CopyBtn';
import { mongoshExplainCommand, mongoshFindCommand } from '../../../utils/mongoshQuery';

interface QueryBarProps {
  // 지금 적용된 쿼리(글자 그대로) — 없으면 undefined
  appliedText: string | undefined;
  isApplied: boolean;
  // 실패하면 오류 메시지
  onRun: (filter: JsonObject | undefined, text: string) => Promise<string | null>;
  onClose: () => void;
  // 바뀔 때마다 입력창으로 커서를 보낸다(q 단축키·breadcrumb 칩). 없으면 열려도 커서를 가져가지 않는다(위의 필터 입력칸 몫)
  focusSignal?: number;
  // '+ condition'의 필드 자동완성 — 처음 열 때 한 번 부른다(이 컬렉션 문서 하나의 경로들)
  loadFieldSuggestions?: () => Promise<string[]>;
  // 상태 줄의 'mongosh로 복사'가 쓰는 대상
  database: string;
  collection: string;
}

const MIN_ROWS = 2;
const MAX_ROWS = 8;
// leading-5 = 20px/줄, 위아래 py-1.5 + 테두리
const LINE_PX = 20;
const CHROME_PX = 14;
// 상태 글자 옆의 아이콘 버튼(Explain · mongosh 복사)
const ICON_BTN = 'shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-600';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function QueryBar({ appliedText, isApplied, onRun, onClose, focusSignal, loadFieldSuggestions, database, collection }: QueryBarProps) {
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

  // Explain 결과 — 어느 글자·쿼리로 돌렸는지와 함께. seq: 컬렉션이 바뀐 뒤 늦게 온 답은 버린다
  const [explain, setExplain] = useState<{ summary: ExplainSummary; text: string; filter: JsonObject } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const explainSeq = useRef(0);
  useEffect(() => {
    explainSeq.current += 1;
    setExplain(null);
    setExplaining(false);
  }, [database, collection]);

  const [fieldSuggestions, setFieldSuggestions] = useState<string[] | null>(null);
  const parsedText = useMemo(() => parseQueryText(text), [text]);

  // 쿼리 객체를 실행한다(검사 → 서버). 빈 객체 = 쿼리 풀기
  const execute = async (filter: JsonObject, sourceText: string) => {
    const isEmpty = Object.keys(filter).length === 0;
    if (!isEmpty) {
      const invalid = validateQueryFilter(filter);
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
    const failure = await onRun(isEmpty ? undefined : filter, sourceText.trim());
    setRunning(false);
    setError(failure);
    if (isEmpty) setText('');
  };

  // 칩·빌더가 고친 쿼리 — 텍스트를 새로 쓰고 바로 실행
  const applyFromChips = (next: JsonObject) => {
    const nextText = Object.keys(next).length ? formatQueryText(next) : '';
    setText(nextText);
    void execute(next, nextText);
  };

  // 글자 → 쿼리. 못 읽으면 오류 줄에 알리고 틀린 자리로 커서를 옮긴다
  const parseOrReport = (): JsonObject | null => {
    const parsed = parseQueryText(text);
    if (parsed.ok) return parsed.filter;
    const { message, line, column } = parsed.error;
    setError(`${message} · line ${line}, col ${column}`);
    inputRef.current?.setSelectionRange(parsed.error.offset, parsed.error.offset);
    return null;
  };

  const run = async () => {
    if (running) return;
    const filter = parseOrReport();
    if (filter) await execute(filter, text);
  };

  const runExplain = async () => {
    if (running || explaining) return;
    const filter = parseOrReport();
    if (!filter) return;
    const invalid = validateQueryFilter(filter);
    if (invalid) {
      setError(invalid.path ? `${invalid.message} · ${invalid.path}` : invalid.message);
      return;
    }
    const seq = (explainSeq.current += 1);
    const sourceText = text.trim();
    setExplaining(true);
    try {
      const summary = await api.explainQuery(database, collection, filter);
      if (seq !== explainSeq.current) return;
      setError(null);
      setExplain({ summary, text: sourceText, filter });
    } catch (e) {
      if (seq === explainSeq.current) setError(`Explain failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (seq === explainSeq.current) setExplaining(false);
    }
  };

  const dirty = text.trim() !== (appliedText ?? '').trim();
  const hasQuery = parsedText.ok && Object.keys(parsedText.filter).length > 0;
  const status = running ? 'Running…' : explaining ? 'Explaining…' : isApplied && !dirty ? 'Applied' : `${isMac ? '⌘' : 'Ctrl'}+Enter to run`;
  // 높이는 내용에 맞춰(긴 줄이 접혀도 끝까지 보이게) — 최소 2줄, 최대 8줄을 넘으면 스크롤
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_ROWS * LINE_PX + CHROME_PX, Math.max(MIN_ROWS * LINE_PX + CHROME_PX, el.scrollHeight + 2))}px`;
  }, [text]);

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
      <ConditionChips
        filter={parsedText.ok ? parsedText.filter : null}
        fieldSuggestions={fieldSuggestions ?? []}
        onBuilderOpen={() => {
          if (fieldSuggestions || !loadFieldSuggestions) return;
          setFieldSuggestions([]);
          loadFieldSuggestions().then(setFieldSuggestions).catch(() => undefined);
        }}
        busy={running}
        onChange={applyFromChips}
        onEditText={() => inputRef.current?.focus()}
      />
      <textarea
        ref={inputRef}
        value={text}
        rows={MIN_ROWS}
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
          'block w-full resize-none rounded-lg border bg-white px-2.5 py-1.5 font-mono text-[13px] leading-5 text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-2 transition-all',
          error ? 'border-rose-300 focus:ring-rose-300/60' : 'border-slate-200 focus:ring-emerald-400/60',
        )}
      />
      {error && (
        <p role="alert" className="mt-1.5 break-words font-mono text-xs leading-4 text-rose-600">
          {error}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        {/* 상태 글자 + 바로 오른쪽에 아이콘(Explain · mongosh 복사) — 쿼리를 읽을 수 있고 비어 있지 않을 때만 */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          {/* 좁은 컬럼에선 잘린다 — 마우스를 올리면 전체 */}
          <span className={cn('min-w-0 truncate text-xs', isApplied && !dirty ? 'text-emerald-600' : 'text-slate-400')} title={status}>
            {status}
          </span>
          {hasQuery && (
            <>
              {/* 이 쿼리를 MongoDB가 어떻게 돌리는지(인덱스를 썼는지) */}
              <button
                type="button"
                disabled={running || explaining}
                className={cn(ICON_BTN, 'disabled:opacity-50')}
                aria-label="Explain"
                data-tt="Explain — how MongoDB runs this query, does it use an index? (runs it once, returns no documents)"
                onClick={() => void runExplain()}
              >
                <ScanSearch size={13} />
              </button>
              <CopyBtn text={mongoshFindCommand(database, collection, parsedText.filter)} icon={SquareTerminal} size={13} tip="Copy as a mongosh command" className={ICON_BTN} />
            </>
          )}
        </div>
        {(isApplied || text) && (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-700"
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
            'flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
            dirty ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-slate-100 text-slate-500 hover:bg-slate-200/70',
          )}
          onClick={() => void run()}
        >
          Run
          <CornerDownLeft size={12} />
        </button>
      </div>
      {explain && (
        <ExplainPanel
          summary={explain.summary}
          stale={explain.text !== text.trim()}
          mongoshCommand={mongoshExplainCommand(database, collection, explain.filter)}
          onClose={() => setExplain(null)}
        />
      )}
    </div>
  );
}
