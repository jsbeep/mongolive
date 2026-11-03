import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { nextPathId } from '../../../hooks/useExplorerState';
import { Link, Hash, ToggleLeft, KeyRound, ChevronRight, Calendar, Sigma, Binary, Filter, Box } from 'lucide-react';
import { AnimatePresence, m } from 'framer-motion';
import { SPRING_SNAPPY } from '../../../utils/motionPresets';
import { cn } from '../../../utils/cn';
import {
  displayValue,
  idString,
  isEjsonObject,
  isOid as isBsonOid,
  searchText,
  type ActivePath,
  type ReferenceInfo,
  type CollectionSummary,
  type Document,
  type JsonValue,
  type MutationRequest,
  type NormalActivePath,
  type ReferenceActivePath,
  PAGE_SIZE,
} from '../../../types/explorer';
import { api } from '../../../services/api';
import { InlineSegmentEditor } from '../../editors/InlineSegmentEditor';
import { DeleteConfirmModal } from '../../common/DeleteConfirmModal';
import { AddItemButton } from './AddItemButton';
import { CopyBtn } from './CopyBtn';
import { FieldItem } from './FieldItem';
import { HeaderIcon } from './HeaderIcon';
import { DropOverlay } from './DropOverlay';
import { PageRail, PageTransition } from './PageRail';
import { getFieldType, resolveAtPath, getEntries, hasExtendedTypes } from '../../../utils/jsonTree';
import { isPathChanged } from '../../../utils/changedPaths';
import { useFileDrop } from '../../../hooks/useFileDrop';
import { FilterSortToolbar, type SortOption } from './FilterSortToolbar';

// 필드 정렬 옵션 — array 노드는 key가 인덱스라 숫자로, object 노드는 key를 문자열로 비교
const FIELD_SORT_OPTIONS: SortOption[] = [
  { value: 'none', label: 'Default order' },
  { value: 'key-asc', label: 'Key A→Z' },
  { value: 'key-desc', label: 'Key Z→A' },
  { value: 'type', label: 'Type' },
];


// 재귀 중첩 모드 — 스크롤하다 헤더가 위로 지나간 단계들을 모아 보여주는 sticky breadcrumb 높이(px)
const CHAIN_BREADCRUMB_HEIGHT = 36;

// ── Props ─────────────────────────────────────────────────────────────────────

