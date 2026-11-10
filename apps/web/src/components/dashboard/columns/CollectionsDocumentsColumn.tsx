import { AnimatePresence, m } from 'framer-motion';
import type { ActivePath, CollectionSummary, DocumentSummary, MutationRequest } from '../../../types/explorer';
import { CollectionsColumn } from './CollectionsColumn';
import { DocumentsColumn, type DocumentListControls } from './DocumentsColumn';
import { SPRING_SOFT } from '../../../utils/motionPresets';

// 컬렉션↔문서 전환 — 문서로 들어갈 땐 오른쪽에서, 뒤로 갈 땐 왼쪽에서 슬라이드
const panelVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? '40%' : '-40%', opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? '-40%' : '40%', opacity: 0 }),
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface CollectionsDocumentsColumnProps {
  collectionsPath: ActivePath;
  documentsPath: ActivePath | null;
  collections: CollectionSummary[];
  documents: DocumentSummary[];
  documentList: DocumentListControls;
  activeCollectionName: string | null;
  activeDocumentOid: string | null;
  activeDatabaseName: string | null;
  isLoading: boolean;
  changedPaths: string[];
  editingId: string | null;
  reduceMotion?: boolean;
  onSelectCollection: (name: string, label: string) => Promise<void>;
  onSelectDocument: (oid: string, title: string) => Promise<void>;
  onMutate: (op: MutationRequest) => Promise<unknown>;
  onSetEditingId: (id: string | null) => void;
  onBackToCollections: () => void;
  // Collections 헤더의 Aggregation 버튼
  aggregation?: { active: boolean; onToggle: () => void; onOpen: (database: string, collection: string, label: string) => void };
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────
// 컬럼 2개(최소) 모드에서 Collections/Documents를 별도 패널로 나누지 않고 한
// 패널 안에서 navigate — 컬렉션을 고르면 같은 패널이 문서 목록으로 바뀌고,
// 문서 목록 맨 위 뒤로가기 버튼으로 다시 컬렉션 목록으로 돌아간다.
export function CollectionsDocumentsColumn({
  collectionsPath,
  documentsPath,
  collections,
  documents,
  documentList,
  activeCollectionName,
  activeDocumentOid,
  activeDatabaseName,
  isLoading,
  changedPaths,
  editingId,
  reduceMotion,
  onSelectCollection,
  onSelectDocument,
  onMutate,
  onSetEditingId,
  onBackToCollections,
  aggregation,
}: CollectionsDocumentsColumnProps) {
  const direction = documentsPath ? 1 : -1;

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <AnimatePresence initial={false} custom={direction} mode="popLayout">
        <m.div
          key={documentsPath ? 'documents' : 'collections'}
          custom={direction}
          variants={panelVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={reduceMotion ? { duration: 0 } : SPRING_SOFT}
          className="absolute inset-0 flex flex-col"
        >
          {documentsPath ? (
            <DocumentsColumn
              path={documentsPath}
              documents={documents}
              documentList={documentList}
              collections={collections}
              activeDocumentOid={activeDocumentOid}
              isLoading={isLoading}
              changedPaths={changedPaths}
              editingId={editingId}
              activeCollectionName={activeCollectionName}
              activeDatabaseName={activeDatabaseName}
              reduceMotion={reduceMotion}
              onSelectDocument={onSelectDocument}
              onMutate={onMutate}
              onSetEditingId={onSetEditingId}
              onBack={onBackToCollections}
            />
          ) : (
            <CollectionsColumn
              path={collectionsPath}
              collections={collections}
              activeCollectionName={activeCollectionName}
              isLoading={isLoading}
              changedPaths={changedPaths}
              editingId={editingId}
              reduceMotion={reduceMotion}
              onSelectCollection={onSelectCollection}
              onMutate={onMutate}
              onSetEditingId={onSetEditingId}
              aggregation={aggregation}
            />
          )}
        </m.div>
      </AnimatePresence>
    </div>
  );
}
