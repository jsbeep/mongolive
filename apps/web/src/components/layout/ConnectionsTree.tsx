// 사이드바의 연결 트리 (MongoDB Compass 사이드바처럼) — 연결 › DB › 컬렉션.
//   CONNECTIONS (n)  [+ 새 연결]
//   ▾ [서버●] 지금 연결   ⟳ 다시 맞추기 · + 새 DB · ⋯(Edit / Disconnect)   ← 이 탭이 쓰는 연결만 펼쳐진다
//       ▸ DB …
//   ▸ [서버] 다른 연결     [Connect] · ⋯(Edit)                              ← 올리면 보인다. 더블클릭도 연결
// 지금 연결이 단독 DB(polling)면 연결 줄 아래에 안내 — 실시간 없음, 다시 받는 주기, R 키. × = 이번만, Don't show again = 이 연결에선 다시 안 보임
// 탭마다 연결은 하나 — 다른 연결을 Connect하면 이 탭이 그 연결로 바뀐다(먼저 접속해 본다, useConnect).
import { useState } from 'react';
import { ChevronRight, Info, Loader2, Pencil, Plus, RefreshCw, Server, Unplug, X } from 'lucide-react';
import { connectionLabel, type CollectionSummary, type ConnectionInfo, type DatabaseSummary, type MutationRequest } from '../../types/explorer';
import type { ConnectionsState } from '../../hooks/useConnections';
import type { ConnectAction } from '../connections/useConnect';
import type { UseExplorerStateResult } from '../../hooks/useExplorerState';
import { useServerSettings } from '../../services/serverSettings';
import { usePreferences } from '../../services/preferences';
import { connectionScoped, onConnectionSwitch } from '../../services/connectionStorage';
import { HeaderOverflowMenu, type HeaderMenuItem } from '../dashboard/columns/HeaderOverflowMenu';
import { colorClasses } from '../connections/connectionColors';
import { CONNECTION_STATUS } from './connectionStatus';
import { DatabaseTree } from './DatabaseTree';
import { cn } from '../../utils/cn';

export interface ConnectionsTreeProps {
  connections: ConnectionsState;
  connect: ConnectAction;
  // 이 탭이 쓰는 연결(없으면 웰컴 화면)
  currentId: string | null;
  status: UseExplorerStateResult['connectionStatus'];
  canManage: boolean;
  onNew: () => void;
  onEdit: (connection: ConnectionInfo) => void;
  onDisconnect: () => void;
  onRefresh: () => void;
}

interface TreeData {
  databases: DatabaseSummary[];
  activeDatabase: string | null;
  activeCollection: string | null;
  collections: CollectionSummary[];
  onSelectDatabase: (name: string) => Promise<void>;
  onOpenCollection: (database: string, name: string, label: string) => Promise<void>;
  onMutate: (op: MutationRequest) => Promise<unknown>;
}

const styles = {
  sectionHead: 'flex h-8 shrink-0 items-center gap-1 pl-2 pr-1',
  sectionTitle: 'flex-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400',
  count: 'ml-1 font-normal tabular-nums text-slate-400',
  iconBtn: 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-700',
  list: 'flex min-h-0 flex-1 flex-col overflow-y-auto pb-2',
  row: 'group flex h-8 w-full shrink-0 items-center gap-1.5 rounded-md pl-0.5 pr-1 text-left text-[13px] transition-colors',
  chevron: 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-700',
  label: 'min-w-0 flex-1 truncate',
  // 다른 연결의 버튼은 올리거나 행 안에 포커스가 있을 때만
  hoverOnly: 'hidden group-hover:inline-flex group-focus-within:inline-flex',
  connectBtn: 'h-6 shrink-0 items-center rounded-md border border-slate-200 bg-white px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600 transition-colors hover:border-emerald-300 hover:text-emerald-700',
  failure: 'mb-1 ml-[22px] mr-1 flex items-start gap-1 rounded-md bg-rose-50 py-1 pl-2 pr-1 text-[11px] leading-snug text-rose-700',
  notice: 'mb-1 ml-[22px] mr-1 rounded-md bg-sky-50 py-1.5 pl-2 pr-1 text-[11px] leading-snug text-sky-900 ring-1 ring-sky-100',
  noticeClose: 'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-sky-400 transition-colors hover:bg-sky-100 hover:text-sky-700',
  noticeKbd: 'rounded border border-sky-200 bg-white px-1 font-mono text-[10px] text-sky-700',
  failureClose: 'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-rose-400 transition-colors hover:bg-rose-100 hover:text-rose-700',
} as const;

