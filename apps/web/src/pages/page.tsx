import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useExplorerState } from '../hooks/useExplorerState';
import { StatusBar } from '../components/layout/StatusBar';
import { Breadcrumbs } from '../components/dashboard/Breadcrumbs';
import { MillerColumns } from '../components/dashboard/MillerColumns';
import { ChangeToneContext } from '../components/common/ChangeFlash';
import { ConflictModal } from '../components/common/ConflictModal';
import { ReferenceCandidatesModal } from '../components/common/ReferenceCandidatesModal';
import { TooltipLayer } from '../components/common/TooltipLayer';
import { Sidebar, type SidebarPanelKind } from '../components/layout/Sidebar';
import { NotificationCenter, type NotificationTab } from '../components/notifications/NotificationCenter';
import { Toast } from '../components/notifications/Toast';
import { SettingsModal, type SettingsSection } from '../components/settings/SettingsModal';
import { QuickJump, type QuickCommand } from '../components/palette/QuickJump';
import { Activity, Bell, ListTree, Lock, LogOut, PanelLeft, Plus, RefreshCw, Settings, Undo2, Unplug } from 'lucide-react';
import { useAuth } from '../components/auth/AuthGate';
import { getServerSettingsSnapshot, saveServerSettings } from '../services/serverSettings';
import { startServerSettingsSync } from '../services/serverSettings';
import { useActivityLog } from '../hooks/useActivityLog';
import { useSidebar } from '../hooks/useSidebar';
import { useSystemLog } from '../hooks/useSystemLog';
import { useMillerKeyboard } from '../hooks/useMillerKeyboard';
import { usePolling } from '../hooks/usePolling';
import { STANDALONE_REFRESH_MS, usePreferences } from '../services/preferences';
import { QueryHistoryPanel } from '../components/query/QueryHistoryPanel';
import { ReferencesPanel } from '../components/references/ReferencesPanel';
import { BookmarksPanel } from '../components/bookmarks/BookmarksPanel';
import { AggregationPanel } from '../components/aggregation/AggregationPanel';
import { replacePipeline } from '../services/savedPipelines';
import { useBookmarks } from '../services/bookmarks';
import { CollectContext, QbeContext, type CollectHandler, type QbeHandler } from '../components/query/QbeMenu';
import { collectToPipeline } from '../services/pipelineCollect';
import { clearQueryHistory, removeQueryHistory, useQueryHistory, type QueryHistoryEntry } from '../services/queryHistory';
import { openSearchPanel } from '../services/queryPanel';
import { api } from '../services/api';
import { setActiveConnection } from '../services/activeConnection';
import { useConnections } from '../hooks/useConnections';
import { WelcomeScreen } from '../components/connections/WelcomeScreen';
import { ConnectionModal, type ConnectionModalTarget } from '../components/connections/ConnectionModal';
import { useConnect } from '../components/connections/useConnect';
import type { MonitorScope } from '../components/monitor/ScopeBar';
import type { MonitorTab } from '../components/monitor/MonitorView';
import { useLastWrites } from '../hooks/useActivity';
import { alertFocus, alertMessage } from '../components/monitor/alerts';
import { pushSystemEvent } from '../services/systemLog';
import { connectionLabel, type MonitorRange } from '../types/explorer';

// Monitor 화면(9단계) — 처음 열 때만 불러온다(Explorer만 쓰면 받지 않는다)
const MonitorView = lazy(() => import('../components/monitor/MonitorView'));

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = {
  root: 'w-full bg-grid-fade',
  // 화면 = [사이드바][컬럼] + 맨 아래 상태바(VSCode처럼 가장자리까지)
  screen: 'h-screen w-full overflow-hidden flex flex-col',
  // 사이드바와 컬럼 사이 틈은 사이드바가 스스로 둔다(접히면 틈도 0)
  body: 'relative flex flex-1 min-h-0 m-3 mb-2',
  columns: 'flex-1 min-w-0 min-h-0 flex flex-col h-full overflow-hidden rounded-2xl bg-white/80 border border-slate-200/60 shadow-panel',
  // Explorer(브레드크럼 + 컬럼) — Monitor를 보는 동안은 숨기기만 한다(돌아오면 경로·컬럼이 그대로)
  explorer: 'flex min-h-0 flex-1 flex-col',
} as const;

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

