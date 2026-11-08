// Ctrl+K(⌘K) 빠른 이동 — 어디서든 열어서 이름 몇 글자로 DB·컬렉션으로 뛰거나, ObjectId를 붙여 넣어 그 문서로 간다.
// 몇 가지 명령(설정 열기, 다시 맞추기 등)도 같은 목록에서 고른다.
//   ↑↓ 고르기 · Enter 열기 · Esc 닫기
// 컬렉션 목록은 열 때 모든 DB에서 한 번 받는다(열려 있는 동안만 쓰고 버린다).
// 순위: 완전 일치 > 앞부분 > 단어(. - _ 공백 뒤) 앞부분 > 포함 > 단어 첫 글자·이어진 글자로 순서대로(sfj → sample-forum-json)
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'framer-motion';
import { CornerDownLeft, Database, FileText, Folder, Loader2, Search, type LucideIcon } from 'lucide-react';
import type { CollectionSummary, DatabaseSummary, ReferenceInfo } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';

export interface QuickCommand {
  id: string;
  label: string;
  icon: LucideIcon;
  // 오른쪽에 보일 단축키 등
  hint?: string;
  run: () => void;
}

interface QuickJumpProps {
  open: boolean;
  onClose: () => void;
  databases: DatabaseSummary[];
  activeDatabase: string | null;
  commands: QuickCommand[];
  onOpenDatabase: (name: string) => void;
  onOpenCollection: (database: string, collection: string, label: string) => void;
  onOpenObjectId: (oid: string) => void;
}

type Item =
  | { kind: 'oid'; key: string; oid: string }
  | { kind: 'database'; key: string; db: DatabaseSummary }
  | { kind: 'collection'; key: string; database: string; col: CollectionSummary }
  | { kind: 'command'; key: string; cmd: QuickCommand };

const MAX_RESULTS = 40;