// 상태 점 색 — tailwind가 CSS를 만들도록 클래스 이름을 그대로 적어 둔다
const STATUS_DOT: Record<UseExplorerStateResult['connectionStatus'], string> = {
  disconnected: 'bg-slate-300',
  connecting: 'bg-amber-500',
  connected: 'bg-emerald-500',
  polling: 'bg-sky-500',
  error: 'bg-rose-500',
};

// 단독 DB 안내를 '다시 보지 않기'로 끈 연결 — 연결마다 따로(8-5 연결별 저장소)
const standaloneNoticeHidden = connectionScoped('mongolive.standaloneNotice.hidden');
// ×로 닫았나 — 이 탭이 그 연결에 머무는 동안만(사이드바를 접었다 펴서 다시 그려져도, 상태가 잠깐 바뀌어도 닫힌 채로).
// 다른 연결로 갔다 오면 다시 보인다
let noticeClosed = false;
onConnectionSwitch(() => {
  noticeClosed = false;
});

// 지금 연결이 단독 DB일 때 연결 줄 아래 안내 — 연결이 바뀌면 페이지가 새로 만들어지므로(key) 처음 읽은 값이 그 연결의 것
function StandaloneNotice() {
  const prefs = usePreferences();
  const [hidden, setHidden] = useState(() => noticeClosed || standaloneNoticeHidden.read() === '1');
  if (hidden) return null;
  return (
    <div className={styles.notice} role="status">
      <div className="flex items-start gap-1.5">
        <Info size={12} className="mt-px shrink-0 text-sky-500" />
        <p className="min-w-0 flex-1">
          Not a replica set — no live updates.<br/> {prefs.standaloneRefresh === 'off' ? 'Auto-refresh is off.' : `Refreshes every ${prefs.standaloneRefresh}.`}<br/> Press{' '}
          <kbd className={styles.noticeKbd}>R</kbd> to refresh now.
        </p>
        <button
          type="button"
          className={styles.noticeClose}
          onClick={() => {
            noticeClosed = true;
            setHidden(true);
          }}
          aria-label="Close"
          data-tt="Close"
        >
          <X size={12} />
        </button>
      </div>
      <button
        type="button"
        className="ml-[18px] mt-1 font-medium text-sky-700 underline-offset-2 hover:underline"
        onClick={() => {
          standaloneNoticeHidden.write('1');
          setHidden(true);
        }}
      >
        Don&apos;t show again
      </button>
    </div>
  );
}

// 서버 아이콘 — 아이콘 색 = 연결 색, 오른쪽 아래 점 = 지금 연결의 상태(Compass처럼 초록 = 연결됨).
// 연결 색을 점으로 쓰지 않는다 — 초록 연결 색이 '연결됨'으로 읽히면 헷갈린다
function ServerIcon({ connection, status }: { connection: ConnectionInfo; status?: UseExplorerStateResult['connectionStatus'] }) {
  const tint = connection.color ? colorClasses(connection.color).dot : status ? 'text-slate-700' : 'text-slate-400';
  return (
    <span className="relative inline-flex shrink-0">
      <Server size={15} className={tint} />
      {status && (
        <span className={cn('absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-white', STATUS_DOT[status])} aria-label={CONNECTION_STATUS[status].label} />
      )}
    </span>
  );
}

