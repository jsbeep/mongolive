// path: src/components/dashboard/Breadcrumbs.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Database, Folder, FileText, Braces, ChevronRight,
  KeyRound, Calendar, Sigma, Binary, Hash, CornerDownLeft, CornerUpLeft,
  ToggleLeft, Ban, Box,
} from 'lucide-react';
import { openSearchPanel } from '../../services/queryPanel';
import { ExplorerPathSegment, Document, JsonValue, type DatabaseSummary } from '../../types/explorer';
import { getEntries, getFieldType, isExpandableType, type JsonFieldType } from '../../utils/jsonTree';
import { cn } from '../../utils/cn';
import { BreadcrumbDatabaseMenu } from './BreadcrumbDatabaseMenu';

const styles = {
  container: 'relative flex h-12 min-h-12 items-center overflow-hidden rounded-[14px] m-3 mb-0 border border-slate-200/80 bg-white/80 px-3 shadow-soft backdrop-blur',
  track: 'flex w-full items-center gap-0.5 overflow-x-auto whitespace-nowrap scroll-smooth',
  trackScroll: 'scrollbar-hide',
  empty: 'text-[13px] font-medium text-slate-400',
  breadcrumbBase: 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
  breadcrumbHover: 'hover:bg-slate-100/30 cursor-pointer text-slate-600 hover:text-slate-800',
  breadcrumbActive: 'bg-slate-100/60 text-slate-900 font-semibold',
  icon: 'h-3.5 w-3.5',
  chevron: 'h-3 w-3 shrink-0 text-slate-300',
  pathInputWrap: 'flex h-7 shrink-0 items-center my-1',
  pathInput: 'h-7 min-w-[140px] rounded-lg bg-slate-100/80 px-2.5 text-[13px] font-mono font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 focus:bg-white transition-all',
  dropdownPanel: 'fixed z-[101] max-h-[320px] min-w-[220px] overflow-y-auto rounded-2xl bg-white shadow-elevated ring-1 ring-slate-100 p-1.5 flex flex-col gap-0.5',
  dropdownItem: 'relative flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer select-none transition-colors',
  dropdownItemActive: 'bg-selected',
  dropdownKey: 'flex-1 min-w-0 truncate text-[13px] font-mono font-medium text-slate-700',
  typeBadge: 'flex items-center justify-center gap-1 text-[11px] font-mono pl-1.5 pr-2 py-0.5 rounded-lg font-semibold shrink-0',
  countBadge: 'text-[11px] font-mono px-2 py-0.5 rounded-lg bg-slate-100 text-slate-400 font-medium shrink-0',
  enterHint: 'shrink-0 text-slate-300',
  dropdownEmpty: 'px-3 py-4 text-xs text-slate-400 text-center',
  dropdownBack: 'relative flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer select-none transition-colors text-slate-500',
  dropdownDivider: 'h-px bg-slate-100 my-1',
  // 빈 공간에 올리면 보이는 '경로 입력' 표시
  pathHint: 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-300 font-mono text-[13px] font-semibold leading-none text-slate-400 opacity-0 transition-opacity group-hover/path:opacity-100',
  // 쿼리가 걸린 컬렉션 칸 옆 칩
  queryChip: 'inline-flex h-5 shrink-0 items-center rounded-md bg-emerald-100 px-1.5 font-mono text-[11px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-200/80',
} as const;

const TYPE_BADGE: Partial<Record<JsonFieldType, { icon: typeof KeyRound; label: string; bg: string; text: string; iconColor: string }>> = {
  oid: { icon: KeyRound, label: 'OID', bg: 'bg-amber-50', text: 'text-amber-600', iconColor: 'text-amber-500' },
  date: { icon: Calendar, label: 'DATE', bg: 'bg-rose-50', text: 'text-rose-600', iconColor: 'text-rose-400' },
  decimal128: { icon: Sigma, label: 'DEC128', bg: 'bg-teal-50', text: 'text-teal-600', iconColor: 'text-teal-400' },
  long: { icon: Binary, label: 'LONG', bg: 'bg-indigo-50', text: 'text-indigo-600', iconColor: 'text-indigo-400' },
  opaque: { icon: Box, label: 'BSON', bg: 'bg-slate-100', text: 'text-slate-500', iconColor: 'text-slate-400' },
};

