// Query by example — 필드 행에 올리면 나오는 버튼(예전 Copy path 자리). 누르면 이 값을 기준으로 한 조건 목록:
//   숫자 = ≠ > ≥ < ≤ in · 날짜 + same day · 글자 = ≠ in contains starts/ends with length · oid = ≠ in
//   null = / ≠ / is null(없는 건 빼고) · 객체 exists missing · 배열 + empty / not empty / size = n / size ≥ n · 그리고 type
// 고르면 그 조건을 지금 쿼리에 더하고(AND, 같은 필드 규칙) 바로 실행한다. 다른 컬렉션의 문서(참조로 연 것)면
// 그 컬렉션으로 이동해서 건다 — 메뉴 헤더의 ⓘ가 알려 준다. Copy path는 메뉴 맨 아래로 옮겼다.
// 배열 안의 값(tags.0, items.3.name)은 기본이 '아무 원소'(tags, items.name), 'This position only'로 그 자리만.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info, ListFilterPlus, Route } from 'lucide-react';
import {
  CONDITION_OP_LABEL,
  dateMs,
  formatQueryValue,
  makeDate,
  textMatchRegex,
  valueKind,
  type Condition,
  type ConditionOp,
  type JsonValue,
} from '../../types/explorer';
import { copyToClipboard } from '../../utils/clipboard';
import { cn } from '../../utils/cn';

export interface QbeTarget {
  // 문서 안 경로(배열 인덱스 포함)
  path: string[];
  value: JsonValue;
  database: string;
  collection: string;
  // 지금 문서 목록의 컬렉션이 아니다(참조로 연 문서) — 고르면 그 컬렉션으로 이동
  elsewhere: boolean;
}

// 실제 실행은 explorer 상태가 한다(page.tsx가 넣어 준다) — 필드 행이 여러 컬럼·중첩 안에 있어서 props 대신 context로
// 조건이 여럿이면(same day = 이상 + 미만) 차례로 더한다
export type QbeHandler = (database: string, collection: string, conditions: Condition[]) => void;
export const QbeContext = createContext<QbeHandler | null>(null);

// group이 바뀌는 곳에 구분선 — 비교 / 글자 / 그 밖
type MenuItem = { label: string; conditions: Condition[]; group: number };

const isIndex = (segment: string) => /^\d+$/.test(segment);

// $type 이름 — 숫자는 종류(int/double/long/decimal)를 가리지 않는 'number'로
const TYPE_ALIAS: Partial<Record<ReturnType<typeof valueKind>, string>> = {
  string: 'string', int32: 'number', double: 'number', long: 'number', decimal128: 'number',
  date: 'date', oid: 'objectId', boolean: 'bool', null: 'null', array: 'array', object: 'object',
};

const int32 = (n: number): JsonValue => ({ $numberInt: String(n) });

