// 사이드바 References 버튼으로 여는 패널 — 선언한 제목 키·PK·FK를 모든 DB에 걸쳐 한 목록으로(예전 설정 › References).
// 컬렉션 이름을 누르면 그 컬렉션으로 이동(패널은 닫힌다), ×는 그 선언만 지운다 — MongoLive 메타데이터 파일만 바뀌고
// 사용자 데이터는 그대로. 새로 선언하는 건 각 컬렉션 문서 목록 헤더의 References(🔗) 패널에서.
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ChevronRight, Database, Link, Loader2, X } from 'lucide-react';
import type { CollectionSummary, DatabaseSummary, MutationRequest } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { SidebarPopover } from '../layout/SidebarPopover';

interface ReferencesPanelProps {
  anchor: DOMRect;
  databases: DatabaseSummary[];
  onMutate: (op: MutationRequest) => Promise<unknown>;
  onOpenCollection: (database: string, collection: string, label: string) => void;
  onClose: () => void;
}

type DeclaredRow = { database: string; collection: CollectionSummary };

// _id는 기본 키라 보여 줄 필요가 없다 — 직접 다른 키로 정한 경우만
const customPk = (c: CollectionSummary) => (c.primaryKey && c.primaryKey !== '_id' ? c.primaryKey : undefined);

const chip = 'inline-flex max-w-full items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700';
const removeBtn = 'shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700';

export function ReferencesPanel({ anchor, databases, onMutate, onOpenCollection, onClose }: ReferencesPanelProps) {
  const [rows, setRows] = useState<DeclaredRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 접어 둔 DB — 기본은 다 펼침
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const all = await Promise.all(databases.map((d) => api.getCollections(d.name).then((cols) => cols.map((c) => ({ database: d.name, collection: c })))));
      setRows(all.flat().filter(({ collection: c }) => c.titleKey || customPk(c) || Object.keys(c.referenceFields ?? {}).length > 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load collections');
    }
  }, [databases]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (op: MutationRequest) => {
    try {
      await onMutate(op);
    } finally {
      void load();
    }
  };

  const toggle = (db: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(db)) next.delete(db);
      else next.add(db);
      return next;
    });

  // DB별로 — 순서는 사이드바 트리와 같게
  const byDb = (rows ?? []).reduce<Map<string, CollectionSummary[]>>((map, r) => map.set(r.database, [...(map.get(r.database) ?? []), r.collection]), new Map());

  return (
    <SidebarPopover anchor={anchor} title="References" icon={<Link size={14} />} width={360} onClose={onClose}>
      {error && <p className="m-1.5 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
      {rows === null ? (
        !error && <p className="flex items-center gap-2 px-3 py-4 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs leading-5 text-slate-400">
          Nothing declared yet.
          <br />
          Use <Link size={11} className="inline align-[-1px]" aria-label="link icon" /> in a collection’s document list header.
        </p>
      ) : (
        <div className="flex flex-col">
          {[...byDb.entries()].map(([database, cols]) => {
            const isOpen = !collapsed.has(database);
            return (
              <section key={database}>
                {/* 스크롤해도 DB 이름이 위에 붙어 있다(-top-1.5: 스크롤 영역의 위 여백만큼 끌어올려 틈 없이) */}
                <button
                  type="button"
                  className="sticky -top-1.5 z-10 flex w-full items-center gap-2 bg-white px-2 py-1.5 text-left"
                  onClick={() => toggle(database)}
                  aria-expanded={isOpen}
                >
                  <ChevronRight size={13} className={cn('shrink-0 text-slate-400 transition-transform', isOpen && 'rotate-90')} />
                  <Database size={13} className="shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-slate-800">{database}</span>
                  <span className="shrink-0 text-[11px] text-slate-400">{cols.length}</span>
                </button>
                {isOpen && (
                  <div className="flex flex-col gap-1.5 pb-2 pl-4 pr-1">
                    {cols.map((c) => {
                      const fks = Object.entries(c.referenceFields ?? {});
                      const pk = customPk(c);
                      const base = { database, collection: c.name };
                      return (
                        <div key={c.name} className="rounded-xl border border-slate-100 px-3 py-2">
                          {/* 컬렉션 이름과 제목 키(·PK)를 한 줄에 — 참조(FK)만 아래로 */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              className="mr-0.5 max-w-full truncate font-mono text-xs font-semibold text-slate-700 hover:text-emerald-700 hover:underline"
                              onClick={() => onOpenCollection(database, c.name, c.label || c.name)}
                              data-tt="Open this collection"
                            >
                              {c.name}
                            </button>
                            {c.titleKey && (
                              <span className={chip}>
                                <span className="truncate">title: {c.titleKey}</span>
                                <button type="button" className={removeBtn} aria-label="Remove title key" onClick={() => void run({ type: 'setCollectionTitleKey', ...base, titleKey: '' })}><X size={11} /></button>
                              </span>
                            )}
                            {pk && (
                              <span className={chip}>
                                <span className="truncate">key: {pk}</span>
                                <button type="button" className={removeBtn} aria-label="Remove primary key" onClick={() => void run({ type: 'setCollectionPrimaryKey', ...base, primaryKey: '' })}><X size={11} /></button>
                              </span>
                            )}
                          </div>
                          {fks.length > 0 && (
                            <ul className="mt-1.5 flex flex-col gap-1">
                              {fks.map(([field, ref]) => (
                                <li key={field} className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-slate-700">
                                  <span className="truncate">{field}</span>
                                  <ArrowRight size={11} className="shrink-0 text-slate-400" />
                                  <span className="min-w-0 flex-1 truncate text-cyan-700">{ref.targetCollection}.{ref.targetKey}</span>
                                  <button type="button" className={removeBtn} aria-label={`Remove reference ${field}`} data-tt="Remove this reference" onClick={() => void run({ type: 'setCollectionReferenceField', ...base, field })}><X size={11} /></button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
          <p className="px-2 pb-1 pt-2 text-[11px] leading-4 text-slate-400">
            Removing one only changes MongoLive’s own metadata, never your data. ObjectId references are found automatically and aren’t listed.
          </p>
        </div>
      )}
    </SidebarPopover>
  );
}
