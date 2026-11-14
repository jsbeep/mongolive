// 사이드바 Connections 패널(상태 바의 연결 이름으로도 연다) — 연결 바꾸기·추가·수정·끊기.
// 바꾸기도 웰컴 화면과 같이 먼저 접속해 보고 된 뒤에 넘어간다(useConnect).
import { AlertTriangle, Loader2, Pencil, Plus, Server, Unplug } from 'lucide-react';
import { connectionLabel, type ConnectionInfo } from '../../types/explorer';
import type { ConnectionsState } from '../../hooks/useConnections';
import { SidebarPopover } from '../layout/SidebarPopover';
import { cn } from '../../utils/cn';
import { colorClasses } from './connectionColors';
import type { ConnectAction } from './useConnect';

interface ConnectionsPanelProps {
  anchor: DOMRect;
  connections: ConnectionsState;
  connect: ConnectAction;
  currentId: string | null;
  canManage: boolean;
  onNew: () => void;
  onEdit: (connection: ConnectionInfo) => void;
  onDisconnect: () => void;
  onClose: () => void;
}

export function ConnectionsPanel({ anchor, connections, connect, currentId, canManage, onNew, onEdit, onDisconnect, onClose }: ConnectionsPanelProps) {
  const list = connections.connections;
  return (
    <SidebarPopover
      anchor={anchor}
      title="Connections"
      icon={<Server size={14} />}
      width={320}
      onClose={onClose}
      actions={
        canManage && (
          <button type="button" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="New connection" data-tt="New connection" onClick={onNew}>
            <Plus size={14} />
          </button>
        )
      }
    >
      {connections.loading ? (
        <div className="flex justify-center py-6">
          <Loader2 size={16} className="animate-spin text-slate-400" />
        </div>
      ) : list.length === 0 ? (
        <p className="px-3 py-4 text-center text-[13px] text-slate-500">No connections yet.</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((c) => {
            const current = c.id === currentId;
            const pending = connect.pendingId === c.id;
            return (
              <li key={c.id} className="group relative">
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 pr-9 text-left transition-colors',
                    current ? 'bg-emerald-50' : 'hover:bg-slate-100',
                  )}
                  disabled={current || !!connect.pendingId}
                  aria-current={current || undefined}
                  onClick={() => void connect.connect(c.id)}
                  data-tt={current ? 'This tab is using this connection' : `Switch this tab to ${connectionLabel(c)}`}
                >
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', colorClasses(c.color).bar)} aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn('truncate text-[13px]', current ? 'font-semibold text-emerald-800' : 'text-slate-700')}>{connectionLabel(c)}</span>
                    <span className="truncate font-mono text-[11px] text-slate-400">{c.hosts[0] ?? c.uri}</span>
                  </span>
                  {pending && <Loader2 size={13} className="shrink-0 animate-spin text-slate-400" />}
                  {current && !pending && <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Current</span>}
                </button>
                {canManage && (
                  <button
                    type="button"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 opacity-0 transition-opacity hover:bg-slate-200/70 hover:text-slate-600 focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`Edit ${connectionLabel(c)}`}
                    data-tt="Edit"
                    onClick={() => onEdit(c)}
                  >
                    <Pencil size={12} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {connect.failure && (
        <div className="m-1.5 flex items-start gap-2 rounded-lg bg-rose-50 px-2.5 py-2 text-[12px] text-rose-700" role="alert">
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{connect.failure.message}</span>
        </div>
      )}

      {currentId && (
        <div className="mt-1 border-t border-slate-100 pt-1">
          <button type="button" className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-600 hover:bg-slate-100" onClick={onDisconnect}>
            <Unplug size={13} className="text-slate-400" />
            Disconnect this tab
          </button>
        </div>
      )}
    </SidebarPopover>
  );
}
