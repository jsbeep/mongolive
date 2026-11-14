// 웰컴 화면 — 이 탭에서 아직 연결을 고르지 않았을 때 컬럼 자리에 뜬다(VSCode의 '아무 파일도 안 연' 화면처럼).
//   가운데: 큰 ML 마크 · 연결 카드(즐겨찾기 먼저, 누르면 접속해 보고 들어간다) · + 새 연결
//   카드:   연 적 있으면 [시계] 2m ago, 1–9 = 카드 순서로 바로, Enter = 마지막에 쓴 연결
//   아래:   단축키 안내
// 연결이 지워져 여기로 돌아왔으면 그 이유를 위에 한 번 보여 준다.
import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AlertTriangle, Clock, Loader2, Pencil, Plus, Server, Star, X } from 'lucide-react';
import { connectionLabel, type ConnectionInfo } from '../../types/explorer';
import { dismissConnectionNotice, useConnectionNotice, useRecentConnections } from '../../services/activeConnection';
import type { ConnectionsState } from '../../hooks/useConnections';
import { timeAgo } from '../../utils/timeAgo';
import { cn } from '../../utils/cn';
import { colorClasses } from './connectionColors';
import type { ConnectAction } from './useConnect';

interface WelcomeScreenProps {
  connections: ConnectionsState;
  connect: ConnectAction;
  // 연결을 추가·수정할 수 있는가(Mock 데모는 못 한다)
  canManage: boolean;
  onNewConnection: () => void;
  onEditConnection: (connection: ConnectionInfo) => void;
  onOpenQuickJump: () => void;
  onOpenShortcuts: () => void;
}

const MOD = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

const styles = {
  screen: 'relative h-full overflow-y-auto',
  inner: 'relative mx-auto flex min-h-full w-full max-w-4xl flex-col px-6 py-10 sm:px-10',
  // 큰 마크 — 뒤에 옅은 동심원을 깔아 VSCode 빈 화면의 큰 로고 느낌
  markWrap: 'relative mb-6 mt-4 flex h-28 w-20 items-center justify-center',
  markRing: 'absolute rounded-full border border-emerald-200/60',
  mark: 'relative flex h-20 w-20 items-center justify-center rounded-[26px] border border-emerald-200 bg-emerald-50 text-3xl font-bold tracking-tight text-emerald-700 shadow-soft',
  title: 'relative text-center text-xl font-semibold tracking-tight text-slate-900',
  subtitle: 'relative mt-1 text-center text-sm text-slate-500',
  notice: 'mt-6 flex w-full items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-800 ring-1 ring-amber-200/70',
  section: 'mt-9 w-full',
  sectionHead: 'mb-3 flex items-center gap-2',
  sectionTitle: 'text-[11px] font-semibold uppercase tracking-wider text-slate-400',
  count: 'rounded-full bg-slate-100 px-1.5 text-[11px] font-medium tabular-nums text-slate-500',
  grid: 'grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3',
  // 연결 카드 — 왼쪽 색 띠, 올리면 살짝 뜬다
  // 올리면 배경색만 바뀐다(떠오르는 효과 없음)
  card: 'group relative flex min-h-[92px] cursor-pointer flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white py-3 pl-4 pr-3 text-left shadow-soft transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40',
  cardBar: 'absolute inset-y-0 left-0 w-1',
  cardTop: 'flex items-center gap-1.5 pr-6',
  cardName: 'min-w-0 truncate text-sm font-semibold text-slate-800',
  cardHost: 'mt-1 truncate font-mono text-[12px] text-slate-500',
  cardBadges: 'mt-auto flex flex-wrap items-center gap-1 pt-2',
  badge: 'rounded px-1.5 py-px text-[10px] font-medium ring-1 ring-slate-200 text-slate-500',
  editBtn: 'absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 opacity-0 transition hover:bg-slate-200/70 hover:text-slate-700 focus-visible:opacity-100 group-hover:opacity-100',
  // 카드 번호(1–9 단축키) — 올리면 편집 버튼에 자리를 내준다
  cardKey: 'absolute right-3 top-3 transition-opacity group-hover:opacity-0',
  lastUsed: 'ml-auto flex shrink-0 items-center gap-1 text-[11px] text-slate-400',
  pending: 'absolute inset-0 flex items-center justify-center gap-2 bg-white/80 text-[13px] font-medium text-slate-600 backdrop-blur-[1px]',
  // + 새 연결 카드 — 점선
  newCard: 'flex min-h-[92px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 text-[13px] font-medium text-slate-500 transition-colors hover:border-emerald-300 hover:bg-emerald-50/60 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-slate-300 disabled:hover:bg-transparent disabled:hover:text-slate-500',
  failure: 'mt-3 flex items-start gap-2 rounded-xl bg-rose-50 py-2.5 pl-3.5 pr-2.5 text-[13px] text-rose-700 ring-1 ring-rose-200/70',
  failureClose: 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-rose-400 transition-colors hover:bg-rose-100 hover:text-rose-700',
  linkBtn: 'font-medium underline underline-offset-2 hover:text-rose-900',
  bottom: 'mt-9 w-full md:w-1/2',
  list: 'flex flex-col',
  row: 'flex h-9 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900',
  kbd: 'inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 font-mono text-[11px] text-slate-500',
  empty: 'rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-[13px] text-slate-500',
} as const;