// connectionId: 이 탭이 쓰는 연결(App이 바뀔 때마다 이 화면을 새로 만든다). null이면 웰컴 화면
export default function ExplorerPage({ connectionId }: { connectionId: string | null }) {
  const connected = connectionId !== null;
  const state = useExplorerState();
  const sidebar = useSidebar();
  const auth = useAuth();
  const activityLog = useActivityLog();
  const systemLog = useSystemLog();
  const [centerOpen, setCenterOpen] = useState(false);
  const [centerTab, setCenterTab] = useState<NotificationTab>('changes');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const openSettings = (section?: SettingsSection) => {
    setCenterOpen(false);
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  // 안전장치 설정(read-only, 보호 대상) — 앱이 켜질 때 받고, 다른 탭·기기에서 바꾸면 따라간다
  useEffect(() => startServerSettingsSync(), []);

  // 저장된 연결 목록(웰컴 화면·사이드바 연결 트리) + 고르기(먼저 접속해 보고 들어간다) + 추가·수정 창
  const connections = useConnections();
  const connectAction = useConnect();
  const [connectionModal, setConnectionModal] = useState<ConnectionModalTarget | null>(null);
  const disconnect = useCallback(() => setActiveConnection(null), []);

  // 초기 연결 — 이 탭이 연결을 골랐을 때만(웰컴 화면에선 데이터를 받지 않는다)
  useEffect(() => {
    if (connected) void state.initialize();
  }, []);

  const {
    connectionStatus,
    activeDatabase,
    activePaths,
    databases,
    collections,
    documents,
    documentPage,
    documentQuery,
    setDocumentQuery,
    applyMongoFilter,
    openDocument,
    isLoading,
    changedPaths,
    changeTone,
    conflict,
    resolveConflict,
    editingId,
    toast,
    uniqueOids,
    referenceCandidates,
    visibleColumns,
    breadcrumbs,
    maxVisibleColumns,
    setMaxVisibleColumns,
    treeMode,
    setTreeMode,
    minColumns,
    defaultColumns,
    columnCountFixed,
    selectDatabase,
    selectCollection,
    selectDocument,
    pushJsonPath,
    popToIndex,
    pushFieldPath,
    pushReference,
    navigateToReference,
    pushReferenceByField,
    navigateToReferenceByField,
    resolveReferenceCandidate,
    dismissReferenceCandidates,
    mutate,
    registerUniqueOid,
    unregisterUniqueOid,
    setEditingId,
    clearChangedPaths,
    dismissToast,
    showToast,
    undo,
    refresh,
    openCollection,
    runQuery,
    queryByExample,
    openLocation,
    isAggregation,
    toggleAggregation,
    openPipeline,
    selectStage,
    selectAggregateResult,
  } = state;
  // 사이드바 Query = 쿼리 기록 패널(누른 버튼 옆에) — 열려 있으면 그 버튼 위치
  const queryHistory = useQueryHistory();
  // 사이드바의 떠 있는 패널(Query 기록 / References) — 한 번에 하나, 누른 버튼 위치에
  const [sidebarPanel, setSidebarPanel] = useState<{ kind: SidebarPanelKind; anchor: DOMRect } | null>(null);
  const closeSidebarPanel = useCallback(() => setSidebarPanel(null), []);
  const historyAnchor = sidebarPanel?.kind === 'history' ? sidebarPanel.anchor : null;
  const referencesAnchor = sidebarPanel?.kind === 'references' ? sidebarPanel.anchor : null;
  const bookmarksAnchor = sidebarPanel?.kind === 'bookmarks' ? sidebarPanel.anchor : null;
  const aggregationAnchor = sidebarPanel?.kind === 'aggregation' ? sidebarPanel.anchor : null;
  const bookmarks = useBookmarks();
  const qbeHandler = useCallback<QbeHandler>((database, collection, conditions) => {
    void queryByExample(database, collection, conditions).then((ok) => ok && openSearchPanel('query'));
  }, [queryByExample]);
  // aggregation 모드 — 결과·원본 필드의 메뉴가 고른 동작을 파이프라인에 모은다(실행은 Run). 알림의 Undo가 되돌린다.
  // ObjectId 참조의 $lookup은 그 ObjectId가 어느 컬렉션 문서인지 먼저 찾아본다(같은 DB여야 한다)
  const aggregationTarget = activePaths[1]?.kind === 'normal' && activePaths[1].columnKind === 'pipeline' ? activePaths[1] : null;
  const viewedStageId = activePaths[2]?.kind === 'normal' && activePaths[2].columnKind === 'output' ? activePaths[2].stageId ?? null : null;
  const collectHandler = useCallback<CollectHandler>((request) => {
    const database = aggregationTarget?.databaseName;
    const collection = aggregationTarget?.collectionName;
    if (!database || !collection) return;
    const finish = (action: Parameters<typeof collectToPipeline>[3]) => {
      const outcome = collectToPipeline(database, collection, viewedStageId, action);
      showToast(outcome.message, outcome.ok ? 'success' : 'error', outcome.ok && outcome.undo ? outcome.undo : false);
    };
    if (request.kind !== 'lookupOid') return finish(request);
    void api.getReferenceInfo(request.oid).then((info) => {
      if (!info) return showToast('Could not find the referenced document — nothing to look up', 'error');
      if (info.databaseName !== database) return showToast(`$lookup works within one database — ${info.collectionName} is in ${info.databaseName}`, 'error');
      const leaf = request.field.split('.').pop() || request.field;
      finish({ kind: 'lookup', from: info.collectionName, localField: request.field, foreignField: '_id', as: `${leaf}_${info.collectionName}` });
    }).catch(() => showToast('Could not look up the reference', 'error'));
  }, [aggregationTarget?.databaseName, aggregationTarget?.collectionName, viewedStageId, showToast]);
  // 지금 컬렉션 — 문서 목록 컬럼이 열려 있으면 그 컬렉션 이름(트리 강조, 알림 센터의 '이 컬렉션' 범위)
  const documentsPath = activePaths.find((p) => p.kind === 'normal' && p.columnKind === 'documents');
  const activeCollectionName = documentsPath?.kind === 'normal' ? documentsPath.collectionName ?? null : null;
  // 지금 열린 문서(알림 센터의 '이 문서' 범위) — 참조를 따라 연 문서 말고, 이 컬렉션에서 고른 문서
  const documentPath = activePaths.find((p) => p.kind === 'normal' && p.columnKind === 'json');
  const activeDocumentId = documentPath?.kind === 'normal' ? documentPath.documentOid ?? null : null;
  // aggregation 모드 — 사이드바 트리는 파이프라인의 컬렉션을 강조하고, 트리·빠른 이동·References에서 컬렉션을 고르면 그 파이프라인을 연다
  const pipelinePath = activePaths[1]?.kind === 'normal' && activePaths[1].columnKind === 'pipeline' ? activePaths[1] : null;
  const treeCollectionName = activeCollectionName ?? pipelinePath?.collectionName ?? null;
  const openCollectionHere = (database: string, collection: string, label: string) =>
    isAggregation ? openPipeline(database, collection, label) : openCollection(database, collection, label);

  // Monitor 화면 — 사이드바 버튼으로 Explorer와 바꿔 본다. 열 때 범위는 Explorer에서 보던 곳(DB·컬렉션)부터
  const [view, setView] = useState<'explorer' | 'monitor'>('explorer');
  const [monitorScope, setMonitorScope] = useState<MonitorScope>({ database: null, collection: null });
  const [monitorTab, setMonitorTab] = useState<MonitorTab>('overview');
  const [monitorRange, setMonitorRange] = useState<MonitorRange>('1h');
  const monitoring = view === 'monitor';
  // Monitor를 보는 동안 사이드바 트리는 문서 수 대신 마지막 쓰기(3m)를 보여 준다
  const lastWrites = useLastWrites(monitoring && api.supportsMonitor);
  const toggleMonitor = () => {
    setSidebarPanel(null);
    if (monitoring) return setView('explorer');
    setMonitorScope({ database: activeDatabase, collection: activeDatabase ? treeCollectionName : null });
    setView('monitor');
  };
  // Monitor를 보는 동안 패널·알림·빠른 이동·설정에서 어딘가로 이동하면 Monitor를 접고 Explorer에서 보여 준다
  const showExplorer = () => setView('explorer');
  // 범위 바의 'Explorer' — 그 DB/컬렉션을 Explorer에서 연다
  const openScopeInExplorer = (scope: MonitorScope) => {
    setView('explorer');
    if (!scope.database) return;
    if (scope.collection) void openCollectionHere(scope.database, scope.collection, scope.collection);
    else void selectDatabase(scope.database);
  };
  // Collections의 '자주 바뀐 문서' → Explorer에서 그 문서
  const openDocumentInExplorer = (database: string, collection: string, documentId: string) => {
    setView('explorer');
    void openLocation({ database, collection, documentId });
  };
  // 알림(9-8a) — 이 연결의 새 실시간 알림을 어느 화면에서든 토스트로, System 탭에도 남긴다.
  // 'Show' = Monitor › Collections에서 그 컬렉션(지워졌으면 DB)
  useEffect(() => {
    if (!api.supportsMonitor) return;
    return api.onAlert((alert) => {
      const message = alertMessage(alert);
      pushSystemEvent('warning', message);
      showToast(message, 'warning', false, {
        label: 'Show',
        run: () => {
          setSidebarPanel(null);
          setMonitorScope(alertFocus(alert));
          setMonitorTab('collections');
          setView('monitor');
        },
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 패널 닫기·토스트는 바뀌지 않는 함수
  }, []);
  const connectionName = (() => {
    const current = connections.connections.find((c) => c.id === connectionId);
    return current ? connectionLabel(current) : 'Server';
  })();

  // 밀러 컬럼 키보드 탐색(↑↓←→ / hjkl, Enter, e, Delete, /) — ?는 단축키 목록(설정 › Keyboard)
  const columnsRef = useRef<HTMLDivElement>(null);
  useMillerKeyboard(columnsRef, () => openSettings('keyboard'));

  // 보이는 것 다시 받기(R · ⟳ · 빠른 이동) — 상태바 ⟳가 돌고, 단독 DB의 주기적 다시 받기는 처음부터 다시 센다
  const [refreshCount, setRefreshCount] = useState(0);
  const refreshNow = useCallback(() => {
    setRefreshCount((n) => n + 1);
    void refresh();
  }, [refresh]);

  // 단독 MongoDB(실시간 없음) — 설정의 주기로 보이는 범위를 다시 받는다. 편집 중·충돌 창이면 쉰다
  const prefs = usePreferences();
  usePolling({
    enabled: connectionStatus === 'polling',
    intervalMs: STANDALONE_REFRESH_MS[prefs.standaloneRefresh],
    paused: editingId !== null || conflict !== null,
    poll: () => refresh({ quiet: true }),
    resetKey: refreshCount,
  });

  // R = 보이는 것 다시 받기. 입력칸 안·모달·수정키 조합(Ctrl+R 브라우저 새로고침 등)·누르고 있기는 건드리지 않는다
  const refreshNowRef = useRef(refreshNow);
  refreshNowRef.current = refreshNow;
  useEffect(() => {
    if (!connected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.key.toLowerCase() !== 'r') return;
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      refreshNowRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [connected]);

  // Ctrl+K(⌘K) = 빠른 이동. 입력칸 안에서도 연다(주소창 검색으로 새지 않게 막는다). 다른 모달이 떠 있으면 무시, 열려 있으면 닫는다
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return;
      const modal = document.querySelector('[aria-modal="true"]');
      if (modal && modal.getAttribute('aria-label') !== 'Quick jump') return;
      e.preventDefault();
      setCenterOpen(false);
      setQuickOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Ctrl+B(⌘B) = 사이드바 전체 ↔ 아이콘 레일(완전히 접혀 있으면 접기 전 단계로) — VSCode와 같은 키.
  // 입력칸 안에선 건드리지 않는다(글자 굵게 등 다른 뜻일 수 있다)
  const sidebarRef = useRef(sidebar);
  sidebarRef.current = sidebar;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b') return;
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      const s = sidebarRef.current;
      if (s.mode === 'collapsed') s.restore();
      else s.setMode(s.mode === 'full' ? 'rail' : 'full');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 빠른 이동의 명령 목록 — 단축키 표시는 Mac이면 ⌘
  const mod = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+';
  const quickCommands: QuickCommand[] = [
    ...(api.canManageConnections ? [{ id: 'new-connection', label: 'New connection', icon: Plus, run: () => setConnectionModal('new') }] : []),
    ...(connected ? [{ id: 'disconnect', label: 'Disconnect this tab', icon: Unplug, run: disconnect }] : []),
    ...(connected ? [{ id: 'monitor', label: monitoring ? 'Back to Explorer' : 'Open Monitor', icon: Activity, run: toggleMonitor }] : []),
    { id: 'settings', label: 'Open settings', icon: Settings, run: () => openSettings() },
    { id: 'notifications', label: 'Show notifications', icon: Bell, run: () => setCenterOpen(true) },
    { id: 'resync', label: "Re-sync what's on screen", icon: RefreshCw, hint: 'R', run: refreshNow },
    { id: 'undo', label: 'Undo last edit', icon: Undo2, hint: `${mod}Z`, run: () => void undo() },
    { id: 'tree', label: treeMode ? 'Switch to column mode' : 'Switch to tree mode', icon: ListTree, run: () => setTreeMode(!treeMode) },
    { id: 'sidebar', label: sidebar.mode === 'full' ? 'Collapse sidebar to icons' : 'Expand sidebar', icon: PanelLeft, hint: `${mod}B`, run: () => sidebar.setMode(sidebar.mode === 'full' ? 'rail' : 'full') },
    {
      id: 'readonly',
      label: getServerSettingsSnapshot().readOnly ? 'Turn read-only mode off' : 'Turn read-only mode on',
      icon: Lock,
      run: () => {
        const current = getServerSettingsSnapshot();
        void saveServerSettings({ ...current, readOnly: !current.readOnly });
      },
    },
    // 로그인 모드일 때만 — 사이드바를 완전히 접어도 여기서 로그아웃할 수 있게
    ...(auth.canLogout ? [{ id: 'signout', label: 'Sign out', icon: LogOut, run: () => void auth.logout() }] : []),
  ];

  // Ctrl+Z(⌘Z) = 마지막 문서·필드 편집 되돌리기(한 단계). 입력칸 안에선 브라우저의 글자 되돌리기를 그대로 두고,
  // 모달(설정·충돌·삭제 확인)이 떠 있을 때도 건드리지 않는다
  const undoRef = useRef(undo);
  undoRef.current = undo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      dismissToast();
      void undoRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissToast]);

  return (
    <div className={styles.root}>
      <div className={styles.screen}>
        {/* [사이드바][컬럼] — 넓은 화면에선 사이드바가 컬럼을 밀어내고, 좁으면 '전체'는 이 영역 위에 뜬다 */}
        <div className={styles.body}>
          <Sidebar
            sidebar={sidebar}
            connected={connected}
            connectionsTree={{
              connections,
              connect: connectAction,
              currentId: connectionId,
              status: connectionStatus,
              canManage: api.canManageConnections,
              onNew: () => setConnectionModal('new'),
              onEdit: setConnectionModal,
              onDisconnect: disconnect,
              onRefresh: refreshNow,
            }}
            databases={databases}
            activeDatabase={activeDatabase}
            // Monitor를 보는 동안 트리는 범위를 강조하고, 트리에서 고르면 범위가 바뀐다(Explorer 경로는 그대로)
            activeCollection={monitoring ? (monitorScope.database === activeDatabase ? monitorScope.collection : null) : treeCollectionName}
            collections={collections}
            onSelectDatabase={async (name) => {
              // DB를 펼치는 건 Explorer가 그 DB의 컬렉션을 받아야 해서 Monitor 중에도 Explorer DB를 바꾼다
              if (monitoring) setMonitorScope({ database: name, collection: null });
              await selectDatabase(name);
            }}
            onOpenCollection={async (database, name, label) => {
              // 좁은 화면에서 떠 있는 사이드바는 고르면 닫는다(열린 경로를 가리므로)
              if (sidebar.isOverlay) sidebar.setMode('rail');
              if (monitoring) return setMonitorScope({ database, collection: name });
              await openCollectionHere(database, name, label);
            }}
            onMutate={mutate}
            onOpenSettings={() => openSettings()}
            monitor={{ active: monitoring, onToggle: toggleMonitor }}
            lastWrites={monitoring && lastWrites.data ? { since: lastWrites.data.since, writes: lastWrites.data.writes, now: lastWrites.now } : null}
            panels={{
              open: sidebarPanel?.kind ?? null,
              onToggle: (kind, anchor) => {
                // 같은 버튼 = 닫기, 다른 버튼 = 그 패널로
                setSidebarPanel((open) => (open?.kind === kind ? null : { kind, anchor }));
              },
            }}
          />

          {/* Miller Columns — 연결을 고르기 전엔 같은 카드 자리에 웰컴 화면, Monitor를 켜면 Monitor 화면 */}
          <div className={styles.columns}>
            {!connected ? (
              <WelcomeScreen
                connections={connections}
                connect={connectAction}
                canManage={api.canManageConnections}
                onNewConnection={() => setConnectionModal('new')}
                onEditConnection={setConnectionModal}
                onOpenQuickJump={() => setQuickOpen(true)}
                onOpenShortcuts={() => openSettings('keyboard')}
              />
            ) : (
            <>
            {monitoring && (
              <Suspense fallback={null}>
                <MonitorView
                  connectionName={connectionName}
                  scope={monitorScope}
                  onScopeChange={setMonitorScope}
                  tab={monitorTab}
                  onTabChange={setMonitorTab}
                  range={monitorRange}
                  onRangeChange={setMonitorRange}
                  lastWrites={lastWrites.data?.writes ?? null}
                  onOpenDocument={openDocumentInExplorer}
                  databases={databases}
                  explorerDatabase={activeDatabase}
                  explorerCollections={collections}
                  onOpenInExplorer={openScopeInExplorer}
                />
              </Suspense>
            )}
            {/* 숨김(display:none) 동안은 키보드 탐색(useMillerKeyboard)·'.' 경로 입력도 쉰다 — 둘 다 보이는지 확인한다 */}
            <div ref={columnsRef} className={monitoring ? 'hidden' : styles.explorer}>
            {/* 브레드크럼 — 첫 칸(DB)은 DB 고르기 드롭다운 */}
            <Breadcrumbs
              breadcrumbs={breadcrumbs}
              onNavigate={(index) => popToIndex(index)}
              openDocument={openDocument}
              onCommitFieldPath={pushFieldPath}
              databases={databases}
              activeDatabase={activeDatabase}
              onSelectDatabase={(name) => void selectDatabase(name)}
              queryText={documentQuery.mongoFilter ? (documentQuery.mongoFilterText || '{…}') : undefined}
            />
            {/* 강조 색: 내 저장 = 연초록, 밖에서 온 변경 = 하늘색 (ChangeFlash가 꺼내 쓴다) */}
            <ChangeToneContext.Provider value={changeTone}>
            {/* Query by example — 필드 행의 메뉴가 부른다. 고르면 쿼리 패널을 열어 칩을 보여 준다 */}
            <QbeContext.Provider value={qbeHandler}>
            <CollectContext.Provider value={isAggregation ? collectHandler : null}>
              <MillerColumns
                visibleColumns={visibleColumns}
                maxVisibleColumns={maxVisibleColumns}
                treeMode={treeMode}
                collections={collections}
                documents={documents}
                documentPage={documentPage}
                documentQuery={documentQuery}
                setDocumentQuery={setDocumentQuery}
                applyMongoFilter={applyMongoFilter}
                openDocument={openDocument}
                isLoading={isLoading}
                changedPaths={changedPaths}
                editingId={editingId}
                activePaths={activePaths}
                selectCollection={selectCollection}
                selectDocument={selectDocument}
                pushJsonPath={pushJsonPath}
                pushReference={pushReference}
                navigateToReference={navigateToReference}
                pushReferenceByField={pushReferenceByField}
                navigateToReferenceByField={navigateToReferenceByField}
                popToIndex={popToIndex}
                mutate={mutate}
                uniqueOids={uniqueOids}
                registerUniqueOid={registerUniqueOid}
                unregisterUniqueOid={unregisterUniqueOid}
                setEditingId={setEditingId}
                clearChangedPaths={clearChangedPaths}
                showToast={showToast}
                openPipeline={openPipeline}
                toggleAggregation={toggleAggregation}
                selectStage={selectStage}
                selectAggregateResult={selectAggregateResult}
              />
            </CollectContext.Provider>
            </QbeContext.Provider>
            </ChangeToneContext.Provider>
            </div>
            </>
            )}
          </div>
        </div>

        <StatusBar
          connected={connected}
          connectionStatus={connectionStatus}
          onRefresh={refreshNow}
          refreshCount={refreshCount}
          pollInterval={prefs.standaloneRefresh}
          maxVisibleColumns={maxVisibleColumns}
          setMaxVisibleColumns={setMaxVisibleColumns}
          treeMode={treeMode}
          setTreeMode={setTreeMode}
          minColumns={minColumns}
          defaultColumns={defaultColumns}
          columnCountFixed={columnCountFixed}
          showColumnControls={!monitoring}
          unreadChanges={activityLog.unread}
          unseenSystem={systemLog.unseen}
          isCenterOpen={centerOpen}
          onToggleCenter={() => setCenterOpen((v) => !v)}
          onOpenSafety={() => openSettings('safety')}
          onOpenQuickJump={() => setQuickOpen(true)}
          onOpenSystem={() => {
            // 연결 상태를 누르면 연결 기록(System 탭) — 이미 그 탭이 열려 있으면 닫는다
            if (centerOpen && centerTab === 'system') setCenterOpen(false);
            else {
              setCenterTab('system');
              setCenterOpen(true);
            }
          }}
        />
      </div>

      {/* 알림 센터 — 상태바의 종으로 여닫는다 */}
      <NotificationCenter
        open={centerOpen}
        onClose={() => setCenterOpen(false)}
        tab={centerTab}
        onTabChange={setCenterTab}
        activity={activityLog}
        system={systemLog}
        activeDatabase={activeDatabase}
        activeCollection={activeCollectionName}
        activeDocumentId={activeDocumentId}
        onNavigate={(entry) => {
          // 이동하면 닫는다 — 오른쪽 컬럼(열리는 문서)을 가리므로
          setCenterOpen(false);
          showExplorer();
          void state.navigateToChange(entry);
        }}
      />

      {/* data-tt 속성이 달린 컨트롤의 툴팁 — 컬럼 밖으로 나가야 해서 body portal */}
      <TooltipLayer />

      {/* 편집하는 동안 다른 곳에서 바뀌었을 때 — 최신 값 유지 / 그래도 덮어쓰기 */}
      <ConflictModal pending={conflict} onOverwrite={() => resolveConflict(true)} onKeepTheirs={() => resolveConflict(false)} />

      {/* 필드 기반 참조(FK) 매칭이 여러 개일 때 고르는 모달 */}
      <ReferenceCandidatesModal
        pending={referenceCandidates}
        onSelect={(candidate) => void resolveReferenceCandidate(candidate)}
        onCancel={dismissReferenceCandidates}
      />

      {/* 빠른 이동 — Ctrl+K(⌘K) 또는 상태바의 돋보기 */}
      <QuickJump
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        databases={databases}
        activeDatabase={activeDatabase}
        commands={quickCommands}
        onOpenDatabase={(name) => {
          showExplorer();
          void selectDatabase(name);
        }}
        onOpenCollection={(database, collection, label) => {
          showExplorer();
          void openCollectionHere(database, collection, label);
        }}
        onOpenObjectId={(oid) => {
          showExplorer();
          void navigateToReference(oid);
        }}
      />

      {/* 설정 창 — 사이드바 맨 아래 톱니바퀴(또는 Ctrl+K) */}
      <SettingsModal
        open={settingsOpen}
        initialSection={settingsSection}
        onClose={() => setSettingsOpen(false)}
        databases={databases}
        onMutate={mutate}
        onOpenDatabase={(database) => {
          showExplorer();
          void selectDatabase(database);
        }}
      />

      {/* 쿼리 기록 — 누르면 지금 컬렉션에(없으면 원래 컬렉션을 열고) 실행, ↗는 원래 컬렉션에서 실행 */}
      {historyAnchor && (
        <QueryHistoryPanel
          anchor={historyAnchor}
          entries={queryHistory}
          current={activeDatabase && activeCollectionName ? { database: activeDatabase, collection: activeCollectionName } : null}
          onApply={(entry: QueryHistoryEntry) => {
            closeSidebarPanel();
            showExplorer();
            const current = activeDatabase && activeCollectionName;
            void runQuery(entry.filter, entry.text, current ? undefined : { database: entry.database, collection: entry.collection })
              .then((ok) => ok && openSearchPanel('query'));
          }}
          onOpenOriginal={(entry) => {
            closeSidebarPanel();
            showExplorer();
            if (sidebar.isOverlay) sidebar.setMode('rail');
            void runQuery(entry.filter, entry.text, { database: entry.database, collection: entry.collection })
              .then((ok) => ok && openSearchPanel('query'));
          }}
          onRemove={removeQueryHistory}
          onClear={clearQueryHistory}
          onClose={closeSidebarPanel}
        />
      )}

      {/* References — 선언한 제목 키·PK·FK 전체. 컬렉션 이름을 누르면 거기로(패널은 닫힌다) */}
      {referencesAnchor && (
        <ReferencesPanel
          anchor={referencesAnchor}
          databases={databases}
          onMutate={mutate}
          onOpenCollection={(database, collection, label) => {
            closeSidebarPanel();
            showExplorer();
            if (sidebar.isOverlay) sidebar.setMode('rail');
            void openCollectionHere(database, collection, label);
          }}
          onClose={closeSidebarPanel}
        />
      )}

      {/* Bookmarks — 누르면 그 자리로(DB·컬렉션·문서·필드). 패널은 닫힌다 */}
      {bookmarksAnchor && (
        <BookmarksPanel
          anchor={bookmarksAnchor}
          bookmarks={bookmarks}
          databases={databases}
          onOpen={(b) => {
            closeSidebarPanel();
            showExplorer();
            if (sidebar.isOverlay) sidebar.setMode('rail');
            void openLocation(b);
          }}
          onClose={closeSidebarPanel}
        />
      )}

      {/* Aggregation — 모든 컬렉션의 저장·최근 파이프라인. 누르면 그 컬렉션의 집계 모드로(저장한 것·버전이면 파이프라인을 바꾸고 Undo) */}
      {aggregationAnchor && (
        <AggregationPanel
          anchor={aggregationAnchor}
          current={pipelinePath?.databaseName && pipelinePath.collectionName ? { database: pipelinePath.databaseName, collection: pipelinePath.collectionName } : null}
          onOpen={(database, collection, stored, label) => {
            closeSidebarPanel();
            showExplorer();
            if (sidebar.isOverlay) sidebar.setMode('rail');
            const replaced = stored ? replacePipeline(database, collection, stored) : null;
            // 같은 파이프라인이 열려 있었으면 고른 스테이지가 없어졌을 수 있다 — 바꿨으면 마지막 스테이지의 출력으로
            void openPipeline(database, collection, collection).then(() => replaced && selectStage(replaced.lastId));
            if (replaced) showToast(`Opened ${label} on ${collection}`, 'success', replaced.undo);
          }}
          onClose={closeSidebarPanel}
        />
      )}

      {/* 연결 추가·수정 — 웰컴 화면, 사이드바 연결 트리, 빠른 이동(Ctrl+K)에서 연다 */}
      <ConnectionModal target={connectionModal} onConnect={connectAction.connect} onClose={() => setConnectionModal(null)} />

      {/* 토스트 — 오른쪽 아래(알림 센터가 열려 있으면 그 위) */}
      <Toast
        toast={toast}
        raised={centerOpen}
        onUndo={() => {
          // 토스트가 자기 되돌리기를 갖고 있으면 그것(파이프라인에 모은 것), 아니면 마지막 편집
          if (toast?.undo) toast.undo();
          else void undo();
          dismissToast();
        }}
        onDismiss={dismissToast}
      />
    </div>
  );
}
