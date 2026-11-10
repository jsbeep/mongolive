// 스테이지 편집기의 Form 탭 — 흔한 스테이지만 문법 없이. 글자(JSON)가 원본이고 Form은 그걸 읽어 보여 주고, 고치면 새 값을 돌려준다.
// Form이 나타낼 수 없는 부분(식 연산자, 하위 파이프라인 등)은 'custom' 줄로 그대로 둔다 — 다른 줄을 고쳐도 건드리지 않는다.
//   $match   쿼리 바의 조건 칩 + '+ condition'
//   $group   묶을 필드(없으면 전체가 한 묶음) + 계산 필드 줄(이름 ← 누산기(필드 또는 상수))
//   $lookup  from / localField / foreignField / as
//   $sort    필드 줄(↑↓)
//   $limit · $skip · $sample  숫자 하나
// 같은 파일의 MatchChips는 Pipeline 카드에 보이는 작은 $match 칩(× = 조건 빼기).
import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import {
  describeFilter,
  isPlainObject,
  isWrapperObject,
  makeInt32,
  numericValue,
  stageName,
  type ConditionChip,
  type EjsonObject,
  type EjsonValue,
  type JsonObject,
} from '../../types/explorer';
import { ConditionChips, conditionChipText } from '../query/ConditionChips';
import { cn } from '../../utils/cn';

const FORM_STAGES = new Set(['$match', '$group', '$lookup', '$sort', '$limit', '$skip', '$sample']);
// 이 스테이지에 Form이 있나
export const hasStageForm = (stage: EjsonObject): boolean => Object.keys(stage).length === 1 && FORM_STAGES.has(stageName(stage));

const ACCUMULATORS = ['$sum', '$avg', '$min', '$max', '$count', '$first', '$last', '$push', '$addToSet'] as const;

const asObject = (value: EjsonValue | undefined): EjsonObject | null =>
  isPlainObject(value) && !isWrapperObject(value) ? (value as EjsonObject) : null;
const numberValue = (n: number): EjsonValue => (Number.isInteger(n) ? makeInt32(n) : { $numberDouble: String(n) });

const input = 'h-7 min-w-0 rounded-md border border-slate-200 bg-white px-1.5 font-mono text-xs text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-400/60';
const iconBtn = 'shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600';
const label = 'mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400';
const addBtn = 'flex h-7 items-center gap-0.5 self-start rounded-md px-1.5 text-xs text-slate-500 hover:bg-slate-200/70 hover:text-slate-700';

// Form이 못 나타내는 줄 — JSON에서 고친다
function CustomRow({ name, onEditJson }: { name: string; onEditJson: () => void }) {
  return (
    <button
      type="button"
      className="flex h-7 items-center gap-1.5 self-start rounded-md bg-slate-100 px-1.5 font-mono text-xs text-slate-500 hover:bg-slate-200/70"
      data-tt="Not something the form can show — edit it in JSON (it stays as is)"
      onClick={onEditJson}
    >
      <span className="max-w-[16ch] truncate">{name}</span>
      <span className="text-slate-400">{'{…} custom'}</span>
    </button>
  );
}

interface StageFormProps {
  stage: EjsonObject;
  // 이 스테이지에 들어오는 문서의 필드 경로(받아 둔 출력이 있으면)
  fieldSuggestions: string[];
  // 같은 DB의 컬렉션 — $lookup from
  collections: string[];
  onChange: (next: EjsonObject) => void;
  onEditJson: () => void;
}

export function StageForm(props: StageFormProps) {
  const listId = useId();
  const name = stageName(props.stage);
  const body = (
    name === '$match' ? <MatchForm {...props} />
      : name === '$group' ? <GroupForm {...props} listId={listId} />
      : name === '$lookup' ? <LookupForm {...props} listId={listId} />
      : name === '$sort' ? <SortForm {...props} listId={listId} />
      : <NumberForm {...props} />
  );
  return (
    <div className="flex flex-col gap-2">
      <datalist id={listId}>
        {props.fieldSuggestions.map((f) => <option key={f} value={f} />)}
      </datalist>
      {body}
    </div>
  );
}

// ── $match — 쿼리 바의 칩 그대로 ────────────────────────────────────────────
function MatchForm({ stage, fieldSuggestions, onChange, onEditJson }: StageFormProps) {
  const filter = asObject(stage.$match);
  if (!filter) return <CustomRow name="$match" onEditJson={onEditJson} />;
  return (
    <ConditionChips
      filter={filter as JsonObject}
      fieldSuggestions={fieldSuggestions}
      busy={false}
      onChange={(next) => onChange({ $match: next as EjsonObject })}
      onEditText={onEditJson}
    />
  );
}

