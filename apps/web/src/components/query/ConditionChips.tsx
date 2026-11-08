// 쿼리 입력 위의 조건 칩 — 쿼리 텍스트에서 단순한 조건만 뽑아(describeFilter) 보여 준다.
//   칩 누르기 = 그 조건 고치기, × = 빼기, + condition = 조건 더하기(같은 필드 규칙은 addCondition).
//   칩으로 못 나타내는 부분($or, $in …)은 회색 {…} 칩 — 누르면 텍스트로 간다.
// 무엇을 하든 새 쿼리 객체를 onChange로 넘기면 QueryBar가 텍스트를 새로 쓰고 바로 실행한다.
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  CONDITION_OP_LABEL,
  addCondition,
  conditionValueText,
  describeFilter,
  formatQueryValue,
  readTextMatch,
  removeCondition,
  valueListText,
  dateMs,
  valueKind,
  type Condition,
  type ConditionChip,
  type JsonObject,
  type JsonValue,
} from '../../types/explorer';
import { cn } from '../../utils/cn';
import { ConditionForm, type ConditionFormInitial } from './ConditionForm';

interface ConditionChipsProps {
  // 지금 텍스트를 읽은 쿼리 — 읽을 수 없으면(문법 오류) null: 칩을 감추고 '+'도 막는다
  filter: JsonObject | null;
  fieldSuggestions: string[];
  // 빌더를 열 때 — 필드 자동완성 후보를 받아 오게
  onBuilderOpen?: () => void;
  busy: boolean;
  onChange: (next: JsonObject) => void;
  onEditText: () => void;
}

const VALUE_MAX = 22;
const short = (text: string) => (text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text);

// 칩에 보일 값 — 날짜는 짧은 현지 시각(자정이면 날짜만), oid는 끝 8자리. 텍스트는 그대로(mongosh 모양)
const pad = (n: number) => String(n).padStart(2, '0');
const chipValue = (value: JsonValue): string => {
  const kind = valueKind(value);
  if (kind === 'date') {
    const d = new Date(dateMs(value)!);
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return d.getHours() || d.getMinutes() || d.getSeconds() ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
  }
  if (kind === 'oid') return `…${(value as { $oid: string }).$oid.slice(-8)}`;
  return short(formatQueryValue(value));
};
// in / not in — 첫 값 + 나머지 개수
const listValue = (value: JsonValue): string => {
  if (!Array.isArray(value)) return chipValue(value);
  if (value.length === 0) return '[]';
  return value.length === 1 ? `[${chipValue(value[0])}]` : `[${chipValue(value[0])}] +${value.length - 1}`;
};

const TEXT_MODE_LABEL = { contains: 'contains', startsWith: 'starts with', endsWith: 'ends with' } as const;

const chipText = (chip: Extract<ConditionChip, { kind: 'condition' }>): { op: string; value: string } => {
  if (chip.op === 'exists') return { op: chip.value ? 'exists' : 'missing', value: '' };
  if (chip.op === 'regex') {
    const match = readTextMatch(chip.value);
    if (!match) return { op: '~', value: short(formatQueryValue(chip.value)) };
    if (match.mode === 'length') return { op: 'length =', value: String(match.length) };
    return { op: TEXT_MODE_LABEL[match.mode], value: short(JSON.stringify(match.text)) };
  }
  if (chip.op === 'type') return { op: 'type', value: String(chip.value) };
  if (chip.op === 'in' || chip.op === 'nin') return { op: CONDITION_OP_LABEL[chip.op], value: listValue(chip.value) };
  return { op: CONDITION_OP_LABEL[chip.op], value: chipValue(chip.value) };
};

