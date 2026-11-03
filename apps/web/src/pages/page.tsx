import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useExplorerState } from '../hooks/useExplorerState';
import { buildForumEjsonSample, buildForumJsonSample } from '../data/sampleData';
import { Header } from '../components/layout/Header';
import { LandingIntro } from '../components/layout/LandingIntro';
import { Footer } from '../components/layout/Footer';
import { Breadcrumbs } from '../components/dashboard/Breadcrumbs';
import { MillerColumns } from '../components/dashboard/MillerColumns';
import { ReferenceCandidatesModal } from '../components/common/ReferenceCandidatesModal';
import { TooltipLayer } from '../components/common/TooltipLayer';
import { SPRING_SOFT } from '../utils/motionPresets';

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = {
  root: 'w-full bg-grid-fade',
  screen: 'h-screen w-full overflow-hidden flex flex-col gap-2 p-4',
  toastPositioner: 'fixed bottom-20 left-1/2 z-[101] -translate-x-1/2 flex items-center gap-3',
  toast: 'flex items-center gap-3 px-4 py-2.5 rounded-2xl text-sm font-medium shadow-elevated backdrop-blur',
  toastSuccess: 'bg-white border border-slate-200 text-slate-800',
  toastError: 'bg-red-500 text-white',
  undoBtn: 'text-emerald-600 font-semibold underline underline-offset-2 hover:text-emerald-700 ml-1',
} as const;

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export default function ExplorerPage() {
  const state = useExplorerState();
  const [showIntro, setShowIntro] = useState(true);

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
    openDocument,
    isLoading,
    changedPaths,
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
  } = state;

  return (
    <div className={styles.root}>
      <div className={styles.screen}>
        {/* 헤더 */}
        <Header
          activeDatabase={activeDatabase}
          connectionStatus={connectionStatus}
          databases={databases}
          selectDatabase={selectDatabase}
          mutate={mutate}
          maxVisibleColumns={maxVisibleColumns}
          setMaxVisibleColumns={setMaxVisibleColumns}
          onRefresh={() => void refresh()}
        />

        {/* Miller Columns */}
        <div className="flex-1 min-h-0 flex flex-col h-full w-full overflow-hidden rounded-2xl bg-white/80 border border-slate-200/60 shadow-panel">
          {/* 브레드크럼 */}
          <Breadcrumbs
            breadcrumbs={breadcrumbs}
            onNavigate={(index) => popToIndex(index)}
            openDocument={openDocument}
            onCommitFieldPath={pushFieldPath}
          />
          <MillerColumns
            visibleColumns={visibleColumns}
            maxVisibleColumns={maxVisibleColumns}
            collections={collections}
            documents={documents}
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
        </div>
      </div>

      {/* data-tt 속성이 달린 컨트롤의 툴팁 — 컬럼 밖으로 나가야 해서 body portal */}
      <TooltipLayer />

      {/* 필드 기반 참조(FK) 매칭이 여러 개일 때 고르는 모달 */}
      <ReferenceCandidatesModal
        pending={referenceCandidates}
        onSelect={(candidate) => void resolveReferenceCandidate(candidate)}
        onCancel={dismissReferenceCandidates}
      />

      {/* 스크롤 시 노출되는 소개 섹션 — X로 닫으면 Footer까지 함께 사라지고 explorer 패널만 남는다 */}
      {showIntro && (
        <div className="flex flex-col min-h-screen w-full">
          <LandingIntro
            onClose={() => setShowIntro(false)}
            onLoadSample={async (kind) => {
              const existingNames = databases.map((d) => d.name);
              const database = kind === 'ejson'
                ? buildForumEjsonSample(existingNames)
                : buildForumJsonSample(existingNames);
              await mutate({ type: 'createDatabase', database });
            }}
          />
          <Footer />
        </div>
      )}

      {/* 토스트 알림 */}
      <div className={styles.toastPositioner} aria-live="assertive">
        <AnimatePresence>
          {toast && (
            <motion.div
              key={toast.id}
              className={`${styles.toast} ${toast.type === 'error' ? styles.toastError : styles.toastSuccess}`}
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
              transition={SPRING_SOFT}
            >
              <span>{toast.message}</span>
              {toast.undoable && (
                <button
                  type="button"
                  className={styles.undoBtn}
                  onClick={() => { void undo(); dismissToast(); }}
                >
                  Undo
                </button>
              )}
              <button
                type="button"
                className="ml-1 opacity-60 hover:opacity-100"
                onClick={dismissToast}
              >
                ✕
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
