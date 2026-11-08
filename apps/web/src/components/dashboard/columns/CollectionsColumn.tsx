import { useState } from 'react';
import { Folder } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { ActivePath, CollectionSummary, Document, JsonValue, MutationRequest } from '../../../types/explorer';
import { ColumnItem, ColumnSkeletonList } from './ColumnItem';
import { AddItemButton } from './AddItemButton';
import { DropOverlay } from './DropOverlay';
import { InlineSegmentEditor } from '../../editors/InlineSegmentEditor';
import { DeleteConfirmModal } from '../../common/DeleteConfirmModal';
import { ReferenceFieldsManager } from './ReferenceFieldsManager';
import { api } from '../../../services/api';
import { columnListStyles as styles } from './columnListStyles';
import { isPathChanged } from '../../../utils/changedPaths';
import { useFileDrop } from '../../../hooks/useFileDrop';
import { ANIMATION_DISABLE_THRESHOLD_MB } from '../../../utils/motionPresets';
import { canEditIn, useServerSettings } from '../../../services/serverSettings';

// ── Props ─────────────────────────────────────────────────────────────────────

interface CollectionsColumnProps {
  path: ActivePath;
  collections: CollectionSummary[];
  activeCollectionName: string | null;
  isLoading: boolean;
  changedPaths: string[];
  editingId: string | null;
  reduceMotion?: boolean;
  onSelectCollection: (name: string, label: string) => Promise<void>;
  onMutate: (op: MutationRequest) => Promise<unknown>;
  onSetEditingId: (id: string | null) => void;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export function CollectionsColumn({
  path,
  collections,
  activeCollectionName,
  isLoading,
  changedPaths,
  editingId,
  reduceMotion,
  onSelectCollection,
  onMutate,
  onSetEditingId,
}: CollectionsColumnProps) {
  const [deleteTarget, setDeleteTarget] = useState<CollectionSummary | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [refsManagerTarget, setRefsManagerTarget] = useState<{ collectionName: string; suggestedFieldKeys: string[] } | null>(null);
  const databaseName = path.kind === 'normal' ? (path.databaseName ?? '') : '';
  // 안전장치(설정 창 › Safety): read-only거나 이 DB가 보호 대상이면 추가·파일 드롭을, 컬렉션이 보호 대상이면 그 행의 편집을 숨긴다
  const safety = useServerSettings();
  const canEditDb = canEditIn(safety, databaseName);

  // 컬럼 전체에 파일을 드롭하면 "컬렉션 추가" 에디터를 열고 그 파일을 업로드한 것처럼 처리
  const { isDragOver: isColumnDragOver, dragHandlers } = useFileDrop((file) => {
    onSetEditingId('collection:__new__');
    setPendingImportFile(file);
  });

  const handleAddCollection = async (name: string, label: string, description: string) => {
    await onMutate({
      type: 'createCollection',
      database: databaseName,
      collection: { name, label, description },
    });
    onSetEditingId(null);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await onMutate({
      type: 'deleteCollection',
      database: databaseName,
      collection: deleteTarget.name,
    });
    setDeleteTarget(null);
  };

  return (
    // data-nav-col: 키보드 탐색의 컬럼 번호 = 경로 번호(컬렉션은 늘 0)
    <div data-nav-col={0} className={styles.container} {...(canEditDb ? dragHandlers : {})}>
      <DropOverlay visible={isColumnDragOver} label="Drop a file to import as a collection" />

      {/* 헤더 */}
      <div className={styles.header}>
        <div className="relative flex items-center gap-0 leading-none mr-0.5">
          <Folder size={15} className={styles.headerIcon} />
          <span className="absolute pl-[1px] -bottom-[0.2rem] right-0 translate-x-1/2 text-xs font-mono text-slate-500 tabular-nums shrink-0 leading-[0.9] bg-white rounded-s">
            {collections.length}
          </span>
        </div>
      </div>

      {/* 목록 */}
      <div className={styles.list}>
        {isLoading && !collections.length ? (
          <ColumnSkeletonList count={4} />
        ) : (
          collections.map((col) => {
            const isEditing = editingId === `collection:${col.name}`;
            const isHighlighted = isPathChanged(changedPaths, `databases.${databaseName}.collections.${col.name}`);

            if (isEditing) {
              return (
                <InlineSegmentEditor
                  key={col.name}
                  mode="edit"
                  level="collection"
                  initialKey={col.name}
                  siblingKeys={collections.map((c) => c.name).filter((n) => n !== col.name)}
                  onExportRequest={async () => (await api.exportCollection(databaseName, col.name)) as unknown as JsonValue}
                  onSubmit={async (data) => {
                    await onMutate({
                      type: 'renameCollection',
                      database: databaseName,
                      oldName: col.name,
                      newName: data.key,
                      label: data.label ?? data.key,
                    });
                    onSetEditingId(null);
                  }}
                  onCancel={() => onSetEditingId(null)}
                  onDelete={() => setDeleteTarget(col)}
                  onDuplicate={async () => {
                    await onMutate({ type: 'duplicateCollection', database: databaseName, collection: col.name });
                    onSetEditingId(null);
                  }}
                />
              );
            }

            return (
              <ColumnItem
                key={col.name}
                label={col.label}
                meta={`${col.documentCount} docs · ${col.sizeMb === 0.01 ? '< 0.01' : col.sizeMb.toFixed(2)}MB`}
                isActive={activeCollectionName === col.name}
                isHighlighted={isHighlighted}
                isHeavy={col.sizeMb > ANIMATION_DISABLE_THRESHOLD_MB}
                variant="collection"
                reduceMotion={reduceMotion}
                onSelect={() => void onSelectCollection(col.name, col.label)}
                onEdit={canEditIn(safety, databaseName, col.name) ? () => onSetEditingId(`collection:${col.name}`) : undefined}
                onDelete={canEditIn(safety, databaseName, col.name) ? () => setDeleteTarget(col) : undefined}
              />
            );
          })
        )}

        {/* 추가 카드 */}
        {editingId === 'collection:__new__' ? (
          <InlineSegmentEditor
            mode="add"
            level="collection"
            siblingKeys={collections.map((c) => c.name)}
            onSubmit={async (data) => {
              if (data.importedJson && typeof data.importedJson === 'object' && !Array.isArray(data.importedJson)) {
                const imported = data.importedJson as { name?: string; label?: string; description?: string; documents?: Document[] };
                // documents 배열이 없으면 컬렉션 envelope가 아니라 문서 1개를 붙여넣은 것으로 간주하고 그대로 감싼다.
                // _id(있으면 oid든 plain 값이든)는 손대지 않는다 — createCollection 핸들러가
                // ensureDocumentId로 각 문서에 일괄 적용한다
                const documents = Array.isArray(imported.documents)
                  ? imported.documents
                  : [data.importedJson as Document];
                const newCollectionName = imported.name ?? data.key;
                await onMutate({
                  type: 'createCollection',
                  database: databaseName,
                  collection: {
                    name: newCollectionName,
                    label: imported.label ?? data.label ?? data.key,
                    description: imported.description ?? '',
                    documents,
                  },
                });
                onSetEditingId(null);
                // 문서 여러 개를 한 번에 들여온 import만 — 단일 문서 추가엔 굳이 안 띄움
                if (documents.length > 1) {
                  const suggestedFieldKeys = Array.from(new Set(documents.flatMap((d) => Object.keys(d))));
                  setRefsManagerTarget({ collectionName: newCollectionName, suggestedFieldKeys });
                }
                return;
              }
              await handleAddCollection(data.key, data.label ?? data.key, '');
            }}
            onCancel={() => onSetEditingId(null)}
            pendingImportFile={pendingImportFile}
            onPendingImportFileConsumed={() => setPendingImportFile(null)}
          />
        ) : canEditDb && (
          <AddItemButton
            label="Add Collection"
            onClick={() => onSetEditingId('collection:__new__')}
            buttonClassName={styles.addCard}
            iconClassName={styles.addCardIcon}
            textClassName={styles.addCardText}
            reduceMotion={reduceMotion}
          />
        )}
        {!collections.length && canEditDb && (
          <div className={styles.empty}>
            <Folder size={28} className="opacity-30" />
            <span>Drag and drop a JSON file here to create a collection</span>
          </div>
        )}
      </div>

      {/* 삭제 확인 모달 */}
      {deleteTarget && createPortal(
        <DeleteConfirmModal
          isOpen={!!deleteTarget}
          targetType="collection"
          targetLabel={deleteTarget.label}
          confirmText={deleteTarget.name}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />,
        document.body
      )}

      {/* import 직후 일괄 참조(FK) 설정 — 평상시 관리 UI와 동일한 컴포넌트 재사용 */}
      {refsManagerTarget && createPortal(
        <ReferenceFieldsManager
          isOpen
          database={databaseName}
          collection={refsManagerTarget.collectionName}
          referenceFields={collections.find((c) => c.name === refsManagerTarget.collectionName)?.referenceFields ?? {}}
          collections={collections}
          suggestedFieldKeys={refsManagerTarget.suggestedFieldKeys}
          onMutate={onMutate}
          onClose={() => setRefsManagerTarget(null)}
        />,
        document.body
      )}
    </div>
  );
}