// 칩 → 고치기 폼의 처음 값. 폼으로 못 고치는 값(객체·배열·임의 정규식)이면 null
const formInitial = (chip: Extract<ConditionChip, { kind: 'condition' }>): ConditionFormInitial | null => {
  if (chip.op === 'exists') return { field: chip.field, op: chip.value ? 'exists' : 'missing', valueText: '', kind: 'auto' };
  if (chip.op === 'regex') {
    const match = readTextMatch(chip.value);
    if (!match) return null;
    if (match.mode === 'length') return { field: chip.field, op: 'length', valueText: String(match.length), kind: 'auto' };
    return { field: chip.field, op: match.mode, valueText: match.text, kind: 'string' };
  }
  if (chip.op === 'type') return typeof chip.value === 'string' ? { field: chip.field, op: 'type', valueText: chip.value, kind: 'auto' } : null;
  if (chip.op === 'in' || chip.op === 'nin') {
    const list = Array.isArray(chip.value) ? valueListText(chip.value) : null;
    return list ? { field: chip.field, op: chip.op, valueText: list.text, kind: list.kind } : null;
  }
  if (chip.op === 'size') return null;
  const value = conditionValueText(chip.value);
  return value ? { field: chip.field, op: chip.op, valueText: value.text, kind: value.kind } : null;
};

export function ConditionChips({ filter, fieldSuggestions, onBuilderOpen, busy, onChange, onEditText }: ConditionChipsProps) {
  // 고치는 중인 칩 번호, 또는 'new'(+ condition)
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const chips = filter ? describeFilter(filter) : [];

  const apply = (next: JsonObject) => {
    setEditing(null);
    onChange(next);
  };

  return (
    <div className="mb-1.5 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {chips.map((chip, index) => {
          if (chip.kind === 'custom') {
            return (
              <button
                key={`custom-${chip.field}`}
                type="button"
                className="flex h-7 items-center gap-1 rounded-md bg-slate-100 px-1.5 font-mono text-xs text-slate-500 hover:bg-slate-200/70"
                data-tt="Edit this part in the text below"
                onClick={onEditText}
              >
                <span className="max-w-[12ch] truncate">{chip.field}</span>
                <span className="text-slate-400">{'{…}'}</span>
              </button>
            );
          }
          const { op, value } = chipText(chip);
          const editable = formInitial(chip) !== null;
          return (
            <span
              key={`${chip.field}-${chip.op}-${index}`}
              className={cn(
                'flex h-7 max-w-full items-center rounded-md bg-emerald-50 font-mono text-xs text-emerald-800 ring-1 ring-emerald-200/70',
                editing === index && 'ring-2 ring-emerald-400',
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1 rounded-l-md py-0.5 pl-1.5 pr-1 hover:bg-emerald-100/70"
                data-tt={editable ? 'Change this condition' : 'Edit this condition in the text below'}
                onClick={() => (editable ? setEditing(editing === index ? null : index) : onEditText())}
              >
                <span className="max-w-[12ch] truncate font-semibold">{chip.field}</span>
                <span className="text-emerald-600">{op}</span>
                {value && <span className="truncate">{value}</span>}
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-r-md px-1 py-0.5 text-emerald-500 hover:bg-emerald-100/70 hover:text-emerald-700 disabled:opacity-40"
                aria-label={`Remove ${chip.field} ${op}`}
                onClick={() => filter && apply(removeCondition(filter, chip.field, chip.op))}
              >
                <X size={11} />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          disabled={!filter || busy}
          className={cn(
            'flex h-7 items-center gap-0.5 rounded-md px-1.5 text-xs text-slate-500 hover:bg-slate-200/70 hover:text-slate-700 disabled:opacity-40',
            editing === 'new' && 'bg-slate-200/70 text-slate-700',
          )}
          data-tt={filter ? 'Add a condition (AND)' : 'Fix the query text first'}
          onClick={() => {
            if (editing !== 'new') onBuilderOpen?.();
            setEditing(editing === 'new' ? null : 'new');
          }}
        >
          <Plus size={11} />
          condition
        </button>
      </div>

      {editing === 'new' && filter && (
        <ConditionForm
          fieldSuggestions={fieldSuggestions}
          submitLabel="Add"
          onSubmit={(condition: Condition) => apply(addCondition(filter, condition))}
          onCancel={() => setEditing(null)}
        />
      )}
      {typeof editing === 'number' && filter && chips[editing]?.kind === 'condition' && (() => {
        const chip = chips[editing] as Extract<ConditionChip, { kind: 'condition' }>;
        return (
          <ConditionForm
            key={editing}
            initial={formInitial(chip) ?? undefined}
            fieldLocked
            submitLabel="Apply"
            onSubmit={(condition: Condition) => apply(addCondition(removeCondition(filter, chip.field, chip.op), condition))}
            onCancel={() => setEditing(null)}
          />
        );
      })()}
    </div>
  );
}
