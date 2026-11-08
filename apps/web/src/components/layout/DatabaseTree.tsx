// 사이드바의 DB/컬렉션 트리 (MongoDB Compass 사이드바 모양).
// 밀러 컬럼의 컬렉션 컬럼과 '둘 다' 있다: 트리 = 다른 DB의 컬렉션으로 바로 뛰기, 컬럼 = 지금 DB 안에서 파고들기.
// 선택은 양쪽에 같이 보인다(지금 DB·컬렉션 강조).
//
// 컬렉션 목록: 지금 DB는 explorer 상태(collections)를 그대로 쓴다 — 실시간 반영이 이미 그걸 고친다.
//              다른 DB는 펼칠 때 받아 오고, DB 목록이 바뀌면(문서 수 등) 펼친 것만 다시 받는다.
// DB 관리(예전 헤더 드롭다운): 제목 옆 + = 추가, 행에 올리면 휴지통 = 삭제. 이름 변경/복제는 MongoDB에 명령이 없어 없음.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, Database, Folder, FolderOpen, Loader2, Lock, Plus, Trash2, X } from 'lucide-react';
import type { CollectionSummary, DatabaseSummary, MutationRequest } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { DeleteConfirmModal } from '../common/DeleteConfirmModal';
import { canEditIn, useServerSettings } from '../../services/serverSettings';
import { isProtected } from '../../types/explorer';

interface DatabaseTreeProps {
  databases: DatabaseSummary[];
  activeDatabase: string | null;
  activeCollection: string | null;
  // 지금 DB의 컬렉션
  collections: CollectionSummary[];
  onSelectDatabase: (name: string) => Promise<void>;
  onOpenCollection: (database: string, name: string, label: string) => Promise<void>;
  onMutate: (op: MutationRequest) => Promise<unknown>;
}

type Loaded = CollectionSummary[] | 'loading' | 'error';

const styles = {
  sectionHead: 'flex h-8 shrink-0 items-center gap-1 pl-2 pr-1',
  sectionTitle: 'flex-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400',
  iconBtn: 'inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700',
  list: 'flex min-h-0 flex-1 flex-col overflow-y-auto pb-2',
  // 행: 선택/미선택 배경은 둘 중 하나만(cn은 겹침을 정리해 주지 않는다)
  row: 'group flex h-7 w-full shrink-0 items-center gap-1.5 rounded-md pr-1 text-left text-[13px] transition-colors',
  rowIdle: 'text-slate-600 hover:bg-slate-100',
  rowActiveDb: 'font-semibold text-slate-900 hover:bg-slate-100',
  rowActiveCol: 'bg-selected font-medium text-emerald-700',
  chevronBtn: 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-700',
  label: 'min-w-0 flex-1 truncate',
  count: 'shrink-0 font-mono text-[11px] tabular-nums text-slate-400',
  // 숫자 자리에 겹쳐 나온다(올리거나 행 안에 포커스가 있을 때) — 안 보일 때 자리를 차지하면 숫자 세로줄이 어긋난다
  rowAction: 'hidden h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 group-hover:inline-flex group-focus-within:inline-flex',
  countHideOnHover: 'group-hover:hidden group-focus-within:hidden',
  // 컬렉션 행과 같은 들여쓰기 + 아이콘 자리
  note: 'flex h-7 items-center gap-1.5 pl-[64px] text-xs text-slate-400',
  addRow: 'flex h-8 shrink-0 items-center gap-1 px-1',
  addInput:
    'min-w-0 flex-1 rounded-md bg-slate-100/80 px-2 py-1 text-[13px] text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400/60',
  addConfirm: 'inline-flex h-6 w-6 items-center justify-center rounded-md text-emerald-600 hover:bg-emerald-50 disabled:opacity-40',
  empty: 'px-2 py-3 text-xs text-slate-400',
} as const;

