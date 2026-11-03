// 활동 패널 — 오른쪽에서 열리는 서랍. 레거시의 ChangeStreamLogs / PerformanceMetrics를 탭으로.
// 레거시 두 패널은 가짜(무작위) 데이터였고, 여기선 서버의 실제 변경 기록과 지표를 보여준다.
// 패널이 열려 있는 동안에만 서버가 기록을 보내고 지표를 모은다(닫으면 구독 해제).
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'framer-motion';
import { Activity, X } from 'lucide-react';
import { cn } from '../../utils/cn';
import { dataSourceKind } from '../../services/api';
import type { ActivityLog } from '../../hooks/useActivityLog';
import type { LiveLogEntry } from '../../types/explorer';
import { ChangesTab } from './ChangesTab';
import { MetricsTab } from './MetricsTab';

type Tab = 'changes' | 'metrics';

interface ActivityPanelProps {
  open: boolean;
  onClose: () => void;
  activeDatabase: string | null;
  activeCollection: string | null;
  log: ActivityLog;
  onNavigate: (entry: LiveLogEntry) => void;
}

const styles = {
  panel:
    // z-[100]: 컬럼 카드(최대 99) 위, 드롭다운(101)·툴팁(900)·모달(1000) 아래
    'fixed right-3 top-3 bottom-3 z-[100] flex w-[420px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl bg-white shadow-elevated ring-1 ring-slate-200/70',
  header: 'flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 h-12',
  title: 'flex items-center gap-2 text-[13px] font-semibold text-slate-700 flex-1',
  tabs: 'flex items-center rounded-xl bg-slate-100 p-0.5',
  tab: 'relative px-3 py-1 text-xs font-medium rounded-lg transition-colors',
  tabIdle: 'text-slate-500 hover:text-slate-700',
  tabActive: 'text-slate-800',
  close: 'p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors',
  mockNotice: 'm-4 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500',
} as const;

export function ActivityPanel({ open, onClose, activeDatabase, activeCollection, log, onNavigate }: ActivityPanelProps) {
  const [tab, setTab] = useState<Tab>('changes');

  return createPortal(
    <AnimatePresence>
      {open && (
        <m.aside
          className={styles.panel}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ type: 'spring', stiffness: 420, damping: 36 }}
          aria-label="Activity"
        >
          <div className={styles.header}>
            <span className={styles.title}>
              <Activity size={15} className="text-slate-400" />
              Activity
            </span>
            <div className={styles.tabs} role="tablist">
              {(['changes', 'metrics'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={cn(styles.tab, tab === t ? styles.tabActive : styles.tabIdle)}
                  onClick={() => setTab(t)}
                >
                  {tab === t && <m.span layoutId="activity-tab" className="absolute inset-0 rounded-[10px] bg-white shadow-sm" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                  <span className="relative">{t === 'changes' ? 'Changes' : 'Metrics'}</span>
                </button>
              ))}
            </div>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Close activity panel">
              <X size={15} />
            </button>
          </div>

          {dataSourceKind === 'mock' ? (
            <p className={styles.mockNotice}>
              Live changes and server metrics appear when the app is connected to a MongoDB server
              (<code className="font-mono">pnpm dev:web:remote</code>). The in-browser mock has no outside changes to show.
            </p>
          ) : tab === 'changes' ? (
            <ChangesTab
              entries={log.entries}
              seenAt={log.seenAt}
              unread={log.unread}
              onClear={log.clear}
              onMarkAllRead={log.markSeen}
              onNavigate={onNavigate}
              activeDatabase={activeDatabase}
              activeCollection={activeCollection}
            />
          ) : (
            <MetricsTab />
          )}
        </m.aside>
      )}
    </AnimatePresence>,
    document.body,
  );
}
