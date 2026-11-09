import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Bell, ListTree, Lock, LogOut, PanelLeft, RefreshCw, Settings, Undo2 } from 'lucide-react';
import { useAuth } from '../components/auth/AuthGate';
import { getServerSettingsSnapshot, saveServerSettings } from '../services/serverSettings';
import { MIN_VISIBLE_COLUMNS } from '../hooks/useExplorerState';
import { startServerSettingsSync } from '../services/serverSettings';
import { useActivityLog } from '../hooks/useActivityLog';
import { useSidebar } from '../hooks/useSidebar';
import { useSystemLog } from '../hooks/useSystemLog';
import { useMillerKeyboard } from '../hooks/useMillerKeyboard';
import { QueryHistoryPanel } from '../components/query/QueryHistoryPanel';
import { ReferencesPanel } from '../components/references/ReferencesPanel';
import { BookmarksPanel } from '../components/bookmarks/BookmarksPanel';
import { useBookmarks } from '../services/bookmarks';
import { QbeContext, type QbeHandler } from '../components/query/QbeMenu';
import { clearQueryHistory, removeQueryHistory, useQueryHistory, type QueryHistoryEntry } from '../services/queryHistory';
import { openSearchPanel } from '../services/queryPanel';
import { dataSourceKind } from '../services/api';

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = {
  root: 'w-full bg-grid-fade',
  // 화면 = [사이드바][컬럼] + 맨 아래 상태바(VSCode처럼 가장자리까지)
  screen: 'h-screen w-full overflow-hidden flex flex-col',
  // 사이드바와 컬럼 사이 틈은 사이드바가 스스로 둔다(접히면 틈도 0)
  body: 'relative flex flex-1 min-h-0 m-3 mb-2',
  columns: 'flex-1 min-w-0 min-h-0 flex flex-col h-full overflow-hidden rounded-2xl bg-white/80 border border-slate-200/60 shadow-panel',
} as const;

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function ExplorerPage() {
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

  // 초기 연결
  useEffect(() => {
    void state.initialize();
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
    undo,
    refresh,
    openCollection,
    runQuery,
    queryByExample,
    openLocation,
  } = state;
  // 사이드바 Query = 쿼리 기록 패널(누른 버튼 옆에) — 열려 있으면 그 버튼 위치
  const queryHistory = useQueryHistory();
  // 사이드바의 떠 있는 패널(Query 기록 / References) — 한 번에 하나, 누른 버튼 위치에
  const [sidebarPanel, setSidebarPanel] = useState<{ kind: SidebarPanelKind; anchor: DOMRect } | null>(null);
  const closeSidebarPanel = useCallback(() => setSidebarPanel(null), []);
  const historyAnchor = sidebarPanel?.kind === 'history' ? sidebarPanel.anchor : null;
  const referencesAnchor = sidebarPanel?.kind === 'references' ? sidebarPanel.anchor : null;
  const bookmarksAnchor = sidebarPanel?.kind === 'bookmarks' ? sidebarPanel.anchor : null;
  const bookmarks = useBookmarks();
  const qbeHandler = useCallback<QbeHandler>((database, collection, conditions) => {
    void queryByExample(database, collection, conditions).then((ok) => ok && openSearchPanel('query'));
  }, [queryByExample]);
  // 지금 컬렉션 — 문서 목록 컬럼이 열려 있으면 그 컬렉션 이름(트리 강조, 알림 센터의 '이 컬렉션' 범위)
  const documentsPath = activePaths.find((p) => p.kind === 'normal' && p.columnKind === 'documents');
  const activeCollectionName = documentsPath?.kind === 'normal' ? documentsPath.collectionName ?? null : null;
  // 지금 열린 문서(알림 센터의 '이 문서' 범위) — 참조를 따라 연 문서 말고, 이 컬렉션에서 고른 문서
  const documentPath = activePaths.find((p) => p.kind === 'normal' && p.columnKind === 'json');
  const activeDocumentId = documentPath?.kind === 'normal' ? documentPath.documentOid ?? null : null;

  // 밀러 컬럼 키보드 탐색(↑↓←→ / hjkl, Enter, e, Delete, /) — ?는 단축키 목록(설정 › Keyboard)
  const columnsRef = useRef<HTMLDivElement>(null);
  useMillerKeyboard(columnsRef, () => openSettings('keyboard'));

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
  const isTreeMode = maxVisibleColumns === MIN_VISIBLE_COLUMNS;
  const quickCommands: QuickCommand[] = [
    { id: 'settings', label: 'Open settings', icon: Settings, run: () => openSettings() },
    { id: 'notifications', label: 'Show notifications', icon: Bell, run: () => setCenterOpen(true) },
    { id: 'resync', label: "Re-sync what's on screen", icon: RefreshCw, run: () => void refresh() },
    { id: 'undo', label: 'Undo last edit', icon: Undo2, hint: `${mod}Z`, run: () => void undo() },
    { id: 'tree', label: isTreeMode ? 'Switch to column mode' : 'Switch to tree mode', icon: ListTree, run: () => setMaxVisibleColumns(isTreeMode ? 3 : MIN_VISIBLE_COLUMNS) },
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
            databases={databases}
            activeDatabase={activeDatabase}
            activeCollection={activeCollectionName}
            collections={collections}
            onSelectDatabase={selectDatabase}
            onOpenCollection={async (database, name, label) => {
              // 좁은 화면에서 떠 있는 사이드바는 고르면 닫는다(열린 경로를 가리므로)
              if (sidebar.isOverlay) sidebar.setMode('rail');
              await openCollection(database, name, label);
            }}
            onMutate={mutate}
            onOpenSettings={() => openSettings()}
            panels={{
              open: sidebarPanel?.kind ?? null,
              canQuery: dataSourceKind === 'remote',
              // 같은 버튼 = 닫기, 다른 버튼 = 그 패널로
              onToggle: (kind, anchor) => setSidebarPanel((open) => (open?.kind === kind ? null : { kind, anchor })),
            }}
          />

          {/* Miller Columns */}
          <div ref={columnsRef} className={styles.columns}>
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
              <MillerColumns
                visibleColumns={visibleColumns}
                maxVisibleColumns={maxVisibleColumns}
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
              />
            </QbeContext.Provider>
            </ChangeToneContext.Provider>
          </div>
        </div>

        <StatusBar
          connectionStatus={connectionStatus}
          onRefresh={() => void refresh()}
          maxVisibleColumns={maxVisibleColumns}
          setMaxVisibleColumns={setMaxVisibleColumns}
          unreadChanges={activityLog.unread}
          unseenErrors={systemLog.unseenErrors}
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
        onOpenDatabase={(name) => void selectDatabase(name)}
        onOpenCollection={(database, collection, label) => void openCollection(database, collection, label)}
        onOpenObjectId={(oid) => void navigateToReference(oid)}
      />

      {/* 설정 창 — 사이드바 맨 아래 톱니바퀴(또는 Ctrl+K) */}
      <SettingsModal
        open={settingsOpen}
        initialSection={settingsSection}
        onClose={() => setSettingsOpen(false)}
        databases={databases}
        onMutate={mutate}
        onOpenDatabase={(database) => void selectDatabase(database)}
      />

      {/* 쿼리 기록 — 누르면 지금 컬렉션에(없으면 원래 컬렉션을 열고) 실행, ↗는 원래 컬렉션에서 실행 */}
      {historyAnchor && (
        <QueryHistoryPanel
          anchor={historyAnchor}
          entries={queryHistory}
          current={activeDatabase && activeCollectionName ? { database: activeDatabase, collection: activeCollectionName } : null}
          onApply={(entry: QueryHistoryEntry) => {
            closeSidebarPanel();
            const current = activeDatabase && activeCollectionName;
            void runQuery(entry.filter, entry.text, current ? undefined : { database: entry.database, collection: entry.collection })
              .then((ok) => ok && openSearchPanel('query'));
          }}
          onOpenOriginal={(entry) => {
            closeSidebarPanel();
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
            if (sidebar.isOverlay) sidebar.setMode('rail');
            void openCollection(database, collection, label);
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
            if (sidebar.isOverlay) sidebar.setMode('rail');
            void openLocation(b);
          }}
          onClose={closeSidebarPanel}
        />
      )}

      {/* 토스트 — 오른쪽 아래(알림 센터가 열려 있으면 그 위) */}
      <Toast
        toast={toast}
        raised={centerOpen}
        onUndo={() => { void undo(); dismissToast(); }}
        onDismiss={dismissToast}
      />
    </div>
  );
}
