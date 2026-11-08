// 조건 한 줄 입력 — [필드] [연산자 | 값 | 값 종류]. 빌더의 '+ condition'과 칩 고치기가 같이 쓴다.
// 값 종류 auto: 51 → 숫자, true → 불리언, 24자리 hex → ObjectId, 2024-01-31 → 날짜, 나머지 → 글자.
// in / not in은 쉼표로 여러 값("a,b"처럼 쉼표가 든 글자는 따옴표로).
import { useEffect, useId, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import {
  parseConditionValue,
  parseValueList,
  textMatchRegex,
  type Condition,
  type ConditionValueKind,
} from '../../types/explorer';
import { cn } from '../../utils/cn';

// 폼에서 고르는 연산자 — contains·starts/ends with·length는 정규식, missing은 $exists: false로 바뀐다
export type FormOp =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin'
  | 'contains' | 'startsWith' | 'endsWith' | 'length'
  | 'exists' | 'missing' | 'type';

const OPS: { value: FormOp; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'in', label: 'in' },
  { value: 'nin', label: 'not in' },
  { value: 'contains', label: 'contains' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'length', label: 'length =' },
  { value: 'exists', label: 'exists' },
  { value: 'missing', label: 'missing' },
  { value: 'type', label: 'type' },
];

// 글자로만 받는 연산자(값 종류 고르기를 숨긴다)
const TEXT_OPS = new Set<FormOp>(['contains', 'startsWith', 'endsWith', 'length', 'type']);
const PLACEHOLDER: Partial<Record<FormOp, string>> = {
  in: 'a, b, c',
  nin: 'a, b, c',
  contains: 'text',
  startsWith: 'text',
  endsWith: 'text',
  length: 'number of characters',
  type: 'string, number, date, objectId, array…',
};

const KINDS: { value: ConditionValueKind; label: string }[] = [
  { value: 'auto', label: 'auto' },
  { value: 'string', label: 'text' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'bool' },
  { value: 'date', label: 'date' },
  { value: 'oid', label: 'ObjectId' },
  { value: 'null', label: 'null' },
];

export interface ConditionFormInitial {
  field: string;
  op: FormOp;
  valueText: string;
  kind: ConditionValueKind;
}

interface ConditionFormProps {
  initial?: Partial<ConditionFormInitial>;
  // 칩 고치기에선 필드를 바꾸지 않는다
  fieldLocked?: boolean;
  fieldSuggestions?: string[];
  submitLabel: string;
  onSubmit: (condition: Condition) => void;
  onCancel: () => void;
}

const control = 'h-8 rounded-md border border-slate-200 bg-white px-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-400/60';

export function ConditionForm({ initial, fieldLocked, fieldSuggestions = [], submitLabel, onSubmit, onCancel }: ConditionFormProps) {
  const [field, setField] = useState(initial?.field ?? '');
  const [op, setOp] = useState<FormOp>(initial?.op ?? 'eq');
  const [valueText, setValueText] = useState(initial?.valueText ?? '');
  const [kind, setKind] = useState<ConditionValueKind>(initial?.kind ?? 'auto');
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  const needsValue = op !== 'exists' && op !== 'missing';

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const submit = () => {
    const name = field.trim();
    if (!name) return setError('Field name is empty');
    if (name.startsWith('$')) return setError('Field names can’t start with $');
    if (op === 'exists' || op === 'missing') return onSubmit({ field: name, op: 'exists', value: op === 'exists' });
    if (op === 'contains' || op === 'startsWith' || op === 'endsWith') {
      if (!valueText) return setError('Type the text to look for');
      return onSubmit({ field: name, op: 'regex', value: textMatchRegex({ mode: op, text: valueText }) });
    }
    if (op === 'length') {
      if (!/^\d+$/.test(valueText.trim())) return setError('Length is a whole number');
      return onSubmit({ field: name, op: 'regex', value: textMatchRegex({ mode: 'length', length: Number(valueText.trim()) }) });
    }
    if (op === 'type') {
      if (!valueText.trim()) return setError('Type a type name like string or date');
      return onSubmit({ field: name, op: 'type', value: valueText.trim() });
    }
    if (op === 'in' || op === 'nin') {
      const list = parseValueList(valueText, kind);
      if (!list.ok) return setError(list.message);
      return onSubmit({ field: name, op, value: list.value });
    }
    const parsed = parseConditionValue(valueText, kind);
    if (!parsed.ok) return setError(parsed.message);
    onSubmit({ field: name, op, value: parsed.value });
  };

  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-white p-2"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          // 쿼리 입력의 Ctrl+Enter(실행)까지 올라가지 않게
          e.preventDefault();
          e.stopPropagation();
          submit();
        }
      }}
    >
      {fieldLocked ? (
        <span className="truncate font-mono text-xs font-semibold text-slate-600">{field}</span>
      ) : (
        <>
          <input
            ref={firstRef}
            value={field}
            list={listId}
            placeholder="field (e.g. age, author.name)"
            aria-label="Field"
            spellCheck={false}
            autoCapitalize="off"
            className={cn(control, 'w-full font-mono')}
            onChange={(e) => {
              setField(e.target.value);
              setError(null);
            }}
          />
          <datalist id={listId}>
            {fieldSuggestions.map((path) => <option key={path} value={path} />)}
          </datalist>
        </>
      )}
      <div className="flex min-w-0 gap-1">
        <select aria-label="Operator" className={cn(control, 'shrink-0')} value={op} onChange={(e) => setOp(e.target.value as FormOp)}>
          {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {needsValue && (
          <>
            <input
              ref={fieldLocked ? firstRef : undefined}
              value={valueText}
              placeholder={PLACEHOLDER[op] ?? 'value'}
              aria-label="Value"
              spellCheck={false}
              disabled={kind === 'null' && !TEXT_OPS.has(op)}
              className={cn(control, 'min-w-0 flex-1 font-mono disabled:bg-slate-50')}
              onChange={(e) => {
                setValueText(e.target.value);
                setError(null);
              }}
            />
            {!TEXT_OPS.has(op) && (
              <select aria-label="Value type" className={cn(control, 'shrink-0')} value={kind} onChange={(e) => setKind(e.target.value as ConditionValueKind)}>
                {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            )}
          </>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
      <div className="flex justify-end gap-1">
        <button type="button" className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100" onClick={onCancel}>
          <X size={11} />
          Cancel
        </button>
        <button type="button" className="flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600" onClick={submit}>
          <Check size={11} />
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