// ObjectId("…") / "…" / … 어느 모양으로 붙여 넣어도 24자리 hex를 꺼낸다
const extractOid = (text: string): string | null => {
  const m = /^\s*(?:ObjectId\(\s*)?["']?([0-9a-f]{24})["']?\s*\)?\s*$/i.exec(text);
  return m ? m[1].toLowerCase() : null;
};

const isWordStart = (t: string, j: number) => j === 0 || /[.\-_\s]/.test(t[j - 1]);

// 글자가 순서대로 들어 있되, 각 글자가 '바로 앞 글자에 붙어 있거나' '단어의 첫 글자'일 때만 맞는다
// (편집기 빠른 열기와 같은 규칙). sfj → Sample-Forum-Json, samfor → SAMple-FORum 은 맞고,
// stor → "Switch TO tRee"는 r이 붙어 있지도 단어 첫 글자도 아니라서 안 맞는다.
// 되짚어 찾되, 실패한 (몇 번째 글자, 직전 위치)는 기억해 다시 보지 않는다 — 'aaaa' 같은 입력에서도 가볍게
const fuzzy = (q: string, t: string): boolean => {
  const failed = new Set<number>();
  const walk = (qi: number, prev: number): boolean => {
    if (qi === q.length) return true;
    const state = qi * (t.length + 2) + prev + 1;
    if (failed.has(state)) return false;
    for (let j = prev + 1; j < t.length; j += 1) {
      if (t[j] === q[qi] && (j === prev + 1 || isWordStart(t, j)) && walk(qi + 1, j)) return true;
    }
    failed.add(state);
    return false;
  };
  return walk(0, -1);
};

// 낮을수록 위. null = 맞지 않음
const score = (query: string, text: string): number | null => {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.split(/[.\-_\s]/).some((part) => part.startsWith(q))) return 2;
  if (t.includes(q)) return 3;
  return fuzzy(q, t) ? 4 : null;
};

const best = (query: string, ...texts: string[]): number | null => {
  const scores = texts.map((t) => score(query, t)).filter((s): s is number => s !== null);
  return scores.length ? Math.min(...scores) : null;
};

const styles = {
  backdrop: 'fixed inset-0 z-[1000] flex justify-center bg-slate-900/20 px-4 pt-[12vh] backdrop-blur-[2px]',
  panel: 'flex h-fit max-h-[70vh] w-[min(600px,100%)] flex-col overflow-hidden rounded-2xl bg-white shadow-elevated ring-1 ring-slate-200/70',
  inputRow: 'flex h-14 shrink-0 items-center gap-3 border-b border-slate-100 px-4',
  input: 'min-w-0 flex-1 bg-transparent text-[15px] text-slate-800 placeholder:text-slate-400 focus:outline-none',
  list: 'min-h-0 flex-1 overflow-y-auto p-2',
  section: 'px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400',
  // 고른 줄/아닌 줄 배경은 둘 중 하나만(cn은 겹침을 정리해 주지 않는다)
  row: 'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px]',
  rowIdle: 'text-slate-700',
  rowOn: 'bg-emerald-50 text-slate-900',
  meta: 'ml-auto shrink-0 pl-3 font-mono text-[11px] text-slate-400',
  empty: 'px-3 py-8 text-center text-xs text-slate-400',
  foot: 'flex shrink-0 items-center gap-3 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400',
  kbd: 'rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[10px] text-slate-500',
} as const;

export function QuickJump({ open, onClose, databases, activeDatabase, commands, onOpenDatabase, onOpenCollection, onOpenObjectId }: QuickJumpProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [collections, setCollections] = useState<{ database: string; col: CollectionSummary }[] | null>(null);
  const [oidInfo, setOidInfo] = useState<{ oid: string; info: ReferenceInfo | null; loading: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 열 때마다 비우고 모든 DB의 컬렉션을 받는다
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    setCollections(null);
    let cancelled = false;
    Promise.all(databases.map((d) => api.getCollections(d.name).then((cols) => cols.map((col) => ({ database: d.name, col })), () => [])))
      .then((all) => {
        if (!cancelled) setCollections(all.flat());
      });
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelled = true;
    };
  }, [open, databases]);

  // ObjectId를 넣으면 어느 문서인지 미리 찾아 둔다(잠깐 멈췄을 때)
  const oid = extractOid(query);
  useEffect(() => {
    if (!oid) {
      setOidInfo(null);
      return;
    }
    setOidInfo({ oid, info: null, loading: true });
    const timer = setTimeout(() => {
      api.getReferenceInfo(oid).then(
        (info) => setOidInfo((cur) => (cur?.oid === oid ? { oid, info, loading: false } : cur)),
        () => setOidInfo((cur) => (cur?.oid === oid ? { oid, info: null, loading: false } : cur)),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [oid]);

  const items = useMemo((): Item[] => {
    const q = query.trim();
    const cols = collections ?? [];
    if (oid) return [{ kind: 'oid', key: `oid:${oid}`, oid }];
    if (!q) {
      // 비어 있으면: 지금 DB의 컬렉션 → 다른 DB → 명령
      const here = cols.filter((c) => c.database === activeDatabase);
      return [
        ...here.map((c): Item => ({ kind: 'collection', key: `c:${c.database}.${c.col.name}`, database: c.database, col: c.col })),
        ...databases.filter((d) => d.name !== activeDatabase).map((db): Item => ({ kind: 'database', key: `d:${db.name}`, db })),
        ...commands.map((cmd): Item => ({ kind: 'command', key: `cmd:${cmd.id}`, cmd })),
      ].slice(0, MAX_RESULTS);
    }
    const scored: { item: Item; s: number; tie: number }[] = [];
    for (const c of cols) {
      const s = best(q, `${c.database}.${c.col.name}`, c.col.name, c.col.label);
      // 같은 점수면 지금 DB의 컬렉션을 먼저
      if (s !== null) scored.push({ item: { kind: 'collection', key: `c:${c.database}.${c.col.name}`, database: c.database, col: c.col }, s, tie: c.database === activeDatabase ? 0 : 1 });
    }
    for (const db of databases) {
      const s = best(q, db.name, db.label);
      if (s !== null) scored.push({ item: { kind: 'database', key: `d:${db.name}`, db }, s, tie: 2 });
    }
    for (const cmd of commands) {
      const s = best(q, cmd.label);
      if (s !== null) scored.push({ item: { kind: 'command', key: `cmd:${cmd.id}`, cmd }, s, tie: 3 });
    }
    return scored.sort((a, b) => a.s - b.s || a.tie - b.tie).slice(0, MAX_RESULTS).map((x) => x.item);
  }, [query, oid, collections, databases, activeDatabase, commands]);

  useEffect(() => setIndex(0), [query]);
  // 고른 줄이 보이게 스크롤
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === 'oid') onOpenObjectId(item.oid);
    else if (item.kind === 'database') onOpenDatabase(item.db.name);
    else if (item.kind === 'collection') onOpenCollection(item.database, item.col.name, item.col.label || item.col.name);
    else item.cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) setIndex((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setIndex((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!(items[index]?.kind === 'oid' && oidInfo?.loading === false && !oidInfo.info)) choose(items[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const renderRow = (item: Item, i: number): ReactNode => {
    const on = i === index;
    let icon: LucideIcon;
    let main: ReactNode;
    let meta: ReactNode = null;
    if (item.kind === 'oid') {
      icon = FileText;
      main = oidInfo?.loading || !oidInfo ? (
        <span className="flex items-center gap-2 text-slate-500"><Loader2 size={13} className="animate-spin" /> Looking up ObjectId…</span>
      ) : oidInfo.info ? (
        <span>
          <span className="text-slate-400">{oidInfo.info.databaseName}.{oidInfo.info.collectionName} / </span>
          <span className="font-semibold">{oidInfo.info.documentTitle}</span>
        </span>
      ) : (
        <span className="text-slate-500">No document with this ObjectId</span>
      );
      meta = item.oid;
    } else if (item.kind === 'database') {
      icon = Database;
      main = <span className="font-medium">{item.db.label !== item.db.name ? `${item.db.label}` : item.db.name}</span>;
      meta = item.db.label !== item.db.name ? item.db.name : `${item.db.collectionCount} collections`;
    } else if (item.kind === 'collection') {
      icon = Folder;
      main = (
        <span>
          <span className="text-slate-400">{item.database}.</span>
          <span className="font-semibold">{item.col.name}</span>
        </span>
      );
      meta = `${item.col.documentCount} docs`;
    } else {
      icon = item.cmd.icon;
      main = item.cmd.label;
      meta = item.cmd.hint ?? null;
    }
    const Icon = icon;
    return (
      <button
        key={item.key}
        type="button"
        data-index={i}
        role="option"
        aria-selected={on}
        className={cn(styles.row, on ? styles.rowOn : styles.rowIdle)}
        onMouseMove={() => setIndex(i)}
        onClick={() => choose(item)}
      >
        <Icon size={15} className={cn('shrink-0', on ? 'text-emerald-600' : 'text-slate-400')} />
        <span className="min-w-0 truncate">{main}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
        {on && <CornerDownLeft size={12} className="shrink-0 text-slate-400" />}
      </button>
    );
  };

  // 섹션 제목은 종류가 바뀌는 곳에만(입력이 비었을 때의 기본 목록에서 특히 읽기 쉽게)
  const sectionOf = (item: Item) =>
    item.kind === 'collection' ? 'Collections' : item.kind === 'database' ? 'Databases' : item.kind === 'command' ? 'Commands' : 'Document';

  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.1 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <m.div
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-label="Quick jump"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 520, damping: 38 }}
          >
            <div className={styles.inputRow}>
              <Search size={17} className="shrink-0 text-slate-400" />
              <input
                ref={inputRef}
                className={styles.input}
                placeholder="Jump to a database or collection, paste an ObjectId, or run a command…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                spellCheck={false}
                role="combobox"
                aria-expanded="true"
                aria-controls="quick-jump-list"
              />
              {collections === null && <Loader2 size={15} className="shrink-0 animate-spin text-slate-300" aria-label="Loading collections" />}
            </div>
            <div ref={listRef} id="quick-jump-list" className={styles.list} role="listbox">
              {items.length === 0 ? (
                <p className={styles.empty}>{collections === null ? 'Loading…' : 'Nothing matches'}</p>
              ) : (
                items.map((item, i) => (
                  <div key={item.key}>
                    {(i === 0 || sectionOf(items[i - 1]) !== sectionOf(item)) && <p className={styles.section}>{sectionOf(item)}</p>}
                    {renderRow(item, i)}
                  </div>
                ))
              )}
            </div>
            <div className={styles.foot}>
              <span><kbd className={styles.kbd}>↑</kbd> <kbd className={styles.kbd}>↓</kbd> move</span>
              <span><kbd className={styles.kbd}>↵</kbd> open</span>
              <span><kbd className={styles.kbd}>esc</kbd> close</span>
              <span className="ml-auto">Tip: paste an ObjectId to jump straight to its document</span>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
