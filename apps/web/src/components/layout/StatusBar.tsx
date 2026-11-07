// 하단 상태바 (VSCode 하단바 느낌) — 예전 헤더의 버튼들을 작게 내려 둔 곳.
//   왼쪽:   연결 상태(누르면 알림 센터의 System 탭 = 연결 기록) · 새로고침(= 다시 맞추기)
//   오른쪽: Tree/Columns · 컬럼 수 − n + · 설정 · 로그아웃 · 알림 센터(종)
// 바는 예전 헤더처럼 둥근 카드, 항목은 테두리 없이 hover 배경만 있는 덜 둥근 네모.
import { useState } from 'react';
import { Bell, BellDot, Circle, Columns3, ListTree, Lock, LogOut, Minus, Plus, RefreshCw, Settings } from 'lucide-react';
import { useServerSettings } from '../../services/serverSettings';
import { m } from 'framer-motion';
import { MIN_VISIBLE_COLUMNS, MAX_VISIBLE_COLUMNS, type UseExplorerStateResult } from '../../hooks/useExplorerState';
import { dataSourceKind } from '../../services/api';
import { cn } from '../../utils/cn';
import { useAuth } from '../auth/AuthGate';
import { CONNECTION_STATUS } from './connectionStatus';

interface StatusBarProps {
  connectionStatus: UseExplorerStateResult['connectionStatus'];
  onRefresh: () => void;
  maxVisibleColumns: number;
  setMaxVisibleColumns: (n: number) => void;
  unreadChanges: number;
  unseenErrors: number;
  isCenterOpen: boolean;
  onToggleCenter: () => void;
  onOpenSystem: () => void;
  onOpenSettings: () => void;
  // Read-only 배지 → 설정 창 › Safety
  onOpenSafety: () => void;
}

const styles = {
  // 예전 헤더와 같은 둥근 카드(rounded-[14px], 테두리, 그림자) — 화면 가장자리에서 띄워 컬럼 패널과 줄을 맞춘다
  bar: 'mx-3 mb-3 flex h-12 shrink-0 items-center gap-1 rounded-[14px] border border-slate-200/80 bg-white/85 px-2 text-[13px] text-slate-600 shadow-soft backdrop-blur-md',
  group: 'flex items-center gap-0.5',
  // 켜짐/꺼짐 배경은 둘 중 하나만(cn은 겹침을 정리해 주지 않는다)
  item: 'inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-35',
  itemIdle: 'hover:bg-slate-200/60 hover:text-slate-900 disabled:hover:bg-transparent',
  itemOn: 'bg-slate-200/70 text-slate-900',
  square: 'w-9 justify-center px-0',
  count: 'min-w-[1ch] text-center font-semibold tabular-nums',
  sep: 'mx-1 h-4 w-px bg-slate-200',
} as const;