// ── $group ─────────────────────────────────────────────────────────────────
type GroupRow =
  | { kind: 'acc'; name: string; op: (typeof ACCUMULATORS)[number]; arg: string }
  | { kind: 'custom'; name: string; value: EjsonValue };

// 계산 필드 하나 읽기 — { $avg: "$score" } / { $sum: 1 } / { $count: {} }
const readAccumulator = (name: string, value: EjsonValue): GroupRow => {
  const obj = asObject(value);
  const op = obj && Object.keys(obj).length === 1 ? Object.keys(obj)[0] : null;
  if (!obj || !op || !(ACCUMULATORS as readonly string[]).includes(op)) return { kind: 'custom', name, value };
  const arg = obj[op];
  if (op === '$count') return asObject(arg) && Object.keys(arg as object).length === 0 ? { kind: 'acc', name, op: '$count', arg: '' } : { kind: 'custom', name, value };
  if (typeof arg === 'string' && arg.startsWith('$')) return { kind: 'acc', name, op: op as (typeof ACCUMULATORS)[number], arg: arg.slice(1) };
  const n = numericValue(arg);
  if (n !== undefined) return { kind: 'acc', name, op: op as (typeof ACCUMULATORS)[number], arg: String(n) };
  return { kind: 'custom', name, value };
};
const writeAccumulator = (row: Extract<GroupRow, { kind: 'acc' }>): EjsonValue => {
  if (row.op === '$count') return { $count: {} };
  const trimmed = row.arg.trim();
  const n = trimmed !== '' && /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : undefined;
  return { [row.op]: n !== undefined ? numberValue(n) : `$${trimmed.replace(/^\$/, '')}` };
};

// 묶을 필드 — null(전체 한 묶음) / "$a" / { a: "$a", b: "$b.c" }. 그 밖(식)은 custom
const readGroupKey = (id: EjsonValue | undefined): string[] | null => {
  if (id === null || id === undefined) return [];
  if (typeof id === 'string' && id.startsWith('$')) return [id.slice(1)];
  const obj = asObject(id);
  if (obj && Object.values(obj).every((v) => typeof v === 'string' && v.startsWith('$'))) return Object.values(obj).map((v) => (v as string).slice(1));
  return null;
};
const writeGroupKey = (fields: string[]): EjsonValue => {
  if (!fields.length) return null;
  if (fields.length === 1) return `$${fields[0]}`;
  return Object.fromEntries(fields.map((f) => [f.replace(/\./g, '_'), `$${f}`]));
};

function GroupForm({ stage, onChange, onEditJson, listId }: StageFormProps & { listId: string }) {
  const group = asObject(stage.$group);
  const [newKey, setNewKey] = useState('');
  if (!group) return <CustomRow name="$group" onEditJson={onEditJson} />;
  const keys = readGroupKey(group._id);
  const rows = Object.entries(group).filter(([k]) => k !== '_id').map(([k, v]) => readAccumulator(k, v));
  const emit = (nextId: EjsonValue, nextRows: GroupRow[]) =>
    onChange({ $group: { _id: nextId, ...Object.fromEntries(nextRows.map((r) => [r.name, r.kind === 'acc' ? writeAccumulator(r) : r.value])) } });
  const setRow = (i: number, row: GroupRow) => emit(group._id ?? null, rows.map((r, j) => (j === i ? row : r)));
  const addKey = () => {
    const field = newKey.trim().replace(/^\$/, '');
    if (!field || !keys || keys.includes(field)) return;
    emit(writeGroupKey([...keys, field]), rows);
    setNewKey('');
  };

  return (
    <>
      <div>
        <p className={label}>Group by</p>
        {keys === null ? (
          <CustomRow name="_id" onEditJson={onEditJson} />
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {keys.length === 0 && <span className="text-xs text-slate-400">all documents (one group)</span>}
            {keys.map((k) => (
              <span key={k} className="flex h-7 items-center rounded-md bg-emerald-50 pl-1.5 font-mono text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200/70">
                {k}
                <button type="button" aria-label={`Stop grouping by ${k}`} className="ml-0.5 rounded-r-md px-1 text-emerald-500 hover:bg-emerald-100/70" onClick={() => emit(writeGroupKey(keys.filter((x) => x !== k)), rows)}>
                  <X size={11} />
                </button>
              </span>
            ))}
            <input
              className={cn(input, 'w-24')}
              list={listId}
              value={newKey}
              placeholder="+ field"
              aria-label="Group by another field"
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addKey();
                }
              }}
              onBlur={addKey}
            />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <p className={label}>Fields</p>
        {rows.map((row, i) => row.kind === 'custom' ? (
          <div key={i} className="flex items-center gap-1">
            <span className="w-20 shrink-0 truncate font-mono text-xs text-slate-600">{row.name}</span>
            <CustomRow name={row.name} onEditJson={onEditJson} />
          </div>
        ) : (
          // 두 줄 — 좁은 컬럼에서도 인자 칸이 눌리지 않게. 위: 결과 이름(+ 지우기), 아래: 누산기 ← 필드 또는 숫자
          <div key={i} className="flex flex-col gap-1 rounded-lg bg-slate-50 p-1.5">
            <div className="flex items-center gap-1">
              <input className={cn(input, 'flex-1 font-semibold')} value={row.name} aria-label="Field name" onChange={(e) => setRow(i, { ...row, name: e.target.value })} />
              <button type="button" className={iconBtn} aria-label={`Remove ${row.name}`} onClick={() => emit(group._id ?? null, rows.filter((_, j) => j !== i))}>
                <X size={12} />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <select className={cn(input, 'w-[5.75rem] shrink-0')} value={row.op} aria-label="Accumulator" onChange={(e) => setRow(i, { ...row, op: e.target.value as typeof row.op, arg: e.target.value === '$count' ? '' : row.arg || '1' })}>
                {ACCUMULATORS.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
              {row.op !== '$count' ? (
                <input className={cn(input, 'flex-1')} list={listId} value={row.arg} placeholder="field or number" aria-label="Field or number" onChange={(e) => setRow(i, { ...row, arg: e.target.value })} />
              ) : (
                <span className="truncate text-xs text-slate-400">counts documents</span>
              )}
            </div>
          </div>
        ))}
        <button
          type="button"
          className={addBtn}
          onClick={() => {
            let n = rows.length + 1;
            while (rows.some((r) => r.name === `field${n}`)) n += 1;
            emit(group._id ?? null, [...rows, { kind: 'acc', name: `field${n}`, op: '$sum', arg: '1' }]);
          }}
        >
          <Plus size={11} /> field
        </button>
      </div>
    </>
  );
}