export function ConnectionsTree({ connections, connect, currentId, status, canManage, onNew, onEdit, onDisconnect, onRefresh, ...tree }: ConnectionsTreeProps & TreeData) {
  const [expanded, setExpanded] = useState(true);
  const [addingDatabase, setAddingDatabase] = useState(false);
  const safety = useServerSettings();
  const list = connections.connections;

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2">
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>
          Connections
          {!connections.loading && <span className={styles.count}>({list.length})</span>}
        </span>
        {canManage && (
          <button type="button" className={styles.iconBtn} onClick={onNew} aria-label="New connection" data-tt="New connection">
            <Plus size={14} />
          </button>
        )}
      </div>

      <div className={styles.list} role="tree" aria-label="Connections">
        {connections.loading && (
          <p className="flex h-8 items-center gap-1.5 pl-2 text-xs text-slate-400">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </p>
        )}
        {connections.error && <p className="px-2 py-1 text-xs text-rose-600">Couldn&apos;t load connections — {connections.error}</p>}

        {list.map((c) => {
          const isCurrent = c.id === currentId;
          const pending = connect.pendingId === c.id;
          const failed = connect.failure?.id === c.id ? connect.failure.message : null;
          const label = connectionLabel(c);

          if (isCurrent) {
            const menu: HeaderMenuItem[] = [
              ...(canManage ? [{ icon: <Pencil size={13} />, label: 'Edit connection', onSelect: () => onEdit(c) }] : []),
              { icon: <Unplug size={13} />, label: 'Disconnect', onSelect: onDisconnect },
            ];
            return (
              <div key={c.id} role="treeitem" aria-expanded={expanded} aria-selected="true">
                <div className={cn(styles.row, 'font-semibold text-slate-900 hover:bg-slate-100')} onClick={() => setExpanded((v) => !v)}>
                  <span className={styles.chevron} aria-hidden="true">
                    <ChevronRight size={13} className={cn('transition-transform', expanded && 'rotate-90')} />
                  </span>
                  <ServerIcon connection={c} status={status} />
                  <span className={styles.label} data-tt={c.hosts.join(', ')}>{label}</span>
                  <span className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className={styles.iconBtn} onClick={onRefresh} aria-label="Re-sync what's on screen" data-tt="Re-sync what's on screen">
                      <RefreshCw size={13} />
                    </button>
                    {!safety.readOnly && (
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => {
                          setExpanded(true);
                          setAddingDatabase((v) => !v);
                        }}
                        aria-label="New database"
                        data-tt="New database"
                      >
                        <Plus size={14} />
                      </button>
                    )}
                    <HeaderOverflowMenu items={menu} buttonClassName={styles.iconBtn} />
                  </span>
                </div>
                {status === 'polling' && <StandaloneNotice />}
                {expanded && <DatabaseTree {...tree} adding={addingDatabase} onAddingChange={setAddingDatabase} />}
              </div>
            );
          }

          return (
            <div key={c.id} role="treeitem" aria-expanded={false}>
              <div
                className={cn(styles.row, 'cursor-default text-slate-600 hover:bg-slate-100')}
                onDoubleClick={() => !connect.pendingId && void connect.connect(c.id)}
                data-tt={`${c.hosts.join(', ')} — double-click or Connect to switch this tab`}
              >
                <span className={cn(styles.chevron, 'text-slate-300 hover:text-slate-300')} aria-hidden="true">
                  <ChevronRight size={13} />
                </span>
                <ServerIcon connection={c} />
                <span className={styles.label}>{label}</span>
                {pending ? (
                  <Loader2 size={13} className="mr-1 shrink-0 animate-spin text-slate-400" aria-label="Connecting" />
                ) : (
                  <span className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      className={cn(styles.connectBtn, styles.hoverOnly)}
                      disabled={!!connect.pendingId}
                      onClick={() => void connect.connect(c.id)}
                    >
                      Connect
                    </button>
                    {canManage && (
                      <span className={styles.hoverOnly}>
                        <HeaderOverflowMenu items={[{ icon: <Pencil size={13} />, label: 'Edit connection', onSelect: () => onEdit(c) }]} buttonClassName={styles.iconBtn} />
                      </span>
                    )}
                  </span>
                )}
              </div>
              {failed && (
                <div className={styles.failure} role="alert">
                  <span className="min-w-0 flex-1 break-words">{failed}</span>
                  <button type="button" className={styles.failureClose} onClick={connect.clearFailure} aria-label="Dismiss" data-tt="Dismiss">
                    <X size={12} />
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {!connections.loading && list.length === 0 && (
          <p className="px-2 py-2 text-xs text-slate-400">{canManage ? 'No connections yet — add one with +.' : 'No connections.'}</p>
        )}
      </div>
    </div>
  );
}