function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      {keys.map((k) => (
        <kbd key={k} className={styles.kbd}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

const hostLine = (c: ConnectionInfo) => (c.hosts.length > 1 ? `${c.hosts[0]} +${c.hosts.length - 1}` : c.hosts[0] ?? c.uri);

function ConnectionCard({
  connection,
  index,
  lastUsedAt,
  pending,
  canEdit,
  onConnect,
  onEdit,
}: {
  connection: ConnectionInfo;
  // 0부터 — 9번째까지 1–9 단축키 번호를 보여 준다
  index: number;
  // 이 브라우저에서 마지막으로 연 시각(연 적 없으면 null)
  lastUsedAt: number | null;
  pending: boolean;
  canEdit: boolean;
  onConnect: () => void;
  onEdit: () => void;
}) {
  const color = colorClasses(connection.color);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onConnect();
    }
  };
  return (
    <div role="button" tabIndex={0} className={styles.card} onClick={onConnect} onKeyDown={onKey} aria-busy={pending} data-tt={`Connect to ${connectionLabel(connection)}`}>
      <span className={cn(styles.cardBar, color.bar)} aria-hidden="true" />
      <div className={styles.cardTop}>
        <span className={styles.cardName}>{connectionLabel(connection)}</span>
        {connection.favorite && <Star size={12} className="shrink-0 text-amber-400" fill="currentColor" aria-label="Favorite" />}
      </div>
      <p className={styles.cardHost}>{hostLine(connection)}</p>
      <div className={styles.cardBadges}>
        {connection.source === 'env' && <span className={styles.badge} data-tt="From MONGODB_URI in apps/server/.env">.env</span>}
        {connection.source === 'demo' && <span className={cn(styles.badge, 'ring-emerald-200 text-emerald-700')}>in-browser demo</span>}
        {connection.srv && <span className={styles.badge}>SRV</span>}
        {connection.username && <span className={styles.badge}>{connection.username}</span>}
        {lastUsedAt !== null && (
          <span className={styles.lastUsed} data-tt={`Last opened ${new Date(lastUsedAt).toLocaleString()}`}>
            <Clock size={11} aria-hidden="true" />
            {timeAgo(lastUsedAt)}
          </span>
        )}
      </div>
      {index < 9 && (
        <kbd className={cn(styles.kbd, canEdit && styles.cardKey, !canEdit && 'absolute right-3 top-3')} aria-hidden="true">
          {index + 1}
        </kbd>
      )}
      {canEdit && (
        <button
          type="button"
          className={styles.editBtn}
          aria-label={`Edit ${connectionLabel(connection)}`}
          data-tt="Edit"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <Pencil size={13} />
        </button>
      )}
      {pending && (
        <div className={styles.pending}>
          <Loader2 size={15} className="animate-spin" />
          Connecting…
        </div>
      )}
    </div>
  );
}

export function WelcomeScreen({ connections, connect, canManage, onNewConnection, onEditConnection, onOpenQuickJump, onOpenShortcuts }: WelcomeScreenProps) {
  const recent = useRecentConnections();
  // 지워진 연결 때문에 돌아왔으면 그 이유(닫거나 다른 연결을 고를 때까지)
  const notice = useConnectionNotice();
  const byId = new Map(connections.connections.map((c) => [c.id, c]));
  // 연결 id → 이 브라우저에서 마지막으로 연 시각
  const lastUsed = new Map(recent.map((r) => [r.id, r.at]));
  const lastConnection = recent.map((r) => byId.get(r.id)).find((c) => c !== undefined);
  const failed = connect.failure ? byId.get(connect.failure.id) : undefined;

  // 단축키 — N 새 연결, 1–9 카드 순서, Enter 마지막에 쓴 연결. 입력 중이거나 창이 떠 있으면 무시
  // (? 단축키 목록은 useMillerKeyboard가 어디서나 연다)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (e.key === 'n' && canManage) {
        e.preventDefault();
        onNewConnection();
      } else if (/^[1-9]$/.test(e.key)) {
        const item = connections.connections[Number(e.key) - 1];
        if (!item || connect.pendingId) return;
        e.preventDefault();
        void connect.connect(item.id);
      } else if (e.key === 'Enter') {
        // 카드·버튼에 포커스가 있으면 그것의 Enter가 먼저다
        if (target?.closest('button, [role="button"], a') || !lastConnection || connect.pendingId) return;
        e.preventDefault();
        void connect.connect(lastConnection.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className={styles.screen}>
      <div className={styles.inner}>
        <div className={styles.markWrap} aria-hidden="true">
          {/* 동심원은 마크 칸(112px) 안팎으로 조금만 — 아래 제목 줄에 걸치지 않게 */}
          <span className={cn(styles.markRing, 'h-24 w-24')} />
          <span className={cn(styles.markRing, 'h-[124px] w-[124px] opacity-60')} />
          <span className={cn(styles.markRing, 'h-[152px] w-[152px] opacity-30')} />
          <span className={styles.mark}>ML</span>
        </div>

        {notice && (
          <div className={styles.notice} role="status">
            <AlertTriangle size={15} className="mt-px shrink-0" />
            <span className="flex-1">{notice}</span>
            <button type="button" className="-m-1 rounded p-1 text-amber-700 hover:bg-amber-100" aria-label="Dismiss" onClick={dismissConnectionNotice}>
              <X size={14} />
            </button>
          </div>
        )}

        <section className={styles.section} aria-label="Connections">
          <div className={styles.sectionHead}>
            <Server size={13} className="text-slate-400" />
            <h2 className={styles.sectionTitle}>Connections</h2>
            {connections.connections.length > 0 && <span className={styles.count}>{connections.connections.length}</span>}
          </div>

          {connections.loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={18} className="animate-spin text-slate-400" aria-label="Loading connections" />
            </div>
          ) : connections.error ? (
            <div className={styles.empty}>
              Couldn&apos;t load connections — {connections.error}{' '}
              <button type="button" className="font-medium text-slate-700 underline underline-offset-2" onClick={() => void connections.reload()}>
                Retry
              </button>
            </div>
          ) : (
            <div className={styles.grid}>
              {connections.connections.map((c, i) => (
                <ConnectionCard
                  key={c.id}
                  connection={c}
                  index={i}
                  lastUsedAt={lastUsed.get(c.id) ?? null}
                  pending={connect.pendingId === c.id}
                  canEdit={canManage}
                  onConnect={() => !connect.pendingId && void connect.connect(c.id)}
                  onEdit={() => onEditConnection(c)}
                />
              ))}
              {canManage && (
                <button type="button" className={styles.newCard} onClick={onNewConnection}>
                  <Plus size={18} />
                  New connection
                </button>
              )}
            </div>
          )}

          {connect.failure && (
            <div className={styles.failure} role="alert">
              <AlertTriangle size={15} className="mt-px shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                Couldn&apos;t connect to <strong>{failed ? connectionLabel(failed) : 'that connection'}</strong> — {connect.failure.message}
                {failed && canManage && (
                  <>
                    {' '}
                    <button type="button" className={styles.linkBtn} onClick={() => onEditConnection(failed)}>
                      Edit connection
                    </button>
                  </>
                )}
              </span>
              <button type="button" className={styles.failureClose} onClick={connect.clearFailure} aria-label="Dismiss" data-tt="Dismiss">
                <X size={14} />
              </button>
            </div>
          )}
        </section>

        <div className={styles.bottom}>
          <section aria-label="Shortcuts">
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Shortcuts</h2>
            </div>
            <div className={styles.list}>
              {canManage && (
                <button type="button" className={styles.row} onClick={onNewConnection}>
                  New connection
                  <Kbd keys={['N']} />
                </button>
              )}
              <div className={cn(styles.row, 'cursor-default hover:bg-transparent hover:text-slate-600')}>
                Open a connection by its number
                <Kbd keys={['1', '–', '9']} />
              </div>
              {lastConnection && (
                <button type="button" className={styles.row} onClick={() => !connect.pendingId && void connect.connect(lastConnection.id)}>
                  Reopen {connectionLabel(lastConnection)}
                  <Kbd keys={['Enter']} />
                </button>
              )}
              <button type="button" className={styles.row} onClick={onOpenQuickJump}>
                Quick jump & commands
                <Kbd keys={[MOD, 'K']} />
              </button>
              <div className={cn(styles.row, 'cursor-default hover:bg-transparent hover:text-slate-600')}>
                Toggle sidebar
                <Kbd keys={[MOD, 'B']} />
              </div>
              <button type="button" className={styles.row} onClick={onOpenShortcuts}>
                All keyboard shortcuts
                <Kbd keys={['?']} />
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