// ── $lookup ────────────────────────────────────────────────────────────────
const LOOKUP_KEYS = ['from', 'localField', 'foreignField', 'as'] as const;

function LookupForm({ stage, collections, onChange, onEditJson, listId }: StageFormProps & { listId: string }) {
  const lookup = asObject(stage.$lookup);
  const simple = lookup && Object.keys(lookup).every((k) => (LOOKUP_KEYS as readonly string[]).includes(k)) && Object.values(lookup).every((v) => typeof v === 'string');
  if (!lookup || !simple) {
    return <p className="text-xs leading-relaxed text-slate-500">This $lookup uses a sub-pipeline or let — <button type="button" className="text-emerald-600 underline" onClick={onEditJson}>edit it in JSON</button>.</p>;
  }
  const value = (k: (typeof LOOKUP_KEYS)[number]) => (lookup[k] as string | undefined) ?? '';
  const set = (k: (typeof LOOKUP_KEYS)[number], v: string) => onChange({ $lookup: { ...Object.fromEntries(LOOKUP_KEYS.map((key) => [key, value(key)])), [k]: v } });
  const from = value('from');
  const fromOptions = collections.includes(from) || !from ? collections : [from, ...collections];
  const row = (k: (typeof LOOKUP_KEYS)[number], title: string, control: React.ReactNode) => (
    <label className="flex items-center gap-2">
      <span className="w-[5.5rem] shrink-0 text-xs text-slate-500">{title}</span>
      {control}
    </label>
  );
  return (
    <div className="flex flex-col gap-1">
      {row('from', 'from', (
        <select className={cn(input, 'flex-1')} value={from} onChange={(e) => set('from', e.target.value)}>
          {!from && <option value="">pick a collection</option>}
          {fromOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      ))}
      {row('localField', 'local field', <input className={cn(input, 'flex-1')} list={listId} value={value('localField')} onChange={(e) => set('localField', e.target.value)} />)}
      {row('foreignField', `field in ${from || 'it'}`, <input className={cn(input, 'flex-1')} value={value('foreignField')} placeholder="_id" onChange={(e) => set('foreignField', e.target.value)} />)}
      {row('as', 'save as', <input className={cn(input, 'flex-1')} value={value('as')} onChange={(e) => set('as', e.target.value)} />)}
    </div>
  );
}

// ── $sort ──────────────────────────────────────────────────────────────────
function SortForm({ stage, onChange, onEditJson, listId }: StageFormProps & { listId: string }) {
  const sort = asObject(stage.$sort);
  const [newField, setNewField] = useState('');
  if (!sort) return <CustomRow name="$sort" onEditJson={onEditJson} />;
  const entries = Object.entries(sort);
  const emit = (next: [string, EjsonValue][]) => onChange({ $sort: Object.fromEntries(next) });
  const add = () => {
    const field = newField.trim();
    if (!field || field in sort) return;
    emit([...entries, [field, makeInt32(1)]]);
    setNewField('');
  };
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([field, dir], i) => {
        const n = numericValue(dir);
        return (
          <div key={field} className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">{field}</span>
            {n === 1 || n === -1 ? (
              <button
                type="button"
                className="flex h-7 items-center gap-1 rounded-md bg-slate-100 px-2 text-xs text-slate-600 hover:bg-slate-200/70"
                data-tt="Click to flip the direction"
                onClick={() => emit(entries.map(([f, d]) => (f === field ? [f, makeInt32(n === 1 ? -1 : 1)] : [f, d])))}
              >
                {n === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                {n === 1 ? 'ascending' : 'descending'}
              </button>
            ) : (
              <CustomRow name={field} onEditJson={onEditJson} />
            )}
            <button type="button" className={iconBtn} disabled={i === 0} aria-label={`Move ${field} up`} data-tt="Sort by this first" onClick={() => emit(entries.map((e, j) => (j === i - 1 ? entries[i] : j === i ? entries[i - 1] : e)))}>
              <ArrowUp size={12} />
            </button>
            <button type="button" className={iconBtn} aria-label={`Remove ${field}`} onClick={() => emit(entries.filter(([f]) => f !== field))}>
              <X size={12} />
            </button>
          </div>
        );
      })}
      <input
        className={cn(input, 'w-32')}
        list={listId}
        value={newField}
        placeholder="+ field"
        aria-label="Sort by another field"
        onChange={(e) => setNewField(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

// ── $limit · $skip · $sample — 숫자 하나 ──────────────────────────────────────
function NumberForm({ stage, onChange, onEditJson }: StageFormProps) {
  const name = stageName(stage);
  const sample = name === '$sample';
  const raw = sample ? asObject(stage.$sample)?.size : stage[name];
  const n = numericValue(raw);
  if (n === undefined) return <CustomRow name={name} onEditJson={onEditJson} />;
  const title = name === '$limit' ? 'Keep the first' : name === '$skip' ? 'Skip the first' : 'Pick at random';
  return (
    <label className="flex items-center gap-2 text-xs text-slate-500">
      {title}
      <input
        type="number"
        min={sample ? 1 : 0}
        className={cn(input, 'w-24')}
        value={n}
        onChange={(e) => {
          const next = Math.max(0, Math.trunc(Number(e.target.value)));
          if (Number.isNaN(next)) return;
          onChange(sample ? { $sample: { size: makeInt32(next) } } : { [name]: makeInt32(next) });
        }}
      />
      documents
    </label>
  );
}

// ── Pipeline 카드의 $match 칩 — 조건마다 작게, × = 빼기(초안으로). 많으면 몇 개만 보이고 +N ──────
const CARD_CHIPS = 3;
export function MatchChips({ filter, selected, onRemove }: { filter: EjsonObject; selected: boolean; onRemove: (chip: Extract<ConditionChip, { kind: 'condition' }>) => void }) {
  const chips = describeFilter(filter);
  if (!chips.length) return <p className={cn('mt-0.5 truncate text-xs', selected ? 'text-emerald-600/80' : 'text-slate-500')}>all documents</p>;
  const shown = chips.slice(0, CARD_CHIPS);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {shown.map((chip, i) => {
        if (chip.kind === 'custom') {
          return <span key={`c-${chip.field}`} className="rounded bg-slate-100 px-1 font-mono text-[11px] text-slate-500">{chip.field} {'{…}'}</span>;
        }
        const { op, value } = conditionChipText(chip);
        return (
          <span key={`${chip.field}-${chip.op}-${i}`} className="flex max-w-full items-center rounded bg-emerald-50 font-mono text-[11px] text-emerald-800 ring-1 ring-emerald-200/70">
            <span className="min-w-0 truncate py-px pl-1">
              <span className="font-semibold">{chip.field}</span> <span className="text-emerald-600">{op}</span> {value}
            </span>
            <button
              type="button"
              aria-label={`Remove ${chip.field} ${op}`}
              data-tt="Remove this condition (applied with Run or Apply)"
              className="shrink-0 rounded-r px-0.5 text-emerald-500 hover:bg-emerald-100/70 hover:text-emerald-700"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(chip);
              }}
            >
              <X size={10} />
            </button>
          </span>
        );
      })}
      {chips.length > CARD_CHIPS && <span className="font-mono text-[11px] text-slate-400">+{chips.length - CARD_CHIPS}</span>}
    </div>
  );
}
