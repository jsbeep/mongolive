// 알림 센터 (VSCode의 알림 센터처럼 오른쪽 아래, 상태바의 종으로 연다).
//   Changes — 서버 changeStream의 변경 기록(레거시 ChangeStreamLogs). 누르면 그 위치로 이동하고 닫힌다
//   System  — 에러 토스트, 실시간 연결 끊김/복구
//   Metrics — 서버 지표(레거시 PerformanceMetrics)
// 바깥을 누르거나 Esc로 닫는다. data-keeps-notifications가 붙은 곳(상태바의 종·연결 상태, 토스트)은 바깥으로 치지 않는다
// — 종은 직접 여닫고, 토스트의 Undo는 센터와 상관없으므로.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';
import { dataSourceKind } from '../../services/api';
import type { ActivityLog } from '../../hooks/useActivityLog';
import type { SystemLog } from '../../hooks/useSystemLog';
import type { LiveLogEntry } from '../../types/explorer';
import { ChangesTab } from '../activity/ChangesTab';
import { MetricsTab } from '../activity/MetricsTab';
import { SystemTab } from './SystemTab';

export type NotificationTab = 'changes' | 'system' | 'metrics';

interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
  tab: NotificationTab;
  onTabChange: (tab: NotificationTab) => void;
  activity: ActivityLog;
  system: SystemLog;
  activeDatabase: string | null;
  activeCollection: string | null;
  onNavigate: (entry: LiveLogEntry) => void;
}

// 상태바 바로 위 — 상태바: 아래 여백 12px + 높이 32px, 그 위로 6px
export const CENTER_BOTTOM = 50;
export const CENTER_HEIGHT = 'min(520px, calc(100vh - 6rem))';

const styles = {
  // z-[100]: 컬럼 카드(최대 99) 위, 드롭다운(101)·툴팁(900)·모달(1000) 아래
  panel: 'fixed right-3 z-[100] flex w-[440px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg bg-white shadow-elevated ring-1 ring-slate-200/80',
  head: 'flex h-9 shrink-0 items-stretch gap-3 border-b border-slate-100 pl-3 pr-1.5',
  // VSCode 패널 탭처럼: 대문자 작은 글자 + 밑줄. 켜짐/꺼짐은 둘 중 하나만
  tab: 'relative flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide transition-colors',
  tabIdle: 'text-slate-400 hover:text-slate-700',
  tabOn: 'text-slate-800',
  badge: 'rounded-full px-1.5 text-[10px] font-semibold leading-4 text-white',
  close: 'my-auto ml-auto rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600',
  mockNotice: 'm-4 rounded-lg bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500',
} as const;

export function NotificationCenter({ open, onClose, tab, onTabChange, activity, system, activeDatabase, activeCollection, onNavigate }: NotificationCenterProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // System 탭을 보고 있는 동안 생긴 에러는 '본 것'
  const { markSeen } = system;
  useEffect(() => {
    if (open && tab === 'system') markSeen();
  }, [open, tab, system.entries, markSeen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('[data-keeps-notifications]')) return;
      // 모달·드롭다운 등 위에 뜬 것을 누른 경우는 닫지 않는다
      if (target.closest('[role="dialog"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, onClose]);

  const tabs: { id: NotificationTab; label: string; badge?: { n: number; color: string } }[] = [
    { id: 'changes', label: 'Changes', badge: activity.unread ? { n: activity.unread, color: 'bg-sky-500' } : undefined },
    { id: 'system', label: 'System', badge: system.unseenErrors ? { n: system.unseenErrors, color: 'bg-rose-500' } : undefined },
    { id: 'metrics', label: 'Metrics' },
  ];

  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div
          ref={panelRef}
          className={styles.panel}
          style={{ bottom: CENTER_BOTTOM, height: CENTER_HEIGHT }}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ type: 'spring', stiffness: 480, damping: 38 }}
          role="region"
          aria-label="Notifications"
        >
          <div className={styles.head} role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={cn(styles.tab, tab === t.id ? styles.tabOn : styles.tabIdle)}
                onClick={() => onTabChange(t.id)}
              >
                {t.label}
                {t.badge && <span className={cn(styles.badge, t.badge.color)}>{t.badge.n > 99 ? '99+' : t.badge.n}</span>}
                {tab === t.id && <m.span layoutId="notification-tab" className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-emerald-500" />}
              </button>
            ))}
            <button type="button" className={styles.close} onClick={onClose} aria-label="Hide notifications" data-tt="Hide (Esc)">
              <ChevronDown size={15} />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {tab === 'system' ? (
              <SystemTab entries={system.entries} onClear={system.clear} />
            ) : dataSourceKind === 'mock' ? (
              <p className={styles.mockNotice}>
                Live changes and server metrics appear when the app is connected to a MongoDB server
                (<code className="font-mono">pnpm dev:web:remote</code>). The in-browser mock has no outside changes to show.
              </p>
            ) : tab === 'changes' ? (
              <ChangesTab
                entries={activity.entries}
                seenAt={activity.seenAt}
                unread={activity.unread}
                onClear={activity.clear}
                onMarkAllRead={activity.markSeen}
                onNavigate={onNavigate}
                activeDatabase={activeDatabase}
                activeCollection={activeCollection}
              />
            ) : (
              <MetricsTab />
            )}
          </div>
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