export function DatabaseTree({ databases, activeDatabase, activeCollection, collections, onSelectDatabase, onOpenCollection, onMutate }: DatabaseTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeDatabase ? [activeDatabase] : []));
  const [others, setOthers] = useState<Record<string, Loaded>>({});
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DatabaseSummary | null>(null);
  // 안전장치(설정 창 › Safety): read-only면 추가를, 막힌 DB는 삭제를 숨기고 보호 대상엔 자물쇠
  const safety = useServerSettings();

  // 지금 DB는 늘 펼쳐 둔다(컬럼에서 DB를 바꿔도 트리가 따라온다)
  useEffect(() => {
    if (activeDatabase) setExpanded((prev) => (prev.has(activeDatabase) ? prev : new Set(prev).add(activeDatabase)));
  }, [activeDatabase]);

  const fetchOther = (name: string, quiet = false) => {
    if (!quiet) setOthers((prev) => ({ ...prev, [name]: 'loading' }));
    api.getCollections(name).then(
      (cols) => setOthers((prev) => ({ ...prev, [name]: cols })),
      () => setOthers((prev) => ({ ...prev, [name]: 'error' })),
    );
  };

  // 지금 DB에서 빠지는 순간, 그 DB의 컬렉션 목록(방금까지 화면에 있던 것)을 캐시로 옮긴다.
  // 이게 없으면 지금 DB는 캐시에 한 번도 담긴 적이 없어서, 다른 DB로 옮기면 펼쳐 둔 채 'Loading…'에서 멈춘다.
  // '직전 렌더'의 (DB, 목록) 짝을 쓴다 — DB를 바꾸는 경로에 따라 목록이 DB보다 늦게 바뀌기도(focusDatabase),
  // 같이 바뀌기도(selectDatabase) 해서, 바뀐 뒤의 collections는 옛 DB 것이 아닐 수 있다.
  const lastActiveRef = useRef({ db: activeDatabase, cols: collections });
  useEffect(() => {
    const last = lastActiveRef.current;
    if (last.db && last.db !== activeDatabase) {
      const leaving = last.db;
      setOthers((prev) => ({ ...prev, [leaving]: last.cols }));
    }
    lastActiveRef.current = { db: activeDatabase, cols: collections };
  }, [activeDatabase, collections]);

  // DB 목록이 새로 오면(문서 수·컬렉션 수 변화) 펼쳐 둔 다른 DB만 조용히 다시 받는다
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    for (const name of expandedRef.current) {
      if (name !== activeDatabase && databases.some((d) => d.name === name)) fetchOther(name, true);
    }
  }, [databases]);

  const toggle = (name: string) => {
    const opening = !expanded.has(name);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(name);
      else next.delete(name);
      return next;
    });
    // 펼칠 때마다 새로 받는다 — 전에 받은 게 있으면 그걸 보여 주면서 조용히
    if (opening && name !== activeDatabase) fetchOther(name, others[name] !== undefined && others[name] !== 'error');
  };

  const handleDbClick = (db: DatabaseSummary) => {
    if (db.name === activeDatabase) {
      toggle(db.name);
      return;
    }
    setExpanded((prev) => new Set(prev).add(db.name));
    void onSelectDatabase(db.name);
  };

  const confirmAdd = async () => {
    const name = newName.trim();
    if (!name || pending) return;
    setPending(true);
    try {
      await onMutate({ type: 'createDatabase', database: { name, label: name, description: '' } });
      setAdding(false);
      setNewName('');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2">
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>Databases</span>
        {!safety.readOnly && (
          <button type="button" className={styles.iconBtn} onClick={() => setAdding((v) => !v)} aria-label="New database" data-tt="New database">
            <Plus size={14} />
          </button>
        )}
      </div>

      {adding && !safety.readOnly && (
        <div className={styles.addRow}>
          <input
            autoFocus
            type="text"
            placeholder="my-database"
            className={styles.addInput}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmAdd();
              if (e.key === 'Escape') setAdding(false);
            }}
          />
          <button type="button" className={styles.addConfirm} onClick={() => void confirmAdd()} disabled={!newName.trim() || pending} aria-label="Create database">
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          </button>
          <button type="button" className={styles.iconBtn} onClick={() => setAdding(false)} aria-label="Cancel">
            <X size={14} />
          </button>
        </div>
      )}

      <div className={styles.list} role="tree" aria-label="Databases">
        {databases.length === 0 && <p className={styles.empty}>No databases yet.</p>}
        {databases.map((db) => {
          const isActive = db.name === activeDatabase;
          const isOpen = expanded.has(db.name);
          const loaded: Loaded | undefined = isActive ? collections : others[db.name];
          return (
            <div key={db.name} role="treeitem" aria-expanded={isOpen} aria-selected={isActive}>
              <div
                role="button"
                tabIndex={0}
                className={cn(styles.row, 'pl-0.5', isActive ? styles.rowActiveDb : styles.rowIdle)}
                onClick={() => handleDbClick(db)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleDbClick(db);
                  }
                }}
                data-tt={db.description || `${db.collectionCount} collections · ${db.documentCount} docs`}
              >
                <span
                  className={styles.chevronBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(db.name);
                  }}
                  aria-hidden="true"
                >
                  <ChevronRight size={13} className={cn('transition-transform', isOpen && 'rotate-90')} />
                </span>
                <Database size={14} className={cn('shrink-0', isActive ? 'text-emerald-600' : 'text-slate-400')} />
                <span className={styles.label}>{db.label}</span>
                {isProtected(safety, db.name) && <Lock size={11} className="shrink-0 text-amber-500" aria-label="Protected" data-tt="Protected — editing is blocked (Settings › Safety)" />}
                {canEditIn(safety, db.name) ? (
                  <>
                    <span className={cn(styles.count, styles.countHideOnHover)}>{db.collectionCount}</span>
                    <button
                      type="button"
                      className={styles.rowAction}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(db);
                      }}
                      aria-label={`Delete ${db.label}`}
                      data-tt="Delete database"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                ) : (
                  <span className={styles.count}>{db.collectionCount}</span>
                )}
              </div>

              {isOpen && (
                <div role="group">
                  {loaded === 'loading' || loaded === undefined ? (
                    <p className={styles.note}><Loader2 size={12} className="animate-spin" /> Loading…</p>
                  ) : loaded === 'error' ? (
                    <p className={styles.note}>Couldn't load collections</p>
                  ) : loaded.length === 0 ? (
                    <p className={styles.note}>No collections</p>
                  ) : (
                    loaded.map((col) => {
                      const isActiveCol = isActive && col.name === activeCollection;
                      const Icon = isActiveCol ? FolderOpen : Folder;
                      return (
                        <button
                          key={col.name}
                          type="button"
                          role="treeitem"
                          aria-selected={isActiveCol}
                          // 폴더 아이콘이 DB 이름 글자 아래에 오도록(DB 아이콘과 같은 세로줄이면 DB인지 컬렉션인지 헷갈린다)
                          className={cn(styles.row, 'pl-[44px]', isActiveCol ? styles.rowActiveCol : styles.rowIdle)}
                          onClick={() => void onOpenCollection(db.name, col.name, col.label || col.name)}
                          data-tt={col.description || undefined}
                        >
                          <Icon size={14} className={cn('shrink-0', isActiveCol ? 'text-emerald-600' : 'text-slate-400')} />
                          <span className={styles.label}>{col.label || col.name}</span>
                          {isProtected(safety, db.name, col.name) && !isProtected(safety, db.name) && (
                            <Lock size={11} className="shrink-0 text-amber-500" aria-label="Protected" data-tt="Protected — editing is blocked (Settings › Safety)" />
                          )}
                          <span className={styles.count}>{col.documentCount}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {deleteTarget && createPortal(
        <DeleteConfirmModal
          isOpen={!!deleteTarget}
          targetType="database"
          targetLabel={deleteTarget.label}
          confirmText={deleteTarget.name}
          onConfirm={async () => {
            await onMutate({ type: 'deleteDatabase', database: deleteTarget.name });
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />,
        document.body,
      )}
    </div>
  );
}