interface BreadcrumbsProps {
  breadcrumbs: ExplorerPathSegment[];
  onNavigate: (index: number) => void;
  openDocument: Document | null;
  onCommitFieldPath: (segments: string[]) => void;
  // 첫 칸(DB) 드롭다운용
  databases: DatabaseSummary[];
  activeDatabase: string | null;
  onSelectDatabase: (name: string) => void;
  // 문서 목록에 사용자 쿼리가 걸려 있으면 그 글자 — 컬렉션 칸 옆에 칩으로(누르면 쿼리 바)
  queryText?: string;
}

const getIconForKind = (kind: ExplorerPathSegment['kind']) => {
  switch (kind) {
    case 'database':
      return Database;
    case 'collection':
      return Folder;
    case 'document':
      return FileText;
    case 'field':
      return Braces;
    default:
      return null;
  }
};

export function Breadcrumbs({ breadcrumbs, onNavigate, openDocument, onCommitFieldPath, databases, activeDatabase, onSelectDatabase, queryText }: BreadcrumbsProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState('.');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [shake, setShake] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });

  // 문서 범위 경계 — breadcrumb 중 마지막 'document' 세그먼트. 그 세그먼트가 참조(REF) 체인이면
  // (chainColor가 있음) v1에서는 편집 진입을 막는다 — 참조 문서 전체 JSON이 hook 레벨에 없기 때문.
  let boundaryIndex = -1;
  for (let i = breadcrumbs.length - 1; i >= 0; i--) {
    if (breadcrumbs[i].kind === 'document') {
      boundaryIndex = i;
      break;
    }
  }
  const isReferenceBoundary = boundaryIndex >= 0 && breadcrumbs[boundaryIndex].chainColor !== undefined;
  const canEdit = boundaryIndex >= 0 && !isReferenceBoundary;

  // Auto-scroll to end when breadcrumbs change
  useEffect(() => {
    if (!trackRef.current || isEditing) return;
    const timeoutId = setTimeout(() => {
      const { scrollWidth, clientWidth } = trackRef.current!;
      if (scrollWidth > clientWidth) {
        trackRef.current!.scrollLeft = scrollWidth - clientWidth;
      }
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [breadcrumbs, isEditing]);

  // 편집 모드 진입 시 입력 위치 계산 + 포커스
  useEffect(() => {
    if (!isEditing) return;
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect) setDropdownPos({ top: rect.bottom + 6, left: rect.left });
    inputRef.current?.focus();
  }, [isEditing]);

  // 바깥(breadcrumb 영역도 아니고 portal로 띄운 dropdown도 아닌 곳) 클릭 시 편집 취소.
  // capture 단계에서 검사해야 한다 — bubble 단계까지 기다리면 React가 같은 mousedown으로
  // candidate 목록을 먼저 갱신해(다음 depth로 key가 바뀌며 클릭한 DOM 노드 자체가 사라짐)
  // target이 이미 detach된 뒤라 dropdownRef.contains(target)가 항상 false로 나와 즉시 닫혀버린다.
  useEffect(() => {
    if (!isEditing) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setIsEditing(false);
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    return () => document.removeEventListener('mousedown', handlePointerDown, true);
  }, [isEditing]);

  // 입력값에서 매번 순수하게 파싱 — 메모리에 별도 스택을 들고 있지 않아 백스페이스/커서 이동으로
  // 중간을 고쳐도 항상 현재 텍스트 기준으로 다시 계산된다.
  const { confirmed, query, candidates, livePushSegments } = useMemo(() => {
    const raw = inputValue.startsWith('.') ? inputValue.slice(1) : inputValue;
    const parts = raw.split('.');
    const query = parts[parts.length - 1] ?? '';
    const confirmedParts = parts.slice(0, -1);

    let node: JsonValue = openDocument as JsonValue;
    let valid = true;
    for (const seg of confirmedParts) {
      const match = getEntries(node).find((e) => e.key === seg);
      if (!match) { valid = false; break; }
      node = match.value;
    }
    const candidates = valid
      ? getEntries(node).filter((e) => e.key.toLowerCase().startsWith(query.toLowerCase()))
      : [];

    // confirmed 중 object/array인 접두사만 — 컬럼은 isExpandable한 key에만 생기므로
    // 끝에 leaf가 걸리면(또는 끝까지 못 내려가면) 그 직전까지만 live push 대상이 된다.
    let liveNode: JsonValue = openDocument as JsonValue;
    const livePushSegments: string[] = [];
    for (const seg of confirmedParts) {
      const match = getEntries(liveNode).find((e) => e.key === seg);
      if (!match || !isExpandableType(getFieldType(match.value))) break;
      livePushSegments.push(seg);
      liveNode = match.value;
    }
    return { confirmed: confirmedParts, query, candidates, livePushSegments };
  }, [inputValue, openDocument]);

  // 문서 루트가 아니면 '뒤로가기'를 보여준다. dropdown 인덱스 공간은 [뒤로가기(있으면), ...candidates]
  // 순서로 시각적 위치와 그대로 맞춘다 — 그래야 ArrowUp/Down 순환이 화면에 보이는 순서와 일치한다.
  const showBack = confirmed.length > 0;
  const backIndex = showBack ? 0 : -1;
  const candidateOffset = showBack ? 1 : 0;
  const itemCount = candidates.length + candidateOffset;

  // 입력값이 바뀌면 하이라이트를 첫 후보로 되돌린다(뒤로가기가 있어도) — 타이핑 후 그냥 Enter를
  // 누르면 첫 후보가 자동완성되는 기존 흐름을 유지한다. 뒤로가기는 ArrowUp으로 한 번 더 올라가면 닿는다.
  useEffect(() => {
    setHighlightIndex(candidates.length > 0 ? candidateOffset : 0);
  }, [inputValue]);

  const goBack = () => {
    const parent = confirmed.slice(0, -1);
    setInputValue(parent.length > 0 ? `.${parent.join('.')}.` : '.');
  };

  // 확정된 경로가 바뀔 때마다(타이핑으로 '.' 완성하거나 dropdown 클릭) 컬럼을 즉시 동기화 —
  // 더 짧은 경로를 고르면 그만큼 pop, 더 깊은 expandable key를 고르면 그만큼 push.
  const livePushedRef = useRef<string>('');
  useEffect(() => {
    if (!isEditing) return;
    const key = JSON.stringify(livePushSegments);
    if (key === livePushedRef.current) return;
    livePushedRef.current = key;
    onCommitFieldPath(livePushSegments);
  }, [isEditing, livePushSegments, onCommitFieldPath]);

  const startEditing = () => {
    if (!canEdit) return;
    // 현재 펼쳐져 있던 field 경로를 그대로 입력값으로 채워 넣어 이어서 수정할 수 있게 한다.
    // 이미 펼쳐진 상태와 같으므로 live-sync ref도 맞춰둬서 진입 즉시 같은 경로를 다시 push(애니메이션 깜빡임)하지 않게 한다.
    const currentFieldKeys = breadcrumbs.slice(boundaryIndex + 1).map((s) => s.label);
    livePushedRef.current = JSON.stringify(currentFieldKeys);
    setInputValue(currentFieldKeys.length > 0 ? `.${currentFieldKeys.join('.')}.` : '.');
    setIsEditing(true);
  };

  // . 키 = 경로 입력 시작(입력칸 밖, 모달이 없을 때, 문서가 열려 있을 때) — 설정 › Keyboard에도 있다
  const startEditingRef = useRef(startEditing);
  startEditingRef.current = startEditing;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '.' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!canEdit || isEditing) return;
      e.preventDefault();
      startEditingRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canEdit, isEditing]);

  const triggerShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 300);
  };

  // expandable key를 고르면(마우스 클릭이든 Enter든) dropdown은 유지한 채 입력값만 다음 depth로
  // 넘기고, 위쪽의 live-sync effect가 곧바로 해당 컬럼을 펼친다. leaf를 고르면 더 내려갈 곳이
  // 없으므로 편집을 끝낸다 — 그 직전(부모)까지는 이미 live-sync로 펼쳐져 있다.
  const acceptCandidate = (entry: { key: string; value: JsonValue }) => {
    const nextConfirmed = [...confirmed, entry.key];
    if (isExpandableType(getFieldType(entry.value))) {
      setInputValue(`.${nextConfirmed.join('.')}.`);
    } else {
      setInputValue(`.${nextConfirmed.join('.')}`);
      setIsEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsEditing(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (itemCount > 0) setHighlightIndex((i) => (i + 1) % itemCount);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (itemCount > 0) setHighlightIndex((i) => (i - 1 + itemCount) % itemCount);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (showBack && highlightIndex === backIndex) {
        goBack();
        return;
      }
      const picked = candidates[highlightIndex - candidateOffset];
      if (picked) {
        acceptCandidate(picked);
      } else if (query.trim() === '') {
        // 더 내려갈 게 없음 — 지금까지 live push된 상태 그대로 편집 종료
        setIsEditing(false);
      } else {
        // 입력한 키가 현재 깊이에 존재하지 않음
        triggerShake();
      }
    }
  };

  const handleBreadcrumbClick = (index: number) => {
    if (isEditing) setIsEditing(false);
    if (index !== breadcrumbs.length - 1) {
      onNavigate(index);
    }
  };

  const visibleBreadcrumbs = isEditing ? breadcrumbs.slice(0, boundaryIndex + 1) : breadcrumbs;

  return (
    <section ref={containerRef} className={styles.container} aria-label="Breadcrumbs">
      <div
        ref={trackRef}
        className={cn(styles.track, styles.trackScroll)}
        onClick={(e) => {
          if (!isEditing && e.target === e.currentTarget) startEditing();
        }}
      >
        {breadcrumbs.length === 0 ? (
          <span className={styles.empty}>Connect to a database to begin exploring.</span>
        ) : (
          <AnimatePresence mode="popLayout">
            {visibleBreadcrumbs.map((segment, index) => {
              const isLast = index === breadcrumbs.length - 1;
              const clickableLast = isLast && canEdit && !isEditing;
              const IconComponent = getIconForKind(segment.kind);
              const isReference = segment.chainColor !== undefined;
              const referenceStyle = isReference
                ? { color: segment.chainColor }
                : undefined;
              return (
                <motion.div
                  key={segment.key}
                  initial={{ x: 20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: -20, opacity: 0, scale: 0.95 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  className="inline-flex items-center gap-1"
                >
                  {index === 0 && segment.kind === 'database' ? (
                    // 첫 칸(DB) = DB 고르기 드롭다운
                    <BreadcrumbDatabaseMenu
                      label={segment.label}
                      isLast={isLast}
                      databases={databases}
                      activeDatabase={activeDatabase}
                      onSelectDatabase={(name) => {
                        if (isEditing) setIsEditing(false);
                        onSelectDatabase(name);
                      }}
                      onBackToRoot={() => handleBreadcrumbClick(0)}
                    />
                  ) : (
                  <button
                    type="button"
                    disabled={isLast && !clickableLast}
                    onClick={() => {
                      if (isLast) {
                        if (clickableLast) startEditing();
                        return;
                      }
                      handleBreadcrumbClick(index);
                    }}
                    className={cn(
                      styles.breadcrumbBase,
                      !isLast && styles.breadcrumbHover,
                      isLast && styles.breadcrumbActive,
                      isLast && (clickableLast ? 'cursor-pointer' : 'cursor-default'),
                    )}
                    style={referenceStyle}
                    aria-current={isLast ? 'page' : undefined}
                  >
                    {IconComponent && <IconComponent className={styles.icon} />}
                    <span className="max-w-40 truncate">{segment.label}</span>
                  </button>
                  )}
                  {segment.kind === 'collection' && queryText && (
                    <button
                      type="button"
                      className={styles.queryChip}
                      data-tt={`Query: ${queryText}`}
                      aria-label="Edit query"
                      onClick={() => openSearchPanel('query')}
                    >
                      {'{…}'}
                    </button>
                  )}
                  {(index < breadcrumbs.length - 1 || (isEditing && index === boundaryIndex)) && (
                    <ChevronRight className={styles.chevron} aria-hidden="true" strokeWidth={2.5} />
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}

        {isEditing && (
          <motion.div
            className={styles.pathInputWrap}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1, x: shake ? [0, -6, 6, -4, 4, 0] : 0 }}
            transition={{ duration: 0.15 }}
          >
            <input
              ref={inputRef}
              type="text"
              spellCheck={false}
              className={styles.pathInput}
              value={inputValue}
              onChange={(e) => {
                const next = e.target.value.startsWith('.') ? e.target.value : `.${e.target.value}`;
                setInputValue(next);
              }}
              onKeyDown={handleKeyDown}
            />
          </motion.div>
        )}
        {/* 남은 빈 공간 — 문서가 열려 있으면 올렸을 때 작은 점선 네모(.)가 나타나 '여기에 경로를 칠 수 있다'고 알린다.
            누르거나 . 키 = 필드 경로 입력(.likes.0). 입력 중에 누르면 닫는다 */}
        <div
          className={cn('group/path inline-flex flex-1 items-center self-stretch pl-1', canEdit && 'cursor-text')}
          onClick={() => (canEdit ? (isEditing ? setIsEditing(false) : startEditing()) : undefined)}
        >
          {canEdit && !isEditing && (
            <span
              className={styles.pathHint}
              aria-label="Type a field path"
              data-tt="Type a field path — or press ."
            >
              .
            </span>
          )}
        </div>
      </div>

      {isEditing && createPortal(
        // candidates 개수에 따라 조건부 마운트하면 depth가 바뀔 때마다(특히 마우스 클릭으로
        // expandable 요소를 고를 때) 패널 자체가 unmount→remount되며 깜빡여 보인다. isEditing에만
        // 마운트를 묶고, 빈 상태는 내부에서 별도로 표시해 패널이 편집 내내 유지되게 한다.
        <motion.div
          ref={dropdownRef}
          className={styles.dropdownPanel}
          style={{ top: dropdownPos.top, left: dropdownPos.left }}
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.1 }}
        >
          {showBack && (
            <>
              <div
                className={cn(styles.dropdownBack, backIndex === highlightIndex && styles.dropdownItemActive)}
                onMouseEnter={() => setHighlightIndex(backIndex)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  goBack();
                }}
              >
                <CornerUpLeft size={13} className="shrink-0 text-slate-400" />
                <span className="text-[13px] font-mono">.{confirmed.slice(0, -1).join('.')}</span>
              </div>
              <div className={styles.dropdownDivider} />
            </>
          )}
          {candidates.length > 0 ? (
            candidates.map((entry, index) => {
              const type = getFieldType(entry.value);
              const badge = TYPE_BADGE[type];
              const itemIndex = index + candidateOffset;
              return (
                <div
                  key={entry.key}
                  className={cn(styles.dropdownItem, itemIndex === highlightIndex && styles.dropdownItemActive)}
                  onMouseEnter={() => setHighlightIndex(itemIndex)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptCandidate(entry);
                  }}
                >
                  <span className={styles.dropdownKey}>{entry.key}</span>
                  {badge && (
                    <span className={cn(styles.typeBadge, badge.bg, badge.text)}>
                      <badge.icon size={11} className={badge.iconColor} />
                      {badge.label}
                    </span>
                  )}
                  {type === 'string' && (
                    <span className="text-[13px] font-serif text-emerald-400 shrink-0">{'“ ”'}</span>
                  )}
                  {type === 'number' && (
                    <Hash size={12} className="text-sky-400 shrink-0" />
                  )}
                  {type === 'boolean' && (
                    <ToggleLeft size={12} className="text-violet-400 shrink-0" />
                  )}
                  {type === 'null' && (
                    <Ban size={12} className="text-slate-300 shrink-0" />
                  )}
                  {type === 'object' && (
                    <span className={styles.countBadge}>{'{ '}{Object.keys(entry.value as Record<string, unknown>).length}{' }'}</span>
                  )}
                  {type === 'array' && (
                    <span className={styles.countBadge}>{'[ '}{(entry.value as JsonValue[]).length}{' ]'}</span>
                  )}
                  {isExpandableType(type) && (
                    <CornerDownLeft size={12} className={styles.enterHint} />
                  )}
                </div>
              );
            })
          ) : (
            <div className={styles.dropdownEmpty}>No matching keys</div>
          )}
        </motion.div>,
        document.body,
      )}
    </section>
  );
}