interface JsonLevelColumnProps {
  path: ActivePath;
  openDocument: Document | null;
  visibleLength: number;
  slotIndex: number;
  isLoading: boolean;
  changedPaths: string[];
  editingId: string | null;
  activePaths: ActivePath[];
  activeCollectionName: string | null;
  activeDatabaseName: string | null;
  collections: CollectionSummary[];
  onPushJsonPath: (path: ActivePath) => void;
  onPushReference: (oid: string, fieldKey: string, popIndex?: number) => Promise<void>;
  onNavigateToReference: (oid: string) => Promise<void>;
  onPushReferenceByField: (database: string, collection: string, key: string, value: JsonValue, fieldKey: string, popIndex?: number) => Promise<void>;
  onNavigateToReferenceByField: (database: string, collection: string, key: string, value: JsonValue) => Promise<void>;
  onPopToIndex: (index: number) => void;
  onMutate: (op: MutationRequest) => Promise<unknown>;
  uniqueOids: Set<string>;
  onRegisterUniqueOid: (oid: string) => void;
  onUnregisterUniqueOid: (oid: string) => void;
  onSetEditingId: (id: string | null) => void;
  reduceMotion?: boolean;
  // 인라인 재귀 중첩 모드(컬럼 수 최소일 때) — 이 컬럼 다음 단계를 별도 패널이 아니라
  // 현재 활성 필드 행 바로 아래에 중첩해서 그려야 할 때 그 엘리먼트를 받는다
  nestedChild?: ReactNode | null;
  // true면 이 컬럼 자체가 누군가의 nestedChild로 그려진 것 — flex-1/자체 스크롤 없이
  // 자연 높이로 렌더되어 바깥 패널 하나의 스크롤에 합쳐진다
  isNested?: boolean;
  // true면 이 컬럼이 재귀 중첩 체인의 일부 — 슬라이딩 윈도우 개념이 없으므로
  // "같은 경로 재클릭/비확장 클릭" 시 pop 대상을 윈도우 크기 기준이 아니라
  // 이 컬럼까지로 단순하게 맞춘다
  isInlineChain?: boolean;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export function JsonLevelColumn({
  path,
  openDocument,
  visibleLength,
  slotIndex,
  isLoading,
  changedPaths,
  editingId,
  activePaths,
  activeCollectionName,
  activeDatabaseName,
  collections,
  onPushJsonPath,
  onPushReference,
  onNavigateToReference,
  onPushReferenceByField,
  onNavigateToReferenceByField,
  onPopToIndex,
  onMutate,
  uniqueOids,
  onRegisterUniqueOid,
  onUnregisterUniqueOid,
  onSetEditingId,
  reduceMotion,
  nestedChild = null,
  isNested = false,
  isInlineChain = false,
}: JsonLevelColumnProps) {
  // 위험 영역(의도적으로 더 쪼개지 않음): 아래부터 renderField까지는 refOid/myIndex
  // 파생값, 두 개의 참조-문서 fetch effect, handlePushChild, deleteTarget/
  // docOidForMutate 등이 같은 클로저 안에서 서로를 참조한다. 훅으로 뽑아내려면
  // 이 변수들의 의존성 배열을 전부 정확히 복제해야 하는데, 이 프로젝트엔
  // 테스트가 없어 의존성 배열 하나라도 빠뜨리면(stale closure) 타입체커도
  // 잡아내지 못하고 런타임에서만 드러난다. 그래서 이번 리팩토링에서는
  // 순수 유틸(jsonTree.ts)과 이미 독립적인 서브컴포넌트(CopyBtn/FieldItem/
  // HeaderIcon)만 분리하고, 이 블록은 파일 경계를 넘기지 않았다.
  const refOid     = path.kind === 'reference' && path.ref.kind === 'oid' ? path.ref.oid : null;
  const refField   = path.kind === 'reference' && path.ref.kind === 'field' ? path.ref : null;
  const chainColor = path.kind === 'reference' ? path.chainColor : undefined;
  const chainIndex = path.kind === 'reference' ? path.chainIndex : 0;
  const projectionPath: string[] = path.kind === 'normal'
    ? (path.projectionPath ?? [])
    : path.projectionPath;

  // visibleColumns는 activePaths.slice(-3) 왼쪽 정렬 → slotIndex로 실제 index 역산
  const myIndex = Math.max(0, activePaths.length - visibleLength) + slotIndex;
  const hasPathsAfter = myIndex < activePaths.length - 1;
  // 다음 컬럼이 바로 이 컬럼의 어떤 필드를 펼친 것인지 — 그 필드를 활성 경로로 표시
  const nextActivePath = activePaths[myIndex + 1];

  const [refFullDoc, setRefFullDoc] = useState<Document | null>(null);
  useEffect(() => {
    if (!refOid) { setRefFullDoc(null); return; }
    setRefFullDoc(null);
    api.getFullDocumentById(refOid).then(setRefFullDoc).catch(() => setRefFullDoc(null));
  }, [refOid]);

  // REF 컬럼은 refFullDoc을 refOid가 바뀔 때만 다시 가져온다. 그런데 REF
  // 컬럼 자체에서 필드를 수정해도 refOid는 그대로이므로 위 effect가 다시
  // 실행되지 않아 화면이 갱신되지 않는다 — mutate가 성공한 직후 이 컬럼이
  // 직접 refFullDoc을 다시 가져와서 즉시 반영한다.
  const refreshRefDocument = useCallback(() => {
    if (!refOid) return;
    api.getFullDocumentById(refOid).then(setRefFullDoc).catch(() => setRefFullDoc(null));
  }, [refOid]);

  // 컬럼 헤더 REF 배지에 '{컬렉션}/{문서}' 표시용
  const [refInfo, setRefInfo] = useState<ReferenceInfo | null>(null);
  useEffect(() => {
    if (!refOid) { setRefInfo(null); return; }
    setRefInfo(null);
    api.getReferenceInfo(refOid).then(setRefInfo).catch(() => setRefInfo(null));
  }, [refOid]);

  // 필드 기반 참조(FK) 컬럼 — push 시점에 이미 key:'_id'/documentId로 고정해뒀으므로
  // (resolveReferenceCandidate 참고) 여기서는 모호함 없이 컬렉션-scoped로 바로 가져온다
  const [refFieldFullDoc, setRefFieldFullDoc] = useState<Document | null>(null);
  useEffect(() => {
    if (!refField) { setRefFieldFullDoc(null); return; }
    setRefFieldFullDoc(null);
    api.getFullDocumentByIdInCollection(refField.database, refField.collection, idString(refField.value) ?? '').then(setRefFieldFullDoc).catch(() => setRefFieldFullDoc(null));
  }, [refField?.database, refField?.collection, refField?.value]);

  const refreshRefFieldDocument = useCallback(() => {
    if (!refField) return;
    api.getFullDocumentByIdInCollection(refField.database, refField.collection, idString(refField.value) ?? '').then(setRefFieldFullDoc).catch(() => setRefFieldFullDoc(null));
  }, [refField?.database, refField?.collection, refField?.value]);

  const [refFieldInfo, setRefFieldInfo] = useState<{ collectionLabel: string; documentTitle: string } | null>(null);
  useEffect(() => {
    if (!refField) { setRefFieldInfo(null); return; }
    setRefFieldInfo(null);
    api.getReferenceCandidatesByField(refField.database, refField.collection, refField.key, refField.value).then((candidates) => {
      const candidate = candidates[0];
      if (!candidate) { setRefFieldInfo(null); return; }
      const collectionLabel = collections.find((c) => c.name === refField.collection)?.label ?? refField.collection;
      setRefFieldInfo({ collectionLabel, documentTitle: candidate.documentTitle });
    }).catch(() => setRefFieldInfo(null));
  }, [refField?.database, refField?.collection, refField?.key, refField?.value, collections]);

  const displayDoc = refOid ? refFullDoc : refField ? refFieldFullDoc : openDocument;

  const currentNode: JsonValue = displayDoc ? resolveAtPath(displayDoc, projectionPath) : null;
  const entries = getEntries(currentNode);

  // EJSON 모드(Date/Decimal128/Long 필드 추가 가능 여부) — 이 컬럼이 마운트될 때 현재
  // 노드 하위에 그런 필드나 ObjectId가 이미 있으면 자동으로 켜진 상태로 시작하고, 이후엔
  // 헤더의 토글로 수동 전환한다. mutation으로 currentNode 참조가 바뀌어도 다시 계산하지
  // 않는다 — 그러면 막 켠 토글이 첫 필드를 추가하기도 전에 꺼져버린다.
  const [ejsonMode, setEjsonMode] = useState(() => hasExtendedTypes(currentNode));

  // 필드가 PAGE_SIZE개를 넘으면 페이지로 나눠 그린다(문서 목록과 같은 단위). 문서는 이미 통째로
  // 받아와 있으므로 서버에 묻지 않고 화면에서만 자른다.
  const [entryPage, setEntryPage] = useState(0);

  // 필드 검색/정렬 — 토글 가능한 보조 툴바 (헤더의 필터 아이콘)
  const [isFieldToolbarOpen, setIsFieldToolbarOpen] = useState(false);
  const [fieldFilterText, setFieldFilterText] = useState('');
  const [fieldSortMode, setFieldSortMode] = useState('none');
  const isFieldFilterActive = fieldFilterText.trim().length > 0 || fieldSortMode !== 'none';

  const displayEntries = (() => {
    const needle = fieldFilterText.trim().toLowerCase();
    let result = !needle
      ? entries
      : entries.filter(({ key, value }) => {
          if (key.toLowerCase().includes(needle)) return true;
          // 래퍼 키($numberInt 등)가 검색에 걸리지 않게 표시용 텍스트로 비교
          return searchText(value).toLowerCase().includes(needle);
        });
    if (fieldSortMode === 'key-asc' || fieldSortMode === 'key-desc') {
      const dir = fieldSortMode === 'key-asc' ? 1 : -1;
      const isArray = Array.isArray(currentNode);
      result = [...result].sort((a, b) => (
        isArray ? (Number(a.key) - Number(b.key)) * dir : a.key.localeCompare(b.key) * dir
      ));
    } else if (fieldSortMode === 'type') {
      result = [...result].sort((a, b) => getFieldType(a.value).localeCompare(getFieldType(b.value)));
    }
    return result;
  })();

  const entryPageCount = Math.max(1, Math.ceil(displayEntries.length / PAGE_SIZE));
  // 필드가 지워져 페이지 수가 줄면 마지막 페이지로
  const currentEntryPage = Math.min(entryPage, entryPageCount - 1);
  const visibleEntries = displayEntries.slice(currentEntryPage * PAGE_SIZE, (currentEntryPage + 1) * PAGE_SIZE);

  // 다음 컬럼에 펼쳐져 있는 필드의 key — 그 필드가 다른 페이지에 있으면 그 페이지를 보여준다
  // (브레드크럼/경로 입력으로 깊은 곳에 바로 들어왔을 때 활성 표시가 안 보이는 일이 없게)
  const nextProjection = nextActivePath?.projectionPath;
  const activeChildKey =
    nextProjection && nextProjection.length === projectionPath.length + 1 && projectionPath.every((seg, i) => nextProjection[i] === seg)
      ? nextProjection[nextProjection.length - 1]
      : undefined;
  const activeChildIndex = activeChildKey === undefined ? -1 : displayEntries.findIndex((e) => e.key === activeChildKey);

  // 다른 노드로 옮기거나 검색/정렬을 바꾸면 첫 페이지(또는 활성 필드가 있는 페이지)부터
  useEffect(() => {
    setEntryPage(activeChildIndex >= 0 ? Math.floor(activeChildIndex / PAGE_SIZE) : 0);
    // activeChildIndex는 이 시점의 값만 쓰면 된다 — 사용자가 다른 페이지로 넘긴 뒤 다시 끌려가지 않게
  }, [displayDoc, projectionPath.join('.'), fieldFilterText, fieldSortMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (activeChildIndex >= 0) setEntryPage(Math.floor(activeChildIndex / PAGE_SIZE));
  }, [activeChildKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 페이지를 넘기면 목록 맨 위부터(중첩 컬럼은 자체 스크롤이 없으니 head 컬럼 몫)
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [currentEntryPage]);

  // ── 탐색 — goSibling 패턴 ─────────────────────────────────────────────────

  // 위험: myIndex는 의존성 배열에 직접 없고 slotIndex+activePaths.length로 매
  // 렌더마다 다시 계산된다 — 의존성 배열의 slotIndex/activePaths가 myIndex의
  // 실질적인 소스이므로 지금은 정확하지만, myIndex 계산식을 건드리면서
  // 의존성 배열을 같이 안 고치면 stale closure가 생긴다(타입체커는 못 잡음).
  const handlePushChild = useCallback((key: string) => {
    // isExpandable이 보장된 상태에서 발생
    const nextProj = [...projectionPath, key];
    const nextActivePath = activePaths[myIndex + 1];
    const isSamePath =
      nextActivePath &&
      JSON.stringify(nextActivePath.projectionPath) === JSON.stringify(nextProj) &&
      ((refOid || refField) ? nextActivePath.kind === 'reference' : nextActivePath.kind === 'normal');
    // 같은 경로일때는 뭐 없음
    if (isSamePath) {
      console.log('같은 경로라서 아무것도 안 함', nextProj);
      if (isInlineChain) {
        // 재귀 중첩 모드엔 "보이는 윈도우 크기" 개념이 없으므로 이 컬럼까지만 남기고 접는다
        onPopToIndex(myIndex);
      } else if (slotIndex === 0) {
        // 0번 열이면 pop만 1번
        onPopToIndex(myIndex + (visibleLength - 2));
      }
      return;
    }

    // 기본값: 누른 위치까지 자르기
    onPopToIndex(myIndex);

    if (refOid || refField) {
      const child: ReferenceActivePath = {
        kind: 'reference',
        columnKind: 'json',
        label: key,
        ref: refOid ? { kind: 'oid', oid: refOid } : refField!,
        projectionPath: nextProj,
        chainColor: chainColor ?? '#f59e0b',
        chainIndex,
        comp: { id: nextPathId(), direction: -1 },
      };
      onPushJsonPath(child);
    } else {
      const docOid = path.kind === 'normal' ? (path.documentOid ?? '') : '';
      const child: NormalActivePath = {
        kind: 'normal',
        columnKind: 'json',
        label: key,
        documentOid: docOid,
        projectionPath: nextProj,
        comp: { id: nextPathId(), direction: -1 },
      };
      onPushJsonPath(child);
    }
  }, [activePaths, slotIndex, isInlineChain, path, refOid, refField, chainColor, chainIndex, projectionPath, onPopToIndex, onPushJsonPath]);

  const [deleteTarget, setDeleteTarget] = useState<{ fieldKey: string; value: JsonValue } | null>(null);

  // 문서를 열 때 이미 알고 있던 id를 그대로 재사용한다(문서 내용에서 다시 derive하지
  // 않음) — _id/PK가 둘 다 없는 plain 문서는 컬렉션 안 배열 인덱스로만 식별되는데,
  // 그 인덱스는 여길 열 때 이미 확정돼 있었고 이 컬럼이 열려있는 동안은 그대로 유효하다
  const docOidForMutate = refOid ? refOid : refField ? idString(refField.value) ?? '' : (path.kind === 'normal' ? (path.documentOid ?? '') : '');

  // REF 컬럼(refOid/refField가 있는 경우)은 "현재 선택된 컬렉션/DB"가 아니라 참조 대상
  // 문서가 실제로 속한 컬렉션/DB로 mutate해야 한다. activeDatabaseName/
  // activeCollectionName 그대로 쓰면 참조 대상이 다른 컬렉션(혹은 다른 DB)에
  // 있을 때 거기서 docOidForMutate를 찾지 못해 "Document not found"가 뜬다.
  // refInfo/refFieldInfo는 이미 가져온 참조 대상의 실제 위치.
  const mutateDatabaseName = refOid ? (refInfo?.databaseName ?? null) : refField ? refField.database : activeDatabaseName;
  const mutateCollectionName = refOid ? (refInfo?.collectionName ?? null) : refField ? refField.collection : activeCollectionName;
  // 이 컬럼이 보여주는 컬렉션에 선언된 필드 기반 참조(FK) 설정 — string/number 필드에 LINK 배지를 띄울지 결정
  const referenceFields = collections.find((c) => c.name === mutateCollectionName)?.referenceFields ?? {};

  const isObjectNode = isEjsonObject(currentNode);
  const isArrayNode = Array.isArray(currentNode);
  const canAddField = !!displayDoc && (isObjectNode || isArrayNode);
  // path.comp.id를 포함해야 한다 — 그렇지 않으면 동일한 projectionPath를 가진
  // 다른 컬럼(예: 부모 문서와 그 안의 REF 문서가 둘 다 루트에서 "필드 추가"를
  // 누를 때)이 editingId 문자열이 우연히 같아져서 두 컬럼의 InlineSegmentEditor가
  // 동시에 열린다. editingId는 전역(useExplorerState)에서 하나만 관리되므로
  // 컬럼별로 구분 가능한 값이어야 한다.
  const addFieldEditingId = `field:${path.comp.id}:__new__:${projectionPath.join('.')}`;

  // 컬럼 전체에 파일을 드롭하면 "필드 추가" 에디터를 열고 그 파일을 업로드한 것처럼 처리
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const { isDragOver: isColumnDragOver, dragHandlers } = useFileDrop((file) => {
    if (!canAddField) return;
    onSetEditingId(addFieldEditingId);
    setPendingImportFile(file);
  });

  // 현재 편집 중인 필드가 REF oid라면, InlineSegmentEditor에 어떤 문서를 참조 중인지 전달
  const [editingRefInfo, setEditingRefInfo] = useState<ReferenceInfo | null>(null);
  useEffect(() => {
    if (!editingId) { setEditingRefInfo(null); return; }
    const entry = entries.find(({ key }) => `field:${path.comp.id}:${[...projectionPath, key].join('.')}` === editingId);
    if (!entry || !isBsonOid(entry.value)) { setEditingRefInfo(null); return; }
    const oid = entry.value.$oid;
    let cancelled = false;
    api.getReferenceInfo(oid).then((info) => { if (!cancelled) setEditingRefInfo(info); });
    return () => { cancelled = true; };
  }, [editingId]);

  // ── 재귀 중첩 모드 sticky breadcrumb ─────────────────────────────────────────
  // 최상위(head, isNested=false) 컬럼만 스크롤 컨테이너를 갖고 있어서 여기서만
  // 관찰한다 — 중첩된 각 단계는 자기 헤더 위치에 data-chain-sentinel만 심어두고,
  // 그 헤더가 sticky breadcrumb 영역 위로 스크롤되어 지나가면(IntersectionObserver)
  // 그 단계의 라벨을 breadcrumb에 추가한다.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [passedChain, setPassedChain] = useState<Record<number, string | null>>({});

  useEffect(() => {
    if (isNested || !isInlineChain) return;
    const root = scrollRef.current;
    if (!root) return;
    const sentinels = Array.from(root.querySelectorAll<HTMLElement>('[data-chain-sentinel]'));
    if (!sentinels.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setPassedChain((prev) => {
          const next = { ...prev };
          for (const entry of entries) {
            const depth = Number(entry.target.getAttribute('data-chain-depth'));
            const label = entry.target.getAttribute('data-chain-label') ?? '';
            const passed = entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0);
            next[depth] = passed ? label : null;
          }
          return next;
        });
      },
      { root, threshold: 0, rootMargin: `-${CHAIN_BREADCRUMB_HEIGHT}px 0px 0px 0px` },
    );
    sentinels.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // activePaths.length가 바뀔 때(체인이 늘거나 줄 때)만 sentinel을 다시 찾아 관찰하면 됨
  }, [isNested, isInlineChain, activePaths.length]);