export function StatusBar({
  connectionStatus,
  onRefresh,
  maxVisibleColumns,
  setMaxVisibleColumns,
  unreadChanges,
  unseenErrors,
  isCenterOpen,
  onToggleCenter,
  onOpenSystem,
  onOpenSettings,
  onOpenSafety,
}: StatusBarProps) {
  const safety = useServerSettings();
  const auth = useAuth();
  const status = CONNECTION_STATUS[connectionStatus];
  const [rotation, setRotation] = useState(0);
  const isTreeMode = maxVisibleColumns === MIN_VISIBLE_COLUMNS;
  const hasNews = unreadChanges > 0 || unseenErrors > 0;
  const BellIcon = hasNews ? BellDot : Bell;

  return (
    <footer className={styles.bar} aria-label="Status bar">
      <div className={styles.group}>
        {dataSourceKind === 'mock' ? (
          <span className={cn(styles.item, 'cursor-default')} data-tt="In-browser mock data — nothing is sent to a server">
            <Circle size={10} className="text-orange-400" fill="currentColor" stroke="none" />
            Mock data
          </span>
        ) : (
          <button
            type="button"
            className={cn(styles.item, styles.itemIdle)}
            onClick={onOpenSystem}
            data-keeps-notifications
            data-tt="Connection history"
          >
            <Circle size={10} className={status.color} fill="currentColor" stroke="none" />
            {status.label}
          </button>
        )}
        <button
          type="button"
          className={cn(styles.item, styles.itemIdle, styles.square)}
          onClick={() => {
            setRotation((r) => r + 360);
            onRefresh();
          }}
          aria-label="Re-sync what's on screen"
          data-tt="Re-sync what's on screen (keeps your place)"
        >
          <m.span className="inline-flex" animate={{ rotate: rotation }} transition={{ duration: 0.8, ease: 'easeInOut' }}>
            <RefreshCw size={16} aria-hidden="true" />
          </m.span>
        </button>
        {safety.readOnly && (
          <button
            type="button"
            className={cn(styles.item, 'bg-amber-100 font-semibold text-amber-800 hover:bg-amber-200/80')}
            onClick={onOpenSafety}
            data-tt="Read-only mode — every edit is blocked. Click to change"
          >
            <Lock size={15} />
            Read-only
          </button>
        )}
      </div>

      <div className="flex-1" />

      <div className={styles.group}>
        <button
          type="button"
          className={cn(styles.item, isTreeMode ? styles.itemOn : styles.itemIdle)}
          aria-pressed={isTreeMode}
          onClick={() => setMaxVisibleColumns(isTreeMode ? 3 : MIN_VISIBLE_COLUMNS)}
          data-tt={isTreeMode ? 'Tree mode — click to spread levels across columns' : 'Column mode — click to stack levels into one tree'}
        >
          {isTreeMode ? <ListTree size={16} /> : <Columns3 size={16} />}
          {isTreeMode ? 'Tree' : 'Columns'}
        </button>
        <div className={styles.group} role="group" aria-label="Visible column count">
          <button
            type="button"
            className={cn(styles.item, styles.itemIdle, styles.square)}
            onClick={() => setMaxVisibleColumns(maxVisibleColumns - 1)}
            disabled={maxVisibleColumns <= MIN_VISIBLE_COLUMNS}
            aria-label="Show fewer columns"
          >
            <Minus size={16} />
          </button>
          <button
            type="button"
            className={cn(styles.item, styles.itemIdle, styles.square, styles.count)}
            onClick={() => setMaxVisibleColumns(3)}
            aria-label={`${maxVisibleColumns} columns — reset to 3`}
            data-tt="Visible columns — click to reset to 3"
          >
            {maxVisibleColumns}
          </button>
          <button
            type="button"
            className={cn(styles.item, styles.itemIdle, styles.square)}
            onClick={() => setMaxVisibleColumns(maxVisibleColumns + 1)}
            disabled={maxVisibleColumns >= MAX_VISIBLE_COLUMNS}
            aria-label="Show more columns"
          >
            <Plus size={16} />
          </button>
        </div>

        <span className={styles.sep} aria-hidden="true" />

        <button
          type="button"
          className={cn(styles.item, styles.itemIdle, styles.square)}
          onClick={onOpenSettings}
          aria-label="Settings"
          data-tt="Settings"
        >
          <Settings size={16} />
        </button>
        {auth.canLogout && (
          <button
            type="button"
            className={cn(styles.item, styles.itemIdle, styles.square)}
            onClick={() => void auth.logout()}
            aria-label="Sign out"
            data-tt="Sign out of this browser"
          >
            <LogOut size={16} />
          </button>
        )}
        <button
          type="button"
          className={cn(styles.item, isCenterOpen ? styles.itemOn : styles.itemIdle, unreadChanges > 0 ? '' : styles.square)}
          onClick={onToggleCenter}
          aria-pressed={isCenterOpen}
          aria-label={`Notifications${unreadChanges ? ` — ${unreadChanges} unread changes` : ''}${unseenErrors ? `, ${unseenErrors} new errors` : ''}`}
          data-keeps-notifications
          data-tt={unseenErrors ? `${unseenErrors} new error${unseenErrors > 1 ? 's' : ''}` : unreadChanges ? `${unreadChanges} unread change${unreadChanges > 1 ? 's' : ''}` : 'Notifications'}
        >
          {/* 안 본 에러가 있으면 종의 점을 빨갛게 */}
          <BellIcon size={16} className={unseenErrors > 0 ? 'text-rose-500' : hasNews ? 'text-sky-600' : undefined} />
          {unreadChanges > 0 && <span className={styles.count}>{unreadChanges > 99 ? '99+' : unreadChanges}</span>}
        </button>
      </div>
    </footer>
  );
}
