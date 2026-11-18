// 하단 상태바 (VSCode 하단바 느낌) — 예전 헤더의 버튼들을 작게 내려 둔 곳.
//   왼쪽:   연결 상태(누르면 알림 센터의 System 탭 = 연결 기록) · 새로고침(= 다시 맞추기, R)
//           단독 DB면 'Polling · 1m' — 실시간 대신 설정의 주기로 다시 받는다
//   연결 전(웰컴 화면): 'No connection'만 — 새로고침·컬럼 조절은 볼 것이 없으니 숨긴다
//   오른쪽: Tree/Columns · 컬럼 수 − n + · 설정 · 로그아웃 · 알림 센터(종)
// 바는 예전 헤더처럼 둥근 카드, 항목은 테두리 없이 hover 배경만 있는 덜 둥근 네모.
import { useEffect, useRef, useState } from 'react';
import { Bell, Circle, Columns3, ListTree, Lock, Minus, Plus, RefreshCw, Search } from 'lucide-react';
import { SYSTEM_TONE_BG, systemToneOf, unseenTotal, type UnseenSystem } from '../../hooks/useSystemLog';
import { useServerSettings } from '../../services/serverSettings';
import type { StandaloneRefresh } from '../../services/preferences';
import { m } from 'framer-motion';
import { MAX_VISIBLE_COLUMNS, type UseExplorerStateResult } from '../../hooks/useExplorerState';
import { dataSourceKind } from '../../services/api';
import { cn } from '../../utils/cn';
import { CONNECTION_STATUS } from './connectionStatus';