  const chainBreadcrumb = Object.entries(passedChain)
    .filter(([, label]) => label !== null)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, label]) => label as string);

  // ── 필드 렌더러 ────────────────────────────────────────────────────────────

  // 위험: 이 함수 하나가 ① 타입 분류 ② 편집 모드 분기(InlineSegmentEditor
  // onSubmit 안에서 mutation payload까지 구성) ③ 값 표시 switch ④ 클릭 시
  // 탐색/pop 결정 트리를 한 클로저에서 다 처리한다. 위쪽의 entries/
  // projectionPath/editingId/uniqueOids/onMutate/handlePushChild 등 거의
  // 모든 컴포넌트 상태를 읽으므로, 부분만 떼어내도 결국 이 상태를 거의
  // 다 다시 전달해야 해서 분리 이득이 거의 없고 실수할 표면만 늘어난다.
  // 그래서 그대로 두었다 — 수정할 땐 위 4개 책임 중 어디를 건드리는지
  // 먼저 명확히 하고 시작할 것.
  const renderField = (fieldKey: string, value: JsonValue) => {
    const type = getFieldType(value);
    const isId = fieldKey === '_id';
    const editorId = `field:${path.comp.id}:${[...projectionPath, fieldKey].join('.')}`;
    const isEditing = editingId === editorId;
    // 이 필드가 실제로 속한 DB/컬렉션/문서까지 포함한 전체 경로로 정확히 비교한다 —
    // fieldKey만으로 비교하면 다른 문서/컬렉션의 동명 필드(예: 모든 문서의 "name")가
    // 전부 하이라이트되는 버그가 생긴다.
    const fullFieldPath = mutateDatabaseName && mutateCollectionName && docOidForMutate
      ? `databases.${mutateDatabaseName}.collections.${mutateCollectionName}.documents.${docOidForMutate}.${[...projectionPath, fieldKey].join('.')}`
      : null;
    const isHighlighted = fullFieldPath ? isPathChanged(changedPaths, fullFieldPath) : false;
    const isExpandable = type === 'object' || type === 'array';
    // _id가 아닌 단일 {$oid} 필드는, 이 앱이 직접 만든 '고유 oid' 레지스트리에 없으면 DBRef(참조)로 간주
    const isOidRef = type === 'oid' && !isId && !uniqueOids.has((value as { $oid: string }).$oid);
    // 이 컬렉션에 FK로 선언된 필드 — plain string/number 값으로 다른 컬렉션 문서를 가리킴.
    // 배열 안의 요소는 fieldKey가 인덱스("0","1"…)라 그대로는 매칭되지 않는다. 이때는
    // 배열 자체의 키(projectionPath의 마지막 세그먼트)로 선언을 찾는다 — kids: [8834, 8840]
    // 처럼 ID만 담은 배열의 각 요소가 참조로 동작해야 하기 때문.
    const isArrayIndexKey = /^\d+$/.test(fieldKey);
    const refConfigKey = isArrayIndexKey ? projectionPath[projectionPath.length - 1] : fieldKey;
    const fieldRefConfig = !isId && refConfigKey ? referenceFields[refConfigKey] : undefined;
    // 다음 컬럼에 붙일 이름 — 배열 요소면 "0"이 아니라 "kids[0]"으로 보여야 읽힌다
    const refLabel = isArrayIndexKey ? `${refConfigKey}[${fieldKey}]` : fieldKey;
    const isFieldRef = !!fieldRefConfig && (type === 'string' || type === 'number' || type === 'long' || type === 'decimal128');
    // _id만 수정 불가, REF로 분류된 oid도 키 이름/참조 대상을 수정할 수 있어야 함
    const isEditable = !isId;
    const isContainer = type === 'object' || type === 'array';
    // 이 필드를 펼쳐서 다음 컬럼이 열려있는 중인지 — handlePushChild/onPushReference가
    // 만드는 다음 ActivePath와 같은 모양인지로 판별한다(클릭 핸들러와 동일한 비교 기준).
    // isFieldRef는 클릭 시점에야 비동기로 실제 문서를 찾기 때문에 라벨(fieldKey) 일치로
    // 근사 비교한다 — oid처럼 동기 비교는 불가능하지만 활성 표시는 정확도가 중요하지 않음
    const isActive = !nextActivePath ? false
      : isOidRef ? (nextActivePath.kind === 'reference' && nextActivePath.ref.kind === 'oid' && nextActivePath.ref.oid === (value as { $oid: string }).$oid)
      : isFieldRef ? (nextActivePath.kind === 'reference' && nextActivePath.ref.kind === 'field' && nextActivePath.label === refLabel)
      : isExpandable ? (
          JSON.stringify(nextActivePath.projectionPath) === JSON.stringify([...projectionPath, fieldKey]) &&
          ((refOid || refField) ? nextActivePath.kind === 'reference' : nextActivePath.kind === 'normal')
        )
      : false;

    if (isEditing) {
      return (
        <InlineSegmentEditor
          key={fieldKey}
          mode="edit"
          level="field"
          initialKey={fieldKey}
          initialType={
            type === 'array' ? 'Array'
            : type === 'object' ? 'Object'
            : type === 'number' ? 'Number'
            : type === 'boolean' ? 'Boolean'
            : type === 'null' ? 'Null'
            : type === 'oid' ? 'ObjectID'
            : type === 'date' ? 'Date'
            : type === 'decimal128' ? 'Decimal128'
            : type === 'long' ? 'Long'
            // 해석하지 않는 BSON 타입은 Canonical raw JSON으로 편집 — 모르는 래퍼는 모양 그대로 보존된다
            : type === 'opaque' ? 'Object'
            : 'String'
          }
          initialValue={value}
          siblingKeys={entries.map((e) => e.key).filter((k) => k !== fieldKey)}
          activeDatabaseName={mutateDatabaseName}
          currentRefInfo={editingRefInfo}
          referenceFieldConfig={fieldRefConfig}
          ejsonMode={ejsonMode}
          onSubmit={async (data) => {
            if (!mutateCollectionName || !mutateDatabaseName) return;
            await onMutate({
              type: 'mutateField',
              database: mutateDatabaseName,
              collection: mutateCollectionName,
              documentId: docOidForMutate,
              field: {
                path: projectionPath,
                key: fieldKey,
                action: 'edit',
                // 명시적으로 제출된 값(raw 붙여넣기 포함) 우선, container는 미입력 시 기존 값 유지
                value: (() => {
                  if (data.value !== undefined) return data.value;
                  if (isContainer) return value;
                  if (data.type === 'Object') return {} as JsonValue;
                  if (data.type === 'Array') return [] as JsonValue;
                  return null;
                })(),
                nextKey: data.key !== fieldKey ? data.key : undefined,
                // 부모 컨테이너가 array면 'array'를 보내야 한다 — 항상 'object'로
                // 보내면 array 항목을 수정할 때 mockMutate가 "Invalid mutate
                // path"를 던진다(add 액션은 이미 isArrayNode로 분기하고 있었음).
                containerType: isArrayNode ? 'array' : 'object',
              },
            });
            // oid 값 자체가 실제로 바뀐 경우에만 고유 oid 레지스트리 갱신
            // (키 이름만 바꾸거나 그대로 제출한 경우 REF/owned 분류를 건드리지 않음)
            const nextValue = data.value;
            if (isBsonOid(value) && nextValue !== undefined && isBsonOid(nextValue) && value.$oid !== nextValue.$oid) {
              if (uniqueOids.has(value.$oid)) onUnregisterUniqueOid(value.$oid);
              if (data.objectIdMode === 'generate') onRegisterUniqueOid(nextValue.$oid);
            }
            refreshRefDocument();
            refreshRefFieldDocument();
            onSetEditingId(null);
          }}
          onCancel={() => onSetEditingId(null)}
          onDelete={() => setDeleteTarget({ fieldKey, value })}
        />
      );
    }

    const valueContent = (() => {
      if (isFieldRef) {
        return (
          <>
            <span className="flex items-center justify-center gap-1 text-[11px] font-mono pl-1.5 pr-2 py-0.5 rounded-lg bg-cyan-50 text-cyan-600 font-semibold shrink-0">
              <Link size={11} className="text-cyan-400 shrink-0" />
              LINK
            </span>
            <span className="text-[12px] font-mono text-cyan-700 truncate" title={`${fieldRefConfig!.targetCollection}.${fieldRefConfig!.targetKey} = ${displayValue(value)}`}>
              {type === 'string' ? `"${displayValue(value)}"` : displayValue(value)}
            </span>
          </>
        );
      }
      switch (type) {
        case 'string':
          // 긴 문자열은 한 줄로 잘라버리면 확인이 안 되므로, 자연 줄바꿈 + 높이 상한 +
          // 내부 스크롤로 전체를 인라인에서 읽을 수 있게 한다(테두리 없이 목록에 녹아들게).
          return (
            <div
              className="py-1 text-sm font-mono text-emerald-600 max-h-24 overflow-y-auto whitespace-pre-wrap break-words leading-snug"
              title={String(value)}
            >
              {/* 따옴표는 select-none으로 빼서 드래그 선택·복사에 값만 들어가게 한다 */}
              <span className="select-none">"</span>
              {String(value)}
              <span className="select-none">"</span>
            </div>
          );
        case 'number':
          return (
            <>
              <Hash size={12} className="text-sky-400 shrink-0" />
              <span className="text-sm font-mono text-sky-600 truncate">{displayValue(value)}</span>
            </>
          );
        case 'boolean':
          return (
            <>
              <ToggleLeft size={12} className="text-violet-400 shrink-0" />
              <span className="text-sm font-mono text-violet-600 truncate">{String(value)}</span>
            </>
          );
        case 'null':
          return <span className="text-sm font-mono text-slate-400 italic">null</span>;
        case 'object':
          return (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-lg bg-slate-100 text-slate-400 font-medium">
              &#123; {Object.keys(value as Record<string, unknown>).length} &#125;
            </span>
          );
        case 'array':
          return (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-lg bg-slate-100 text-slate-400 font-medium">
              [ {(value as JsonValue[]).length} ]
            </span>
          );
        case 'oid': {
          const oid = (value as { $oid: string }).$oid;
          if (isOidRef) {
            return (
              <>
                <span className="flex items-center justify-center gap-1 text-[11px] font-mono pl-1.5 pr-2 py-0.5 rounded-lg bg-blue-50 text-blue-600 font-semibold shrink-0">
                <Link size={11} className="text-blue-400 shrink-0" />
                  REF
                </span>
                <span className="text-[12px] font-mono text-blue-500 truncate" title={oid}>
                  {oid}
                </span>
                <CopyBtn text={oid} />
              </>
            );
          }
          return (
            <>
              <span className="flex items-center justify-center gap-1 text-[11px] font-mono pl-1.5 pr-2 py-0.5 rounded-lg bg-amber-50 text-amber-600 font-semibold shrink-0">
              <KeyRound size={11} className="text-amber-500 shrink-0" />
                OID
              </span>
              <span className="text-[12px] font-mono text-amber-700 truncate" title={oid}>
                {oid}
              </span>
              <CopyBtn text={oid} />
            </>
          );
        }
        case 'date': {
          const date = displayValue(value);
          return (
            <>
              <span className="flex items-center justify-center gap-1 text-[11px] font-mono pl-1.5 pr-2 py-0.5 rounded-lg bg-rose-50 text-rose-600 font-semibold shrink-0">
                <Calendar size={11} className="text-rose-400 shrink-0" />
                DATE
              </span>
              <span className="text-[12px] font-mono text-rose-700 truncate" title={date}>
                {date}
              </span>
            </>
          );
        }
        case 'decimal128': {
          const dec = displayValue(value);
          return (
            <>
              <span className="flex items-center justify-center gap-1 text-[11px] font-mono pl-1.5 pr-2 py-0.5 rounded-lg bg-teal-50 text-teal-600 font-semibold shrink-0">
                <Sigma size={11} className="text-teal-400 shrink-0" />
                DEC128
              </span>
              <span className="text-[12px] font-mono text-teal-700 truncate" title={dec}>
                {dec}
              </span>
            </>
          );
        }
        case 'long': {
          const long = displayValue(value);
          return (
            <>
              <span className="flex items-center justify-center gap-1 text-[11px] font-mono pl-1.5 pr-2 py-0.5 rounded-lg bg-indigo-50 text-indigo-600 font-semibold shrink-0">
                <Binary size={11} className="text-indigo-400 shrink-0" />
                LONG
              </span>
              <span className="text-[12px] font-mono text-indigo-700 truncate" title={long}>
                {long}
              </span>
            </>
          );
        }
        case 'opaque': {
          const raw = displayValue(value);
          return (
            <>
              <span className="flex items-center justify-center gap-1 text-[11px] font-mono pl-1.5 pr-2 py-0.5 rounded-lg bg-slate-100 text-slate-500 font-semibold shrink-0">
                <Box size={11} className="text-slate-400 shrink-0" />
                BSON
              </span>
              <span className="text-[12px] font-mono text-slate-500 truncate" title={raw}>
                {raw}
              </span>
            </>
          );
        }
      }
    })();

    // expandable/ref → 탐색 (ref는 중복 방지), 비확장 + hasPathsAfter → pop
    const handleClick: (() => void) | null = (() => {
      if (isExpandable || isOidRef || isFieldRef) {
        return () => {
          const refOidToPush = isOidRef ? (value as { $oid: string }).$oid : null;

          if (refOidToPush) {
            const next = activePaths[myIndex + 1];
            if (next?.kind === 'reference' && next.ref.kind === 'oid' && next.ref.oid === refOidToPush) return;
            // 실제로 참조가 존재함이 확인된 후에만 하위 컬럼을 닫음 (오인된 REF 클릭 시 아무 변화 없도록)
            void onPushReference(refOidToPush, fieldKey, myIndex >= 0 ? myIndex : undefined);
            return;
          }
          if (isFieldRef) {
            // 후보가 여러 개일 수 있어(중복 PK) 미리 dedup하지 않고 항상 다시 조회한다
            void onPushReferenceByField(mutateDatabaseName ?? '', fieldRefConfig!.targetCollection, fieldRefConfig!.targetKey, value, refLabel, myIndex >= 0 ? myIndex : undefined);
            return;
          }
          handlePushChild(fieldKey);
        };
      }
      // 비확장 필드 클릭 시 하위 컬럼이 열려있으면 닫기
      if (hasPathsAfter && isInlineChain) return () => onPopToIndex(myIndex);
      if (hasPathsAfter && slotIndex === 0) return () => onPopToIndex(activePaths.length - 2);
      return null;
    })();

    // 재귀 중첩 모드에서 이 필드가 현재 펼쳐진 다음 단계라면, 별도 패널이 아니라
    // 이 필드 행 바로 아래에 다음 단계 JsonLevelColumn(nestedChild)을 끼워 넣는다
    if (isActive && nestedChild) {
      return (
        <div key={fieldKey} className="flex flex-col gap-1.5">
          <FieldItem
            fieldKey={fieldKey}
            isId={isId}
            isExpandable={isExpandable || isOidRef || isFieldRef}
            isEditable={isEditable}
            isHighlighted={isHighlighted}
            isActive={isActive}
            reduceMotion={reduceMotion}
            reserveEditWidth={type === 'string' && !isFieldRef}
            onEdit={() => onSetEditingId(editorId)}
            onClick={handleClick}
          >
            {valueContent}
          </FieldItem>
          <AnimatePresence initial={false}>
            <m.div
              key="nested"
              initial={{ opacity: 0, scaleY: 0.92 }}
              animate={{ opacity: 1, scaleY: 1 }}
              exit={{ opacity: 0, scaleY: 0.92 }}
              style={{ transformOrigin: 'top' }}
              transition={reduceMotion ? { duration: 0 } : SPRING_SNAPPY}
              className="ml-4 flex flex-col rounded-2xl border border-slate-200/80 bg-white/70 shadow-sm overflow-hidden"
            >
              {nestedChild}
            </m.div>
          </AnimatePresence>
        </div>
      );
    }

    return (
      <FieldItem
        key={fieldKey}
        fieldKey={fieldKey}
        isId={isId}
        isExpandable={isExpandable || isOidRef || isFieldRef}
        isEditable={isEditable}
        isHighlighted={isHighlighted}
        isActive={isActive}
        reduceMotion={reduceMotion}
        reserveEditWidth={type === 'string' && !isFieldRef}
        onEdit={() => onSetEditingId(editorId)}
        onClick={handleClick}
      >
        {valueContent}
      </FieldItem>
    );
  };

  // ── 렌더 ──────────────────────────────────────────────────────────────────

  return (
    <div className={cn('relative flex flex-col min-h-0', !isNested && 'flex-1')} {...dragHandlers}>
      <DropOverlay visible={isColumnDragOver} label={canAddField ? 'Drop a file to import as a field' : 'Fields cannot be added here'} />
      {/* Ref 강조 — 상단 컬러 바 */}
      {chainColor && (
        <div
          className="h-[3px] w-full shrink-0"
          style={{ background: `linear-gradient(90deg, ${chainColor} 0%, ${chainColor}40 100%)` }}
        />
      )}

      {/* 재귀 중첩 단계의 헤더 위치 마커 — 최상위 컬럼의 IntersectionObserver가 관찰 */}
      {isNested && (
        <div data-chain-sentinel data-chain-depth={myIndex} data-chain-label={path.label} className="h-px w-full" aria-hidden="true" />
      )}

      {/* 헤더 */}
      <div className="shrink-0 flex items-center gap-2.5 px-4 h-12 border-b border-slate-100/80">
        <div className="relative flex items-center gap-0 leading-none mr-0.5">
          <HeaderIcon node={currentNode} />
          <span className="absolute pl-[1px] -bottom-[0.2rem] right-0.5 translate-x-1/2 text-xs font-mono text-slate-500 tabular-nums shrink-0 leading-[0.9] bg-white rounded-s">
            {isFieldFilterActive ? `${displayEntries.length}/${entries.length}` : entries.length}
          </span>
        </div>
        <span className="text-sm font-semibold text-slate-700 truncate flex-1">{path.label}</span>
        {chainColor && (
          <button
            type="button"
            className="text-[10px] font-bold px-2 py-0.5 rounded-md text-white shrink-0 tracking-wide truncate max-w-[160px] cursor-pointer hover:opacity-80 transition-opacity"
            style={{ backgroundColor: chainColor }}
            data-tt={
              refInfo ? `Referenced document — click to open ${refInfo.collectionLabel}/${refInfo.documentTitle}`
              : refFieldInfo ? `Referenced document — click to open ${refFieldInfo.collectionLabel}/${refFieldInfo.documentTitle}`
              : undefined
            }
            onClick={() => {
              if (refOid) void onNavigateToReference(refOid);
              else if (refField) void onNavigateToReferenceByField(refField.database, refField.collection, refField.key, refField.value);
            }}
          >
            {refInfo ? `${refInfo.collectionLabel}/${refInfo.documentTitle}`
              : refFieldInfo ? `${refFieldInfo.collectionLabel}/${refFieldInfo.documentTitle}`
              : 'REF'}
          </button>
        )}
        <button
          type="button"
          className={cn(
            'text-[10px] font-bold px-2 py-0.5 rounded-md shrink-0 tracking-wide transition-colors',
            ejsonMode ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400',
          )}
          data-tt="EJSON mode — offer Date / Decimal128 / Long as field types when adding or editing"
          onClick={() => setEjsonMode((v) => !v)}
        >
          EJSON
        </button>
        <button
          type="button"
          className={cn(
            'relative p-1.5 rounded-lg transition-colors shrink-0',
            isFieldToolbarOpen || isFieldFilterActive ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600',
          )}
          data-tt="Filter / sort fields at this level"
          onClick={() => setIsFieldToolbarOpen((v) => !v)}
        >
          {isFieldFilterActive && !isFieldToolbarOpen && (
            <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500" />
          )}
          <Filter size={13} />
        </button>
      </div>

      {/* 필드 검색/정렬 툴바 */}
      {isFieldToolbarOpen && (
        <FilterSortToolbar
          filterText={fieldFilterText}
          onFilterTextChange={setFieldFilterText}
          filterPlaceholder="Search field key or value…"
          sortValue={fieldSortMode}
          onSortChange={setFieldSortMode}
          sortOptions={FIELD_SORT_OPTIONS}
        />
      )}

      {/* 목록 + 오른쪽 페이지 레일 */}
      <div className={cn('flex min-h-0', !isNested && 'flex-1')}>
      <div ref={scrollRef} className={cn('flex-1 min-w-0 px-2 py-2 flex flex-col gap-0.5', isNested ? 'min-h-0' : 'overflow-y-auto min-h-0')}>
        {!isNested && isInlineChain && chainBreadcrumb.length > 0 && (
          <div
            className="sticky -top-2 z-10 shrink-0 -mx-2 -mt-2 mb-1 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap bg-white/95 backdrop-blur px-3 border-b border-slate-100/80"
            style={{ height: CHAIN_BREADCRUMB_HEIGHT }}
          >
            {chainBreadcrumb.map((label, i) => (
              <span key={i} className="flex items-center gap-1 shrink-0">
                {i > 0 && <ChevronRight size={12} className="text-slate-300 shrink-0" />}
                <span className="text-xs font-medium text-slate-500 truncate max-w-[140px]">{label}</span>
              </span>
            ))}
          </div>
        )}
        {isLoading && !entries.length ? (
          <p className="flex-1 flex items-center justify-center text-sm text-slate-400 py-10">Loading…</p>
        ) : !displayDoc ? (
          <p className="flex-1 flex items-center justify-center text-sm text-slate-400 py-10">Select a document</p>
        ) : entries.length > 0 && !displayEntries.length ? (
          <p className="flex-1 flex items-center justify-center text-sm text-slate-400 py-10">No fields match the filter</p>
        ) : (
          <PageTransition pageKey={currentEntryPage} disabled={reduceMotion} className="flex flex-col gap-0.5">
            {/* initial={false}: 페이지째 펼쳐지므로 행마다 따로 나타나는 애니메이션은 생략(행 수만큼 드는 비용).
                이 페이지를 보는 중에 새로 추가된 필드는 그대로 애니메이션된다. */}
            <AnimatePresence initial={false}>
              {visibleEntries.map(({ key, value }) => renderField(key, value))}
            </AnimatePresence>
          </PageTransition>
        )}


        {/* 필드 추가 — object/array 노드면 depth 무관하게 항상 표시 */}
        {canAddField && (
          editingId === addFieldEditingId ? (
            <InlineSegmentEditor
              mode="add"
              level="field"
              siblingKeys={entries.map((e) => e.key)}
              initialKey={isArrayNode ? String(entries.length) : undefined}
              lockKey={isArrayNode}
              activeDatabaseName={mutateDatabaseName}
              ejsonMode={ejsonMode}
              onSubmit={async (data) => {
                if (!mutateCollectionName || !mutateDatabaseName) return;
                // array는 key를 현재 length로 고정 (next index)
                const addKey = isArrayNode ? String(entries.length) : data.key;
                await onMutate({
                  type: 'mutateField',
                  database: mutateDatabaseName,
                  collection: mutateCollectionName,
                  documentId: docOidForMutate,
                  field: {
                    path: projectionPath,
                    key: addKey,
                    action: 'add',
                    value: data.value ?? null,
                    containerType: isArrayNode ? 'array' : 'object',
                  },
                });
                // 새로 생성된 고유 oid는 레지스트리에 등록 (DBRef로 오인되지 않도록)
                if (data.objectIdMode === 'generate' && data.value !== undefined && isBsonOid(data.value)) {
                  onRegisterUniqueOid(data.value.$oid);
                }
                refreshRefDocument();
                refreshRefFieldDocument();
                onSetEditingId(null);
              }}
              onCancel={() => onSetEditingId(null)}
              pendingImportFile={pendingImportFile}
              onPendingImportFileConsumed={() => setPendingImportFile(null)}
            />
          ) : (
            <AddItemButton
              label={isArrayNode ? 'Add Item' : 'Add Field'}
              onClick={() => onSetEditingId(addFieldEditingId)}
              buttonClassName="group flex items-center gap-3 px-4 py-3.5 rounded-2xl cursor-pointer hover:bg-slate-50/80 active:bg-slate-100/50 transition-colors"
              iconClassName="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center border border-dashed border-slate-300 text-slate-400 group-hover:border-emerald-300 group-hover:text-emerald-500 transition-colors"
              textClassName="text-sm font-medium text-slate-400 group-hover:text-emerald-600 transition-colors"
              reduceMotion={reduceMotion}
            />
          )
        )}
      </div>
      <PageRail
        page={currentEntryPage}
        pageCount={entryPageCount}
        markedPage={activeChildIndex >= 0 ? Math.floor(activeChildIndex / PAGE_SIZE) : undefined}
        onChange={setEntryPage}
        // 중첩 컬럼은 자체 스크롤이 없다 — head 컬럼의 스크롤 안에서 위에 붙어 따라오게
        className={isNested ? 'self-start sticky top-0' : undefined}
      />
      </div>

      {/* 삭제 확인 모달 — createPortal로 최상위에 렌더 */}
      {deleteTarget && createPortal(
        <DeleteConfirmModal
          isOpen
          targetType="field"
          targetLabel={deleteTarget.fieldKey}
          onConfirm={async () => {
            if (!mutateCollectionName || !mutateDatabaseName) return;
            await onMutate({
              type: 'mutateField',
              database: mutateDatabaseName,
              collection: mutateCollectionName,
              documentId: docOidForMutate,
              field: { path: projectionPath, key: deleteTarget.fieldKey, action: 'delete', containerType: isArrayNode ? 'array' : 'object' },
            });
            // 삭제되는 필드가 이 앱이 만든 고유 oid였다면 레지스트리에서 함께 제거
            if (isBsonOid(deleteTarget.value) && uniqueOids.has(deleteTarget.value.$oid)) {
              onUnregisterUniqueOid(deleteTarget.value.$oid);
            }
            refreshRefDocument();
            refreshRefFieldDocument();
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />,
        document.body,
      )}
    </div>
  );
}