// 그날 0시(이 브라우저 시간대) ~ 다음 날 0시
const dayRange = (value: JsonValue): { label: string; from: JsonValue; to: JsonValue } | null => {
  const ms = dateMs(value);
  if (ms === undefined) return null;
  const d = new Date(ms);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { label: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`, from: makeDate(start), to: makeDate(next) };
};

const itemsFor = (field: string, value: JsonValue): MenuItem[] => {
  const kind = valueKind(value);
  const one = (op: ConditionOp, v: JsonValue, group: number, label?: string): MenuItem => ({
    label: label ?? `${CONDITION_OP_LABEL[op]} ${formatQueryValue(v)}`,
    conditions: [{ field, op, value: v }],
    group,
  });
  const compare = (ops: ConditionOp[]) => ops.map((op) => one(op, value, 0));
  const typeItem = TYPE_ALIAS[kind] ? [one('type', TYPE_ALIAS[kind]!, 9, `type ${TYPE_ALIAS[kind]}`)] : [];
  const inItem = one('in', [value], 1, `in [${formatQueryValue(value)}, …]`);

  switch (kind) {
    case 'int32': case 'double': case 'long': case 'decimal128':
      return [...compare(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']), inItem, ...typeItem];
    case 'date': {
      const day = dayRange(value);
      const sameDay: MenuItem[] = day
        ? [{ label: `same day (${day.label})`, conditions: [{ field, op: 'gte', value: day.from }, { field, op: 'lt', value: day.to }], group: 1 }]
        : [];
      return [...compare(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']), ...sameDay, ...typeItem];
    }
    case 'string': {
      const text = value as string;
      const match = (mode: 'contains' | 'startsWith' | 'endsWith', label: string) =>
        one('regex', textMatchRegex({ mode, text }), 1, `${label} ${JSON.stringify(text)}`);
      return [
        ...compare(['eq', 'ne']),
        inItem,
        ...(text ? [match('contains', 'contains'), match('startsWith', 'starts with'), match('endsWith', 'ends with')] : []),
        one('regex', textMatchRegex({ mode: 'length', length: [...text].length }), 2, `length = ${[...text].length}`),
        ...typeItem,
      ];
    }
    case 'null':
      return [
        one('eq', null, 0, '= null (or missing)'),
        one('ne', null, 0, '≠ null (has a value)'),
        one('type', 'null', 0, 'is null (not missing)'),
      ];
    case 'object':
      return [one('exists', true, 0, 'exists'), one('exists', false, 0, 'missing'), ...typeItem];
    case 'array': {
      const n = (value as JsonValue[]).length;
      // $size는 정확한 개수만 — '이상'은 (n-1)번째 원소가 있는지로
      const atLeast = (k: number, label: string): MenuItem => ({ label, conditions: [{ field: `${field}.${k - 1}`, op: 'exists', value: true }], group: 1 });
      return [
        one('exists', true, 0, 'exists'),
        one('exists', false, 0, 'missing'),
        one('size', int32(0), 1, 'empty'),
        atLeast(1, 'not empty'),
        ...(n > 0 ? [one('size', int32(n), 1, `size = ${n}`)] : []),
        ...(n > 1 ? [atLeast(n, `size ≥ ${n}`)] : []),
        ...typeItem,
      ];
    }
    case 'oid':
      return [...compare(['eq', 'ne']), inItem, ...typeItem];
    case 'boolean':
      return [...compare(['eq', 'ne']), ...typeItem];
    default:
      return [...compare(['eq', 'ne']), one('exists', true, 1, 'exists')];
  }
};

const MENU_WIDTH = 260;

export function QbeMenu({ target }: { target: QbeTarget }) {
  const run = useContext(QbeContext);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [exactPosition, setExactPosition] = useState(false);
  const [copied, setCopied] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);

  const hasIndex = target.path.some(isIndex);
  const anyPath = target.path.filter((s) => !isIndex(s)).join('.');
  const exactPathText = target.path.join('.');
  const field = hasIndex && !exactPosition ? anyPath : exactPathText;
  const items = itemsFor(field, target.value);

  useLayoutEffect(() => {
    if (!anchor) return;
    const height = menuRef.current?.offsetHeight ?? 0;
    setTop(anchor.bottom + 4 + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 4) : anchor.bottom + 4);
  }, [anchor, items.length]);

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
    // 컬럼이 스크롤되면 버튼이 움직이므로 닫는다
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
    };
  }, [anchor]);

  if (!run) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label="Query by example"
        data-tt={anchor ? undefined : 'Find documents like this'}
        className={cn('p-1.5 rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors', anchor && 'bg-slate-100 text-slate-600')}
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect());
        }}
      >
        <ListFilterPlus size={14} />
      </button>
      {anchor && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Query by example"
          className="fixed z-[120] flex flex-col gap-0.5 rounded-xl bg-white p-1 shadow-elevated ring-1 ring-slate-100"
          style={{ top, left: Math.max(8, Math.min(anchor.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)), width: MENU_WIDTH }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-slate-600" title={field}>{field}</span>
            {target.elsewhere && (
              <span
                className="shrink-0 text-sky-500"
                aria-label={`Opens ${target.collection}`}
                data-tt={`Opens ${target.database}.${target.collection} and adds the condition there`}
              >
                <Info size={13} />
              </span>
            )}
          </div>
          {hasIndex && (
            <div className="mx-1 mb-1 flex rounded-lg bg-slate-100 p-0.5 text-xs">
              {[false, true].map((exact) => (
                <button
                  key={String(exact)}
                  type="button"
                  className={cn('flex-1 rounded-md px-1.5 py-0.5 transition-colors', exactPosition === exact ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500 hover:text-slate-700')}
                  onClick={() => setExactPosition(exact)}
                >
                  {exact ? 'This position only' : 'Any element'}
                </button>
              ))}
            </div>
          )}
          {items.map((item, index) => (
            <div key={item.label} className="contents">
              {index > 0 && items[index - 1].group !== item.group && <div className="mx-2 my-0.5 h-px bg-slate-100" />}
              <button
                type="button"
                role="menuitem"
                className="truncate rounded-lg px-2.5 py-1.5 text-left font-mono text-[13px] text-slate-600 transition-colors hover:bg-emerald-50 hover:text-emerald-800"
                title={item.label}
                onClick={() => {
                  setAnchor(null);
                  run(target.database, target.collection, item.conditions);
                }}
              >
                {item.label}
              </button>
            </div>
          ))}
          <div className="my-0.5 h-px bg-slate-100" />
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-500 transition-colors hover:bg-slate-100"
            onClick={() => {
              void copyToClipboard(exactPathText).then(() => {
                setCopied(true);
                setTimeout(() => {
                  setCopied(false);
                  setAnchor(null);
                }, 700);
              });
            }}
          >
            <Route size={13} className="shrink-0 text-slate-400" />
            <span className="flex-1">{copied ? 'Copied' : 'Copy path'}</span>
            <span className="max-w-[10ch] truncate font-mono text-xs text-slate-400">{exactPathText}</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
