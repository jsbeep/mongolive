// Monitor 화면 (9단계) — 사이드바의 Monitor 버튼으로 Explorer와 바꿔 본다. 컬럼 카드 자리를 통째로 쓴다.
//   [범위 바(브레드크럼 자리)] [탭] [탭 내용]
// 처음 열 때만 불러온다(React.lazy) — Explorer만 쓰는 사람의 첫 로딩에는 들어가지 않는다.
// 지표는 서버가 이 연결(피드)에 대해 10초마다 잰다 — 이 연결을 쓰는 탭이 하나라도 열려 있는 동안만 기록된다.
import { m } from 'framer-motion';
import type { CollectionSummary, DatabaseSummary, LastWrite, MonitorRange } from '../../types/explorer';
import { useServerSettings } from '../../services/serverSettings';
import { api } from '../../services/api';
import { useMonitor } from '../../hooks/useMonitor';
import { cn } from '../../utils/cn';
import { ScopeBar, type LiveIndicator, type MonitorScope } from './ScopeBar';
import { OverviewTab } from './OverviewTab';
import { CollectionsTab } from './CollectionsTab';
import { OperationsTab } from './OperationsTab';
import type { MonitorState } from '../../hooks/useMonitor';

export type MonitorTab = 'overview' | 'collections' | 'operations';

export interface MonitorViewProps {
  connectionName: string;
  scope: MonitorScope;
  onScopeChange: (scope: MonitorScope) => void;
  // 고른 탭 — 화면을 닫았다 열어도 남게 page가 들고 있다
  tab: MonitorTab;
  onTabChange: (tab: MonitorTab) => void;
  // Collections의 '자주 바뀐 문서' → Explorer에서 그 문서를 연다
  onOpenDocument: (database: string, collection: string, documentId: string) => void;
  // 기간(범위 바) — 모든 탭에 같이. 화면을 닫았다 열어도 남게 page가 들고 있다
  range: MonitorRange;
  onRangeChange: (range: MonitorRange) => void;
  // 서버 메모리의 마지막 쓰기(긴 기간 표의 '마지막 쓰기' 칸) — page가 10초마다 받는다
  lastWrites: Record<string, LastWrite> | null;
  databases: DatabaseSummary[];
  explorerDatabase: string | null;
  explorerCollections: CollectionSummary[];
  onOpenInExplorer: (scope: MonitorScope) => void;
}

const TABS: { id: MonitorTab; label: string; tip: string }[] = [
  { id: 'overview', label: 'Overview', tip: 'Throughput, latency, connections and errors — whole server' },
  { id: 'collections', label: 'Collections', tip: 'Writes per collection, field and document — from the change stream' },
  { id: 'operations', label: 'Operations', tip: 'What MongoDB is running right now — stop a runaway query' },
];

const styles = {
  tabs: 'flex h-10 shrink-0 items-stretch gap-4 border-b border-slate-100 px-5',
  tab: 'relative flex items-center text-[11px] font-medium uppercase tracking-wide transition-colors',
  tabIdle: 'text-slate-400 hover:text-slate-700',
  tabOn: 'text-slate-800',
  scroll: 'min-h-0 flex-1 overflow-y-auto',
  note: 'mx-4 mt-3 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-slate-500',
  mock: 'm-6 max-w-xl rounded-xl bg-slate-50 px-4 py-3 text-[13px] leading-relaxed text-slate-500',
} as const;

// 지금 상태 한 단어 — 점 색만으로 구분하지 않게 글자를 같이 둔다
const liveOf = (monitor: MonitorState): LiveIndicator => {
  const latest = monitor.samples[monitor.samples.length - 1];
  if (!monitor.received || !latest) return { tone: 'idle', label: 'Waiting', tip: 'Waiting for the first sample from the server' };
  // 두 칸 넘게 소식이 없으면 멈춘 것(서버와 끊김 등)
  if (monitor.now - latest.at > monitor.intervalMs * 2.5) return { tone: 'idle', label: 'Paused', tip: 'No new samples — the connection to the mongolive server may be down' };
  if (latest.problem === 'denied') return { tone: 'warn', label: 'Limited', tip: 'No serverStatus permission (clusterMonitor) — only ping is measured' };
  if (latest.problem) return { tone: 'error', label: latest.problem === 'unreachable' ? 'Unreachable' : 'Error', tip: 'The last sample could not be measured' };
  return { tone: 'ok', label: 'Live', tip: `Measured every ${monitor.intervalMs / 1000}s by the mongolive server` };
};

export default function MonitorView({ connectionName, scope, onScopeChange, tab, onTabChange, onOpenDocument, range, onRangeChange, lastWrites, databases, explorerDatabase, explorerCollections, onOpenInExplorer }: MonitorViewProps) {
  const settings = useServerSettings();
  // 범위 바의 상태 표시가 Overview 지표를 쓰므로 탭과 상관없이 받는다
  const monitor = useMonitor(api.supportsMonitor);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScopeBar
        connectionName={connectionName}
        scope={scope}
        onScopeChange={onScopeChange}
        databases={databases}
        explorerDatabase={explorerDatabase}
        explorerCollections={explorerCollections}
        live={api.supportsMonitor ? liveOf(monitor) : { tone: 'idle', label: 'Unavailable', tip: 'Monitor needs a MongoDB server' }}
        range={range}
        onRangeChange={onRangeChange}
        onOpenInExplorer={onOpenInExplorer}
      />

      <div className={styles.tabs} role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={cn(styles.tab, tab === t.id ? styles.tabOn : styles.tabIdle)} onClick={() => onTabChange(t.id)} data-tt={t.tip}>
            {t.label}
            {tab === t.id && <m.span layoutId="monitor-tab" className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-emerald-500" />}
          </button>
        ))}
      </div>

      <div className={styles.scroll}>
        {!api.supportsMonitor ? (
          <p className={styles.mock}>
            Monitor measures a real MongoDB server — throughput, latency, connections and errors, every 10 seconds.
            The in-browser demo has no server to measure. Run mongolive against your MongoDB to see it
            (<code className="font-mono">pnpm dev:web:remote</code>).
          </p>
        ) : (
          tab === 'operations' ? (
            <OperationsTab scope={scope} />
          ) : tab === 'collections' ? (
            <CollectionsTab
              scope={scope}
              onScopeChange={onScopeChange}
              range={range}
              lastWrites={lastWrites}
              explorerDatabase={explorerDatabase}
              explorerCollections={explorerCollections}
              onOpenDocument={onOpenDocument}
            />
          ) : (
            <>
              {scope.database !== null && (
                <p className={styles.note}>
                  MongoDB reports these numbers for the whole server, not per database — the scope above applies to the Collections tab.
                </p>
              )}
              <OverviewTab monitor={monitor} range={range} historyOff={settings.monitorHistory === 'off'} />
            </>
          )
        )}
      </div>
    </div>
  );
}