interface StatusBarProps {
  // 이 탭이 연결을 골랐는지 — 아니면 웰컴 화면
  connected: boolean;
  connectionStatus: UseExplorerStateResult['connectionStatus'];
  onRefresh: () => void;
  // 새로 고친 횟수(R·⟳·빠른 이동) — 바뀔 때마다 ⟳ 아이콘이 한 바퀴 돈다
  refreshCount: number;
  // 단독 DB의 다시 받기 주기(설정)
  pollInterval: StandaloneRefresh;
  maxVisibleColumns: number;
  setMaxVisibleColumns: (n: number) => void;
  // 지금 모드의 Tree / 컬럼 수 최소·'처음 값' — 집계 모드는 따로 기억한다(useExplorerState)
  treeMode: boolean;
  setTreeMode: (on: boolean) => void;
  minColumns: number;
  defaultColumns: number;
  // 컬럼 수를 못 바꿀 때(집계 Tree는 늘 3패널) — ± 버튼을 끈다
  columnCountFixed: boolean;
  // Tree/Columns·컬럼 수 조절을 보일지 — Monitor 화면에선 컬럼이 없으니 숨긴다
  showColumnControls: boolean;
  unreadChanges: number;
  // 안 본 시스템 기록(수준별) — 종의 점 색
  unseenSystem: UnseenSystem;
  isCenterOpen: boolean;
  onToggleCenter: () => void;
  onOpenSystem: () => void;
  // Read-only 배지 → 설정 창 › Safety
  onOpenSafety: () => void;
  // 빠른 이동(Ctrl+K) — 단축키를 모르는 사람도 찾을 수 있게 버튼으로도
  onOpenQuickJump: () => void;
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
  connected,
  connectionStatus,
  onRefresh,
  refreshCount,
  showColumnControls,
  pollInterval,
  maxVisibleColumns,
  setMaxVisibleColumns,
  treeMode: isTreeMode,
  setTreeMode,
  minColumns,
  defaultColumns,
  columnCountFixed,
  unreadChanges,
  unseenSystem,
  isCenterOpen,
  onToggleCenter,
  onOpenSystem,
  onOpenSafety,
  onOpenQuickJump,
}: StatusBarProps) {
  const safety = useServerSettings();
  const status = CONNECTION_STATUS[connectionStatus];
  const systemTone = systemToneOf(unseenSystem);
  const systemCount = unseenTotal(unseenSystem);
  const ring = useBellRing(systemCount, unreadChanges);
  const SYSTEM_WORD = { error: 'error', warning: 'warning', success: 'message' } as const;
  const systemTip = systemTone ? `${systemCount} new system ${SYSTEM_WORD[systemTone]}${systemCount > 1 ? 's' : ''}` : '';

  return (
    <footer className={styles.bar} aria-label="Status bar">
      <div className={styles.group}>
        {!connected ? (
          <span className={cn(styles.item, 'cursor-default text-slate-400')}>
            <Circle size={10} className="text-slate-300" fill="currentColor" stroke="none" />
            No connection
          </span>
        ) : dataSourceKind === 'mock' ? (
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
            data-tt={
              connectionStatus === 'polling'
                ? `Not a replica set — no live updates. ${pollInterval === 'off' ? 'Auto-refresh is off' : `Refreshing every ${pollInterval}`}; press R to refresh now. Click for connection history`
                : 'Connection history'
            }
          >
            <Circle size={10} className={status.color} fill="currentColor" stroke="none" />
            {status.label}
            {connectionStatus === 'polling' && <span className="text-slate-400">· {pollInterval === 'off' ? 'manual' : pollInterval}</span>}
          </button>
        )}
        {connected && (
        <button
          type="button"
          className={cn(styles.item, styles.itemIdle, styles.square)}
          onClick={onRefresh}
          aria-label="Re-sync what's on screen"
          data-tt="Re-sync what's on screen (keeps your place) — R"
        >
          <m.span className="inline-flex" animate={{ rotate: refreshCount * 360 }} transition={{ duration: 0.8, ease: 'easeInOut' }}>
            <RefreshCw size={16} aria-hidden="true" />
          </m.span>
        </button>
        )}
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
        <button type="button" className={cn(styles.item, styles.itemIdle)} onClick={onOpenQuickJump} data-tt="Quick jump — databases, collections, ObjectIds, commands">
          <Search size={16} />
          <span className="text-slate-400">{navigator.platform.toLowerCase().includes('mac') ? '⌘K' : 'Ctrl+K'}</span>
        </button>
        {connected && showColumnControls && (
        <>
        <span className={styles.sep} aria-hidden="true" />
        <button
          type="button"
          className={cn(styles.item, isTreeMode ? styles.itemOn : styles.itemIdle)}
          aria-pressed={isTreeMode}
          onClick={() => setTreeMode(!isTreeMode)}
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
            disabled={columnCountFixed || maxVisibleColumns <= minColumns}
            aria-label="Show fewer columns"
          >
            <Minus size={16} />
          </button>
          <button
            type="button"
            className={cn(styles.item, styles.itemIdle, styles.square, styles.count)}
            onClick={() => setMaxVisibleColumns(defaultColumns)}
            disabled={columnCountFixed}
            aria-label={columnCountFixed ? `${maxVisibleColumns} panels in tree mode` : `${maxVisibleColumns} columns — reset to ${defaultColumns}`}
            data-tt={columnCountFixed ? 'Tree mode always shows 3 panels — switch to Columns to change' : `Visible columns — click to reset to ${defaultColumns}`}
          >
            {maxVisibleColumns}
          </button>
          <button
            type="button"
            className={cn(styles.item, styles.itemIdle, styles.square)}
            onClick={() => setMaxVisibleColumns(maxVisibleColumns + 1)}
            disabled={columnCountFixed || maxVisibleColumns >= MAX_VISIBLE_COLUMNS}
            aria-label="Show more columns"
          >
            <Plus size={16} />
          </button>
        </div>
        </>
        )}

        <span className={styles.sep} aria-hidden="true" />

        <button
          type="button"
          className={cn(styles.item, isCenterOpen ? styles.itemOn : styles.itemIdle, unreadChanges > 0 ? '' : styles.square)}
          onClick={onToggleCenter}
          aria-pressed={isCenterOpen}
          aria-label={`Notifications${unreadChanges ? ` — ${unreadChanges} unread changes` : ''}${systemTip ? `, ${systemTip}` : ''}`}
          data-keeps-notifications
          data-tt={[unreadChanges ? `${unreadChanges} unread change${unreadChanges > 1 ? 's' : ''}` : '', systemTip].filter(Boolean).join(' · ') || 'Notifications'}
        >
          {/* 변경은 파랑(종·숫자), 시스템은 점 — 안 본 것 중 가장 심각한 색(빨강 > 주황 > 초록). 새로 오면 띠롱 */}
          <span className="relative inline-flex">
            <m.span
              key={ring}
              className="inline-flex"
              style={{ transformOrigin: '50% 15%' }}
              animate={ring ? { rotate: [0, -18, 14, -9, 5, 0] } : undefined}
              transition={{ duration: 0.6, ease: 'easeInOut' }}
            >
              <Bell size={16} className={unreadChanges > 0 ? 'text-sky-600' : undefined} />
            </m.span>
            {systemTone && (
              <m.span
                key={`dot-${ring}`}
                className={cn('absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-white', SYSTEM_TONE_BG[systemTone])}
                initial={ring ? { scale: 0.3 } : false}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 14 }}
              />
            )}
          </span>
          {unreadChanges > 0 && (
            <m.span
              key={`count-${ring}`}
              className={cn(styles.count, 'text-sky-600')}
              animate={ring ? { scale: [1, 1.3, 1] } : undefined}
              transition={{ duration: 0.4 }}
            >
              {unreadChanges > 99 ? '99+' : unreadChanges}
            </m.span>
          )}
        </button>
      </div>
    </footer>
  );
}

// 띠롱 신호 — 시스템 기록이 늘 때마다, 변경은 안 읽음이 0에서 생길 때만(대량 쓰기 중 계속 울리지 않게).
// 화면을 연 직후 3초는 울리지 않는다(연결됨·쌓여 있던 변경이 한꺼번에 들어오는 때). 0 = 아직 안 울림
function useBellRing(systemCount: number, unreadChanges: number): number {
  const [ring, setRing] = useState(0);
  const prev = useRef({ system: systemCount, changes: unreadChanges });
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    const p = prev.current;
    const fresh = systemCount > p.system || (p.changes === 0 && unreadChanges > 0);
    prev.current = { system: systemCount, changes: unreadChanges };
    if (fresh && Date.now() - mountedAt.current > 3000) setRing((n) => n + 1);
  }, [systemCount, unreadChanges]);
  return ring;
}
