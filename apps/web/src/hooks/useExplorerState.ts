import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import { useToast, type ToastMessage } from './useToast';
import { useUniqueOidRegistry } from './useUniqueOidRegistry';
import { CHANGE_FLASH_MS } from '../components/common/ChangeFlash';
import {
  collectionKey,
  compareKey,
  idString,
  isContainer,
  summarizeDocument,
  type ActivePath,
  type CollectionSummary,
  type ConnectionStatus,
  type DatabaseSummary,
  type Document,
  type DocumentPage,
  type DocumentSort,
  type DocumentSummary,
  type ExplorerPathSegment,
  type JsonValue,
  type LiveChange,
  type LiveLogEntry,
  type LiveStatus,
  type MutationRequest,
  type MutationResult,
  type FieldReferenceCandidate,
  type NormalActivePath,
  type ReferenceActivePath,
  type RefLocator,
} from '../types/explorer';

export type { ToastMessage };

// ── 상수 ──────────────────────────────────────────────────────────────────────

const CHAIN_COLORS = ['#f59e0b', '#8b5cf6', '#3b82f6', '#ec4899', '#14b8a6'] as const;

export const MIN_VISIBLE_COLUMNS = 2;
export const MAX_VISIBLE_COLUMNS = 6;

let pathIdCounter = 0;
export const nextPathId = () => ++pathIdCounter;

// 참조를 클릭했을 때, 그 대상 문서를 이미 보여주고 있는 컬럼이 경로 안에 있으면 그 인덱스.
// 없으면 -1.
//
// 왜 필요한가 — 참조를 따라가다 보면 출발한 문서로 되돌아오는 경우가 흔하다
// (users → submitted[0] → 그 글의 by → 다시 같은 users). 그때 컬럼을 하나 더 쌓으면
// 같은 문서가 화면에 두 번 뜨고 경로가 무한히 길어진다. 이미 열려 있는 컬럼까지
// 되감는 편이 "왔던 길로 돌아간다"는 실제 동작과 맞다.
//
// findIndex(=가장 앞)를 쓰는 게 중요하다. 한 문서를 파고들면 같은 ref를 공유하는
// 컬럼이 여러 개 생기므로(projectionPath만 다름), 그 문서의 루트 컬럼으로 돌아가야 한다.
const findOpenColumnForRef = (paths: ActivePath[], target: RefLocator): number =>
  paths.findIndex((path) => {
    if (path.kind === 'reference') {
      if (target.kind === 'oid') return path.ref.kind === 'oid' && path.ref.oid === target.oid;
      return path.ref.kind === 'field'
        && path.ref.database === target.database
        && path.ref.collection === target.collection
        && compareKey(path.ref.value) === compareKey(target.value);
    }
    // 참조가 아닌 일반 문서 컬럼도 같은 문서를 열고 있을 수 있다
    if (target.kind === 'oid') return path.documentOid === target.oid;
    return path.collectionName === target.collection && path.documentOid === idString(target.value);
  });

// 필드 기반 참조(FK)가 같은 컬렉션 안에서 PK 값 중복으로 후보가 여러 개일 때 —
// 조용히 하나를 골라 잘못 연결하지 않고 사용자에게 보여주고 고르게 한다.
export interface PendingFieldReference {
  candidates: FieldReferenceCandidate[];
  mode: 'push' | 'navigate';
  fieldKey?: string;
  popIndex?: number;
}

// ── UseExplorerStateResult 타입 (Header 등 외부 컴포넌트에서 Pick 가능) ────────

export interface DocumentListQuery {
  page: number;
  filter: string;
  sort: DocumentSort;
}

// markId = markedPage를 계산할 때 기준이 된 문서 id(그 사이 선택이 바뀌었으면 markedPage는 낡은 값)
export type DocumentPageInfo = Omit<DocumentPage, 'items'> & { markId?: string };

const EMPTY_DOCUMENT_QUERY: DocumentListQuery = { page: 0, filter: '', sort: 'none' };

export interface UseExplorerStateResult {
  // 상태
  connectionStatus: ConnectionStatus;
  activeDatabase: string | null;
  activePaths: ActivePath[];
  databases: DatabaseSummary[];
  collections: CollectionSummary[];
  documents: DocumentSummary[];
  // 문서 목록 페이지 정보(현재 페이지·전체 개수) — 컬렉션을 안 열었으면 null
  documentPage: DocumentPageInfo | null;
  documentQuery: DocumentListQuery;
  openDocument: Document | null;
  editingId: string | null;
  isLoading: boolean;
  changedPaths: string[];
  toast: ToastMessage | null;
  uniqueOids: Set<string>;
  referenceCandidates: PendingFieldReference | null;

  // 파생값
  visibleColumns: (ActivePath | null)[];
  breadcrumbs: ExplorerPathSegment[];
  maxVisibleColumns: number;

  // 액션
  setMaxVisibleColumns: (count: number) => void;
  initialize: () => Promise<void>;
  selectDatabase: (name: string) => Promise<void>;
  selectCollection: (name: string, label: string) => Promise<void>;
  selectDocument: (oid: string, title: string) => Promise<void>;
  // 문서 목록 검색어/정렬/페이지 변경. 검색어나 정렬이 바뀌면 첫 페이지로 간다.
  setDocumentQuery: (patch: Partial<DocumentListQuery>) => Promise<void>;
  pushJsonPath: (path: ActivePath) => void;
  popToIndex: (index: number) => void;
  pushFieldPath: (segments: string[]) => void;
  pushReference: (oid: string, fieldKey: string, popIndex?: number) => Promise<void>;
  navigateToReference: (oid: string) => Promise<void>;
  // 활동 기록 한 줄이 가리키는 곳(DB/컬렉션/문서/바뀐 필드)으로 이동
  navigateToChange: (entry: LiveLogEntry) => Promise<void>;
  pushReferenceByField: (database: string, collection: string, key: string, value: JsonValue, fieldKey: string, popIndex?: number) => Promise<void>;
  navigateToReferenceByField: (database: string, collection: string, key: string, value: JsonValue) => Promise<void>;
  resolveReferenceCandidate: (candidate: FieldReferenceCandidate) => Promise<void>;
  dismissReferenceCandidates: () => void;
  mutate: (op: MutationRequest) => Promise<MutationResult>;
  registerUniqueOid: (oid: string) => void;
  unregisterUniqueOid: (oid: string) => void;
  setEditingId: (id: string | null) => void;
  clearChangedPaths: () => void;
  dismissToast: () => void;
  undo: () => Promise<void>;
  refresh: () => Promise<void>;
}

// 실시간 이벤트를 이만큼 모았다가 한 번에 반영한다 — 연달아 오는 변경(일괄 수정 등)에 매번 다시 읽지 않도록
const LIVE_BATCH_MS = 150;
const STRUCTURE_OPS = new Set<LiveChange['op']>(['create', 'drop', 'rename', 'dropDatabase']);

interface LivePending {
  databases: boolean;
  collections: boolean;
  documents: boolean;
  openDocument: boolean;
  highlight: string[];
}
const emptyLivePending = (): LivePending => ({ databases: false, collections: false, documents: false, openDocument: false, highlight: [] });

// ── 훅 ───────────────────────────────────────────────────────────────────────

export function useExplorerState(): UseExplorerStateResult {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [activeDatabase, setActiveDatabase] = useState<string | null>(null);
  const [activePaths, setActivePaths] = useState<ActivePath[]>([]);
  const [databases, setDatabases] = useState<DatabaseSummary[]>([]);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [documentPage, setDocumentPage] = useState<DocumentPageInfo | null>(null);
  const [documentQuery, setDocumentQueryState] = useState<DocumentListQuery>(EMPTY_DOCUMENT_QUERY);
  const documentQueryRef = useRef<DocumentListQuery>(EMPTY_DOCUMENT_QUERY);
  // 문서 목록 요청 번호 — 검색어를 빠르게 치면 응답이 순서 없이 올 수 있어, 마지막 요청의 응답만 반영한다
  const documentRequestSeq = useRef(0);

  const applyDocumentQuery = useCallback((query: DocumentListQuery) => {
    documentQueryRef.current = query;
    setDocumentQueryState(query);
  }, []);

  // 문서 목록을 비운다(컬렉션을 벗어날 때) — 검색어/정렬/페이지도 초기화
  const clearDocuments = useCallback(() => {
    documentRequestSeq.current += 1;
    setDocuments([]);
    setDocumentPage(null);
    applyDocumentQuery(EMPTY_DOCUMENT_QUERY);
  }, [applyDocumentQuery]);

  // 한 페이지를 받아 상태에 반영한다. aroundId를 주면 그 문서가 있는 페이지를 받는다.
  // 반환값 false = 더 늦게 보낸 요청이 있어서 이 응답은 버렸다.
  const loadDocuments = useCallback(async (
    database: string,
    collection: string,
    query: DocumentListQuery,
    aroundId?: string,
  ): Promise<boolean> => {
    const seq = ++documentRequestSeq.current;
    // 선택된 문서가 몇 페이지에 있는지도 같이 묻는다(레일 표시용) — 참조 이동이면 그 대상이 곧 선택될 문서
    const markId = aroundId ?? activeDocumentOidRef.current ?? undefined;
    const page = await api.getDocuments(collectionKey(database, collection), { ...query, aroundId, markId });
    if (seq !== documentRequestSeq.current) return false;
    const { items, ...info } = page;
    setDocuments(items);
    setDocumentPage({ ...info, markId });
    // 서버가 페이지 번호를 고쳤을 수 있다(범위 밖 → 마지막 페이지, aroundId → 그 문서의 페이지)
    applyDocumentQuery({ ...query, page: page.page });
    return true;
  }, [applyDocumentQuery]);
  const [openDocument, setOpenDocument] = useState<Document | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [changedPaths, setChangedPaths] = useState<string[]>([]);
  const [referenceCandidates, setReferenceCandidates] = useState<PendingFieldReference | null>(null);
  const [maxVisibleColumns, setMaxVisibleColumnsState] = useState(MIN_VISIBLE_COLUMNS + 1);

  const setMaxVisibleColumns = useCallback((count: number) => {
    const clamped = Math.min(MAX_VISIBLE_COLUMNS, Math.max(MIN_VISIBLE_COLUMNS, count));
    setMaxVisibleColumnsState(clamped);
  }, []);

  const { toast, showToast, dismissToast } = useToast();
  const { uniqueOids, registerUniqueOid, unregisterUniqueOid } = useUniqueOidRegistry();

  const activeDatabaseRef = useRef<string | null>(null);
  const activeCollectionRef = useRef<string | null>(null);
  const activeDocumentOidRef = useRef<string | null>(null);
  const changedPathsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 위험 영역(의도적으로 더 쪼개지 않음): 아래의 activePaths state + 3개의 ref
  // (activeDatabaseRef/activeCollectionRef/activeDocumentOidRef)는 탐색 액션
  // 거의 전부가 2~4개씩 같이 읽고 쓰는 이 훅의 진짜 엔진이다. mutate/undo도
  // 이 ref들을 보고 "뭘 다시 불러올지" 결정하므로 탐색 로직과 강하게 결합돼
  // 있다. 테스트 코드가 없는 상태에서 이 부분을 훅으로 더 쪼개면, setState
  // 호출 순서나 ref 갱신 시점이 한 군데라도 어긋나면 비동기 경쟁 상태(race
  // condition) 버그가 생기기 쉽고 타입체커로는 잡히지 않는다. 그래서 toast/
  // uniqueOids처럼 완전히 독립적인 부분만 훅으로 뽑고, 이 블록은 그대로 뒀다.

  // ── 파생값 ──────────────────────────────────────────────────────────────────

  const visibleColumns = useMemo<(ActivePath | null)[]>(() => {
    const lastN = activePaths.slice(-maxVisibleColumns);
    const padding = Array(Math.max(0, maxVisibleColumns - lastN.length)).fill(null) as null[];
    return [...lastN, ...padding]; // 왼쪽 정렬: 실제 컬럼 먼저, placeholder 오른쪽
  }, [activePaths, maxVisibleColumns]);

  const breadcrumbs = useMemo<ExplorerPathSegment[]>(() => {
    const segs: ExplorerPathSegment[] = [];
    for (const ap of activePaths) {
      if (ap.columnKind === 'collections') {
        if (ap.databaseName) {
          segs.push({ key: ap.databaseName, label: ap.databaseName, kind: 'database' });
        }
      } else if (ap.columnKind === 'documents' && ap.kind === 'normal') {
        if (ap.collectionName) {
          segs.push({ key: ap.collectionName, label: ap.label, kind: 'collection' });
        }
      } else if (ap.columnKind === 'json') {
        if (ap.kind === 'reference') {
          segs.push({
            // refOid만으로 key를 만들면 같은 문서를 참조하는 두 경로가 동시에
            // activePaths에 있을 때(순환 참조 등) key가 충돌한다 — comp.id는
            // push마다 고유하므로 이를 사용한다.
            key: `ref-${ap.comp.id}`,
            label: ap.label,
            kind: 'document',
            chainColor: ap.chainColor,
          });
        } else if (ap.kind === 'normal') {
          const kind = ap.projectionPath && ap.projectionPath.length > 0 ? 'field' : 'document';
          segs.push({ key: String(ap.comp.id), label: ap.label, kind });
        }
      }
    }
    return segs;
  }, [activePaths]);

  // ── 액션 ────────────────────────────────────────────────────────────────────

  const initialize = useCallback(async () => {
    setConnectionStatus('connecting');
    setIsLoading(true);
    try {
      const result = await api.connect({});
      setDatabases(result.databases);
      setConnectionStatus('connected');
      activeDatabaseRef.current = result.activeDatabase;
      setActiveDatabase(result.activeDatabase);

      const cols = await api.getCollections(result.activeDatabase);
      setCollections(cols);
      setActivePaths([
        {
          kind: 'normal',
          columnKind: 'collections',
          label: result.activeDatabase,
          databaseName: result.activeDatabase,
          comp: { id: nextPathId(), direction: 1 },
        },
      ]);
      setEditingId(null);
    } catch {
      setConnectionStatus('error');
      showToast('Failed to connect to DB.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  const selectDatabase = useCallback(async (name: string) => {
    if (activeDatabaseRef.current === name) return;
    setIsLoading(true);
    try {
      const cols = await api.getCollections(name);
      activeDatabaseRef.current = name;
      activeCollectionRef.current = null;
      activeDocumentOidRef.current = null;
      setActiveDatabase(name);
      setCollections(cols);
      clearDocuments();
      setOpenDocument(null);
      setActivePaths([
        {
          kind: 'normal',
          columnKind: 'collections',
          label: name,
          databaseName: name,
          comp: { id: nextPathId(), direction: -1 },
        },
      ]);
      setEditingId(null);
    } catch {
      showToast('Could not load database.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast, clearDocuments]);

  const selectCollection = useCallback(async (name: string, label: string) => {
    if (activeCollectionRef.current === name && activePaths.length > 1) {
      if (activePaths.length === 3)
        popToIndex(1); // 이미 선택된 컬렉션 클릭 시 문서/필드 경로 팝
      return;
    }
    setIsLoading(true);
    try {
      // DB로 한정해서 조회한다 — 이름만 넘기면 findCollection이 전체 DB를 훑어
      // 다른 DB의 동명 컬렉션(users 등)을 먼저 집어온다
      await loadDocuments(activeDatabaseRef.current ?? '', name, EMPTY_DOCUMENT_QUERY);
      activeCollectionRef.current = name;
      activeDocumentOidRef.current = null;
      setOpenDocument(null);
      setActivePaths((prev) => {
        const base: NormalActivePath = {
          kind: 'normal',
          columnKind: 'collections',
          label: activeDatabaseRef.current ?? '',
          databaseName: activeDatabaseRef.current ?? undefined,
          comp: { id: prev[0]?.comp.id ?? nextPathId(), direction: 1 },
        };
        const next: NormalActivePath = {
          kind: 'normal',
          columnKind: 'documents',
          label,
          collectionName: name,
          comp: { id: nextPathId(), direction: -1 },
        };
        return [base, next];
      });
      setEditingId(null);
    } catch {
      showToast('Could not load collection.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast, activePaths, activeCollectionRef]);

  const selectDocument = useCallback(async (oid: string, title: string) => {
    if (activeDocumentOidRef.current === oid && activePaths.length > 2) {
      if (activePaths.length === 4)
        popToIndex(2); // 이미 선택된 컬렉션 클릭 시 문서/필드 경로 팝
      return;
    }
    setIsLoading(true);
    try {
      // 전체 문서 — 로컬 JSON 탐색용. 이미 컬렉션이 정해져 있으므로 oid 전역 검색 대신
      // 컬렉션-scoped 조회를 쓴다 (plain _id 문서도 열 수 있도록)
      const doc = await api.getFullDocumentByIdInCollection(activeDatabaseRef.current ?? '', activeCollectionRef.current ?? '', oid);
      activeDocumentOidRef.current = oid;
      setOpenDocument(doc);
      setActivePaths((prev) => {
        const jsonPath: NormalActivePath = {
          kind: 'normal',
          columnKind: 'json',
          label: title,
          documentOid: oid,
          projectionPath: [],
          comp: { id: nextPathId(), direction: -1 },
        };
        return [...prev.slice(0, 2), jsonPath];
      });
      setEditingId(null);
    } catch {
      showToast('Could not load document.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast, activePaths]);

  const pushJsonPath = useCallback((path: ActivePath) => {
    setActivePaths((prev) => [...prev, path]);
    // 컬럼이 슬라이딩 윈도우 밖으로 밀려나면서 InlineSegmentEditor가 보이지 않게 되어도
    // editingId가 남아있으면 다른 컬럼의 추가/수정이 막히므로 탐색 시 항상 정리
    setEditingId(null);
  }, []);

  const popToIndex = useCallback((index: number) => {
    setActivePaths((prev) => prev.slice(0, index + 1));
    // json depth 이하로 pop 시 openDocument 상태 유지 (컬럼이 재사용)
    setEditingId(null);
  }, []);

  // breadcrumb dot-path 입력에서 커밋된 경로를 한 번에 여러 depth로 push —
  // 한 단계씩 pushJsonPath를 반복 호출하면 컬럼 애니메이션이 N번 튀므로
  // 문서 루트 기준으로 한 번의 setActivePaths로 일괄 추가한다.
  const pushFieldPath = useCallback((segments: string[]) => {
    setActivePaths((prev) => {
      let baseIndex = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        const ap = prev[i];
        if (ap.columnKind !== 'json') continue;
        if (ap.kind === 'normal' && (ap.projectionPath?.length ?? 0) === 0) {
          baseIndex = i;
          break;
        }
        if (ap.kind === 'reference') break; // 참조 체인 — v1 미지원
      }
      if (baseIndex === -1) return prev;
      const base = prev.slice(0, baseIndex + 1);
      const docOid = (base[baseIndex] as NormalActivePath).documentOid ?? '';
      let acc: string[] = [];
      const pushed: NormalActivePath[] = segments.map((seg) => {
        acc = [...acc, seg];
        return {
          kind: 'normal',
          columnKind: 'json',
          label: seg,
          documentOid: docOid,
          projectionPath: acc,
          comp: { id: nextPathId(), direction: -1 },
        };
      });
      return [...base, ...pushed];
    });
    setEditingId(null);
  }, []);

  const pushReference = useCallback(async (oid: string, fieldKey: string, popIndex?: number) => {
    setIsLoading(true);
    try {
      const isRef = await api.checkReference(oid);
      // 참조가 실제로 존재하지 않으면 아무 것도 하지 않음 — 열려있던 하위 컬럼도 그대로 유지
      if (!isRef) return;

      const doc = await api.getDocumentById(oid);
      setActivePaths((prev) => {
        const base = popIndex !== undefined ? prev.slice(0, popIndex + 1) : prev;
        // 이미 이 문서를 열어둔 컬럼이 있으면 새로 쌓지 않고 거기까지 되감는다
        const openIndex = findOpenColumnForRef(base, { kind: 'oid', oid });
        if (openIndex >= 0) return base.slice(0, openIndex + 1);

        const chainIndex = base.filter((p) => p.kind === 'reference').length;
        const chainColor = CHAIN_COLORS[chainIndex % CHAIN_COLORS.length];
        const refPath: ReferenceActivePath = {
          kind: 'reference',
          columnKind: 'json',
          label: fieldKey,
          ref: { kind: 'oid', oid },
          projectionPath: [],
          chainColor,
          chainIndex,
          comp: { id: nextPathId(), direction: 1 },
        };
        // refDoc는 참조된 문서로 openDocument를 교체하지 않고 별도 처리
        // JsonLevelColumn에서 refOid를 직접 사용해 getDocumentById 호출
        void doc; // 참조 확인용, 실제 렌더는 컬럼에서 처리
        return [...base, refPath];
      });
      setEditingId(null);
    } catch {
      showToast('Could not load reference.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  // 참조 배지(REF) 클릭 시 — 체인을 따라가지 않고 Path를 초기화한 후 참조 대상 컬렉션/문서로 바로 이동
  const navigateToReference = useCallback(async (oid: string) => {
    setIsLoading(true);
    try {
      const info = await api.getReferenceInfo(oid);
      if (!info) {
        showToast('Could not find the referenced document.', 'error');
        return;
      }
      const { databaseName, collectionName, collectionLabel, documentTitle } = info;
      // 문서 목록은 그 문서가 들어 있는 페이지로 연다(aroundId)
      const [cols, , doc] = await Promise.all([
        api.getCollections(databaseName),
        loadDocuments(databaseName, collectionName, EMPTY_DOCUMENT_QUERY, oid),
        api.getFullDocumentById(oid),
      ]);

      activeDatabaseRef.current = databaseName;
      activeCollectionRef.current = collectionName;
      activeDocumentOidRef.current = oid;

      setActiveDatabase(databaseName);
      setCollections(cols);
      setOpenDocument(doc);
      setActivePaths([
        {
          kind: 'normal',
          columnKind: 'collections',
          label: databaseName,
          databaseName,
          comp: { id: nextPathId(), direction: 1 },
        },
        {
          kind: 'normal',
          columnKind: 'documents',
          label: collectionLabel,
          collectionName,
          comp: { id: nextPathId(), direction: 1 },
        },
        {
          kind: 'normal',
          columnKind: 'json',
          label: documentTitle,
          documentOid: oid,
          projectionPath: [],
          comp: { id: nextPathId(), direction: 1 },
        },
      ]);
      setEditingId(null);
    } catch {
      showToast('Failed to navigate.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  // ── 필드 기반 참조(FK) — oid 경로(pushReference/navigateToReference)와 병행하는 별도 경로.
  // 후보가 하나면 즉시 진행하고, 여러 개면(같은 컬렉션 안의 중복 PK 값) referenceCandidates에
  // 채워 사용자가 고르게 한다 — 조용히 하나를 골라 잘못 연결하지 않도록.

  const finalizePushFieldReference = useCallback((candidate: FieldReferenceCandidate, fieldKey: string, popIndex?: number) => {
    setActivePaths((prev) => {
      const base = popIndex !== undefined ? prev.slice(0, popIndex + 1) : prev;
      // oid 참조와 같은 규칙 — 이미 열린 컬럼이 있으면 되감는다.
      // ref.key를 '_id'로 고정해 저장하므로 대상도 documentId로 비교한다.
      const openIndex = findOpenColumnForRef(base, {
        kind: 'field',
        database: candidate.database,
        collection: candidate.collection,
        key: '_id',
        value: candidate.documentId,
      });
      if (openIndex >= 0) return base.slice(0, openIndex + 1);

      const chainIndex = base.filter((p) => p.kind === 'reference').length;
      const chainColor = CHAIN_COLORS[chainIndex % CHAIN_COLORS.length];
      const refPath: ReferenceActivePath = {
        kind: 'reference',
        columnKind: 'json',
        label: fieldKey,
        // key를 '_id'/documentId로 고정 — 다시 렌더/refetch될 때마다 원래의 모호한
        // key/value 매칭을 재생하지 않고 이미 골라낸 문서를 그대로 가리키게 한다
        ref: { kind: 'field', database: candidate.database, collection: candidate.collection, key: '_id', value: candidate.documentId },
        projectionPath: [],
        chainColor,
        chainIndex,
        comp: { id: nextPathId(), direction: 1 },
      };
      return [...base, refPath];
    });
    setEditingId(null);
  }, []);

  const finalizeNavigateFieldReference = useCallback(async (candidate: FieldReferenceCandidate) => {
    const [cols, , doc] = await Promise.all([
      api.getCollections(candidate.database),
      loadDocuments(candidate.database, candidate.collection, EMPTY_DOCUMENT_QUERY, candidate.documentId),
      api.getFullDocumentByIdInCollection(candidate.database, candidate.collection, candidate.documentId),
    ]);

    activeDatabaseRef.current = candidate.database;
    activeCollectionRef.current = candidate.collection;
    activeDocumentOidRef.current = candidate.documentId;

    setActiveDatabase(candidate.database);
    setCollections(cols);
    setOpenDocument(doc);
    setActivePaths([
      {
        kind: 'normal',
        columnKind: 'collections',
        label: candidate.database,
        databaseName: candidate.database,
        comp: { id: nextPathId(), direction: 1 },
      },
      {
        kind: 'normal',
        columnKind: 'documents',
        label: candidate.collection,
        collectionName: candidate.collection,
        comp: { id: nextPathId(), direction: 1 },
      },
      {
        kind: 'normal',
        columnKind: 'json',
        label: candidate.documentTitle,
        documentOid: candidate.documentId,
        projectionPath: [],
        comp: { id: nextPathId(), direction: 1 },
      },
    ]);
    setEditingId(null);
  }, []);

  const pushReferenceByField = useCallback(async (
    database: string, collection: string, key: string, value: JsonValue, fieldKey: string, popIndex?: number,
  ) => {
    setIsLoading(true);
    try {
      const candidates = await api.getReferenceCandidatesByField(database, collection, key, value);
      // 참조가 실제로 존재하지 않으면 아무 것도 하지 않음 (oid 경로의 pushReference와 동일한 침묵 동작)
      if (candidates.length === 0) return;
      if (candidates.length === 1) {
        finalizePushFieldReference(candidates[0], fieldKey, popIndex);
        return;
      }
      setReferenceCandidates({ candidates, mode: 'push', fieldKey, popIndex });
    } catch {
      showToast('Could not load reference.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast, finalizePushFieldReference]);

  const navigateToReferenceByField = useCallback(async (database: string, collection: string, key: string, value: JsonValue) => {
    setIsLoading(true);
    try {
      const candidates = await api.getReferenceCandidatesByField(database, collection, key, value);
      if (candidates.length === 0) {
        showToast('Could not find the referenced document.', 'error');
        return;
      }
      if (candidates.length === 1) {
        await finalizeNavigateFieldReference(candidates[0]);
        return;
      }
      setReferenceCandidates({ candidates, mode: 'navigate' });
    } catch {
      showToast('Failed to navigate.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast, finalizeNavigateFieldReference]);

  const resolveReferenceCandidate = useCallback(async (candidate: FieldReferenceCandidate) => {
    const pending = referenceCandidates;
    setReferenceCandidates(null);
    if (!pending) return;
    if (pending.mode === 'push') {
      finalizePushFieldReference(candidate, pending.fieldKey ?? '', pending.popIndex);
      return;
    }
    setIsLoading(true);
    try {
      await finalizeNavigateFieldReference(candidate);
    } catch {
      showToast('Failed to navigate.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [referenceCandidates, finalizePushFieldReference, finalizeNavigateFieldReference, showToast]);

  const dismissReferenceCandidates = useCallback(() => setReferenceCandidates(null), []);

  // 변경된 경로를 강조(ChangeFlash)한다. 강조 중에 또 바뀌면 잠깐 껐다 다시 켜서 깜빡임을 새로 시작한다 —
  // 항목은 '켜짐으로 바뀌는 순간'에 깜빡이므로, 켜진 채로 두면 연달아 온 변경이 보이지 않는다.
  const changedPathsRef = useRef<string[]>([]);
  const flashChangedPaths = useCallback((paths: string[]) => {
    if (changedPathsTimerRef.current) clearTimeout(changedPathsTimerRef.current);
    const apply = () => {
      changedPathsRef.current = paths;
      setChangedPaths(paths);
      changedPathsTimerRef.current = setTimeout(() => {
        changedPathsRef.current = [];
        setChangedPaths([]);
      }, CHANGE_FLASH_MS);
    };
    if (changedPathsRef.current.length > 0) {
      changedPathsRef.current = [];
      setChangedPaths([]);
      requestAnimationFrame(apply);
    } else {
      apply();
    }
  }, []);

  // 지정한 DB로 포커스를 옮기고 탐색 상태를 컬렉션 목록까지만 남긴다 (null이면 빈 상태)
  const focusDatabase = useCallback(async (nextDb: string | null) => {
    activeDatabaseRef.current = nextDb;
    activeCollectionRef.current = null;
    activeDocumentOidRef.current = null;
    setActiveDatabase(nextDb);
    clearDocuments();
    setOpenDocument(null);
    setEditingId(null);
    if (!nextDb) {
      setCollections([]);
      setActivePaths([]);
      return;
    }
    setCollections(await api.getCollections(nextDb));
    setActivePaths([
      {
        kind: 'normal',
        columnKind: 'collections',
        label: nextDb,
        databaseName: nextDb,
        comp: { id: nextPathId(), direction: -1 },
      },
    ]);
  }, []);

  const mutate = useCallback(async (op: MutationRequest): Promise<MutationResult> => {
    setIsLoading(true);
    try {
      const result = await api.mutate(op);
      flashChangedPaths(result.changedPaths);

      // 관련 캐시 갱신
      if (op.type === 'deleteCollection' && activeCollectionRef.current === op.collection) {
        // 현재 보고 있던 컬렉션 자체가 삭제됨 — 문서/탐색 상태 초기화 (getDocuments 호출 시 실패하므로 분기)
        activeCollectionRef.current = null;
        activeDocumentOidRef.current = null;
        clearDocuments();
        setOpenDocument(null);
        setActivePaths((prev) => prev.slice(0, 1));
        setEditingId(null);
      } else if ('collection' in op && typeof op.collection === 'string' && activeCollectionRef.current === op.collection) {
        // 같은 검색어/정렬/페이지로 다시 받는다
        await loadDocuments(activeDatabaseRef.current ?? '', op.collection, documentQueryRef.current);
        // 문서 추가/삭제/수정으로 컬렉션 용량(sizeMb)·문서 수가 바뀌므로 컬렉션 메타도 같이 갱신
        if ('database' in op && typeof op.database === 'string') {
          const cols = await api.getCollections(op.database);
          setCollections(cols);
        }
        // 열린 문서 갱신
        if (activeDocumentOidRef.current && op.type === 'mutateField') {
          const doc = await api.getFullDocumentByIdInCollection(activeDatabaseRef.current ?? '', activeCollectionRef.current ?? '', activeDocumentOidRef.current);
          setOpenDocument(doc);
        }
      }
      // 컬렉션 메타데이터(이름/타이틀 키 등) 변경 시 collections 캐시도 갱신
      if (
        (op.type === 'createCollection' || op.type === 'renameCollection' || op.type === 'setCollectionTitleKey' || op.type === 'setCollectionPrimaryKey' || op.type === 'setCollectionReferenceField' || op.type === 'deleteCollection' || op.type === 'duplicateCollection') &&
        op.database === activeDatabaseRef.current
      ) {
        const cols = await api.getCollections(op.database);
        setCollections(cols);
      }
      // 헤더 DB 드롭다운 목록 갱신
      if (op.type === 'createDatabase' || op.type === 'deleteDatabase') {
        setDatabases(await api.listDatabases());
      }

      if (op.type === 'createDatabase') {
        // 새로 만든 DB로 포커스 이동
        await focusDatabase(op.database.name);
      } else if (op.type === 'deleteDatabase' && activeDatabaseRef.current === op.database) {
        // 보고 있던 DB가 삭제됨 — 남은 DB 중 첫 번째로 이동하거나(없으면 빈 상태로)
        const remaining = await api.listDatabases();
        await focusDatabase(remaining[0]?.name ?? null);
      }

      showToast('Saved', 'success', true);
      return result;
    } catch (e) {
      const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : 'Failed to save.';
      showToast(msg, 'error');
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, [showToast, focusDatabase, flashChangedPaths]);

  const clearChangedPaths = useCallback(() => {
    if (changedPathsTimerRef.current) clearTimeout(changedPathsTimerRef.current);
    changedPathsRef.current = [];
    setChangedPaths([]);
  }, []);

  // 되돌리기는 데이터 소스가 담당한다(Mock: 스냅샷 복원 / 서버: 역연산). 무엇이 바뀌었는지
  // 모르므로 현재 보고 있는 범위(DB 목록·컬렉션·문서 목록·열린 문서)를 전부 다시 읽는다.
  const undo = useCallback(async () => {
    setIsLoading(true);
    try {
      const undone = await api.undoLast();
      if (!undone) return;
      setDatabases(await api.listDatabases());
      const db = activeDatabaseRef.current;
      if (db) {
        setCollections(await api.getCollections(db));
        const col = activeCollectionRef.current;
        if (col) {
          await loadDocuments(db, col, documentQueryRef.current);
          const docId = activeDocumentOidRef.current;
          if (docId) {
            setOpenDocument(await api.getFullDocumentByIdInCollection(db, col, docId).catch(() => null));
          }
        }
      }
      showToast('Undone', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to undo.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  // 새로고침은 데이터만 다시 받아오는 게 아니라 collection/document/field 경로도 전부 비운다 —
  // selectDatabase가 쓰는 것과 같은 초기화 패턴으로 collections 목록까지만 남긴다.
  const refresh = useCallback(async () => {
    if (!activeDatabaseRef.current) return;
    setIsLoading(true);
    try {
      const cols = await api.getCollections(activeDatabaseRef.current);
      activeCollectionRef.current = null;
      activeDocumentOidRef.current = null;
      setCollections(cols);
      clearDocuments();
      setOpenDocument(null);
      setActivePaths([
        {
          kind: 'normal',
          columnKind: 'collections',
          label: activeDatabaseRef.current,
          databaseName: activeDatabaseRef.current,
          comp: { id: nextPathId(), direction: -1 },
        },
      ]);
      setEditingId(null);
    } catch {
      showToast('Failed to refresh.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  // ── 실시간 반영 ────────────────────────────────────────────────────────────
  // 서버(changeStream)가 보내는 변경을 받아 지금 화면에 걸린 부분만 다시 읽는다.
  // 목록 순서·페이지는 서버가 정하므로 이벤트로 직접 고치지 않고 '현재 페이지 다시 받기'로 맞춘다.

  // 지금 보는 DB/컬렉션을 서버에 알린다 — 그 컬렉션의 변경만 자세히 받는다
  const activeCollectionName = useMemo(() => {
    const docPath = activePaths.find((p) => p.kind === 'normal' && p.columnKind === 'documents');
    return docPath?.kind === 'normal' ? docPath.collectionName ?? null : null;
  }, [activePaths]);
  useEffect(() => {
    api.setLiveView({ database: activeDatabase, collection: activeCollectionName });
  }, [activeDatabase, activeCollectionName]);

  const livePendingRef = useRef<LivePending>(emptyLivePending());
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushLive = useCallback(async () => {
    liveTimerRef.current = null;
    const pending = livePendingRef.current;
    livePendingRef.current = emptyLivePending();
    const db = activeDatabaseRef.current;
    const col = activeCollectionRef.current;
    const docId = activeDocumentOidRef.current;
    try {
      if (pending.databases) {
        const dbs = await api.listDatabases();
        setDatabases(dbs);
        if (db && !dbs.some((d) => d.name === db)) {
          showToast(`Database "${db}" was removed outside this app`, 'error');
          await focusDatabase(dbs[0]?.name ?? null);
          return;
        }
      }
      if (db && pending.collections) {
        const cols = await api.getCollections(db);
        setCollections(cols);
        if (col && !cols.some((c) => c.name === col)) {
          showToast(`Collection "${col}" was removed outside this app`, 'error');
          activeCollectionRef.current = null;
          activeDocumentOidRef.current = null;
          clearDocuments();
          setOpenDocument(null);
          setActivePaths((prev) => prev.slice(0, 1));
          setEditingId(null);
          return;
        }
      }
      if (db && col && pending.documents) {
        await loadDocuments(db, col, documentQueryRef.current);
      }
      if (db && col && docId && pending.openDocument) {
        const doc = await api.getFullDocumentByIdInCollection(db, col, docId).catch(() => null);
        // 그 사이 다른 문서로 옮겼으면 버린다
        if (activeDocumentOidRef.current === docId) {
          if (doc) {
            setOpenDocument(doc);
          } else {
            showToast('This document was deleted outside this app', 'error');
            activeDocumentOidRef.current = null;
            setOpenDocument(null);
            setActivePaths((prev) => prev.slice(0, 2));
            setEditingId(null);
          }
        }
      }
      if (pending.highlight.length) flashChangedPaths(pending.highlight);
    } catch {
      // 일시적인 실패 — 다음 변경이나 재연결(resync) 때 다시 맞춰진다
    }
  }, [showToast, focusDatabase, clearDocuments, loadDocuments, flashChangedPaths]);

  const scheduleLive = useCallback(() => {
    if (!liveTimerRef.current) liveTimerRef.current = setTimeout(() => void flushLive(), LIVE_BATCH_MS);
  }, [flushLive]);

  const handleLiveChange = useCallback((change: LiveChange) => {
    const pending = livePendingRef.current;
    const db = activeDatabaseRef.current;
    const col = activeCollectionRef.current;

    if (STRUCTURE_OPS.has(change.op)) {
      // 컬렉션/DB 생성·삭제·이름변경 — 목록이 바뀐다
      pending.databases = true;
      if (change.database === db) pending.collections = true;
    } else {
      // 문서 추가/삭제는 DB·컬렉션 목록의 문서 수를 바꾼다(수정은 안 바뀌므로 목록은 그대로 둔다)
      if (change.op === 'insert' || change.op === 'delete') {
        pending.databases = true;
        if (change.database === db) pending.collections = true;
      }
      if (change.database === db && change.collection === col) {
        pending.documents = true;
        if (change.documentId) {
          const base = `databases.${db}.collections.${col}.documents.${change.documentId}`;
          if (change.documentId === activeDocumentOidRef.current) {
            pending.openDocument = true;
            // 바뀐 필드 경로를 하이라이트(그 상위 필드·문서 행도 같이 켜진다 — isPathChanged)
            const fields = change.op === 'update' ? Object.keys(change.updatedFields ?? {}) : [];
            if (fields.length) pending.highlight.push(...fields.map((f) => `${base}.${f}`));
            else pending.highlight.push(base);
          } else if (change.op !== 'delete') {
            pending.highlight.push(base);
          }
        }
      }
    }
    scheduleLive();
  }, [scheduleLive]);

  const handleLiveStatus = useCallback((status: LiveStatus) => {
    // 헤더의 연결 점 — 서버 연결이 끊기면 노랑/빨강
    setConnectionStatus(status.state === 'running' ? 'connected' : status.state === 'connecting' ? 'connecting' : 'error');
    if (status.resync) {
      // 변경을 놓쳤을 수 있다 — 지금 화면에 걸린 걸 전부 다시 받는다
      livePendingRef.current = { databases: true, collections: true, documents: true, openDocument: true, highlight: [] };
      scheduleLive();
    }
  }, [scheduleLive]);

  // 구독은 한 번만 — 핸들러는 ref로 최신 것을 부른다
  const liveHandlersRef = useRef({ handleLiveChange, handleLiveStatus });
  liveHandlersRef.current = { handleLiveChange, handleLiveStatus };
  useEffect(() => {
    const offChange = api.onLiveChange((change) => liveHandlersRef.current.handleLiveChange(change));
    const offStatus = api.onLiveStatus((status) => liveHandlersRef.current.handleLiveStatus(status));
    return () => {
      offChange();
      offStatus();
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    };
  }, []);

  // ── 활동 기록에서 이동 ────────────────────────────────────────────────────
  // 기록에는 값이 없고 경로만 있으므로 이동해서 보이는 건 '지금' 값이다.
  //   문서 변경(insert/update/replace) → 그 문서가 있는 페이지 + 문서 열기, update면 바뀐 필드의 상위까지 펼쳐 강조
  //   delete / 컬렉션 생성·이름변경 → 컬렉션까지만
  //   그 사이 사라졌으면 열 수 있는 데까지 열고 알린다
  const navigateToChange = useCallback(async (entry: LiveLogEntry) => {
    if (entry.op === 'drop' || entry.op === 'dropDatabase') return;
    const database = entry.op === 'rename' && entry.to ? entry.to.database : entry.database;
    const collection = entry.op === 'rename' && entry.to ? entry.to.collection : entry.collection;
    const isDocumentChange = entry.op === 'insert' || entry.op === 'update' || entry.op === 'replace';
    const docBase = `databases.${database}.collections.${collection}.documents.${entry.documentId}`;

    // 지금 보고 있는 위치가 이동할 위치와 '완전히 같으면' 경로는 건드리지 않고 강조만.
    // (그 문서를 열었더라도 다른 필드를 펼쳐 두었거나, 컬렉션에서 문서를 열어 두었으면 이동한다)
    const firstPath = entry.paths?.[0] ?? entry.removed?.[0];
    const targetProjection = isDocumentChange && firstPath ? firstPath.split('.').slice(0, -1) : [];
    const last = activePaths[activePaths.length - 1];
    const sameCollection = activeDatabaseRef.current === database && activeCollectionRef.current === collection;
    const exactlyHere = sameCollection && (
      isDocumentChange && entry.documentId
        ? last?.kind === 'normal' && last.columnKind === 'json' && last.documentOid === entry.documentId
          && (last.projectionPath ?? []).join('.') === targetProjection.join('.')
        : last?.columnKind === 'documents'
    );
    if (exactlyHere) {
      if (entry.op === 'delete') showToast('This document was deleted', 'error');
      else if (isDocumentChange) flashChangedPaths(entry.paths?.length ? entry.paths.map((p) => `${docBase}.${p}`) : [docBase]);
      else flashChangedPaths([`databases.${database}.collections.${collection}`]);
      return;
    }

    setIsLoading(true);
    try {
      const dbs = await api.listDatabases();
      setDatabases(dbs);
      if (!dbs.some((d) => d.name === database)) {
        showToast(`Database "${database}" no longer exists`, 'error');
        return;
      }
      const cols = await api.getCollections(database);
      const colSummary = collection ? cols.find((c) => c.name === collection) : undefined;
      if (!collection || !colSummary) {
        await focusDatabase(database);
        if (collection) showToast(`Collection "${collection}" no longer exists`, 'error');
        return;
      }

      const doc = isDocumentChange && entry.documentId
        ? await api.getFullDocumentByIdInCollection(database, collection, entry.documentId).catch(() => null)
        : null;
      if (!doc || !entry.documentId) {
        // 문서까지 갈 수 없으면 컬렉션 목록까지
        await focusDatabase(database);
        await selectCollection(collection, colSummary.label || collection);
        if (entry.op === 'delete') showToast('This document was deleted', 'error');
        else if (isDocumentChange) showToast('This document no longer exists', 'error');
        return;
      }

      const title = summarizeDocument(doc, 0, colSummary.titleKey, colSummary.primaryKey).title;
      await finalizeNavigateFieldReference({ database, collection, documentId: entry.documentId, documentTitle: title });

      // 바뀐 필드의 상위까지 펼친다 — 지금 문서에 실제로 있는 데까지만(그 사이 지워졌을 수 있다)
      if (targetProjection.length) {
        const reachable: string[] = [];
        let node: JsonValue = doc;
        for (const seg of targetProjection) {
          if (!isContainer(node)) break;
          const next: JsonValue | undefined = Array.isArray(node) ? node[Number(seg)] : node[seg];
          if (next === undefined) break;
          reachable.push(seg);
          node = next;
        }
        if (reachable.length) pushFieldPath(reachable);
      }
      flashChangedPaths(entry.paths?.length ? entry.paths.map((p) => `${docBase}.${p}`) : [docBase]);
    } catch {
      showToast('Could not open this change', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [activePaths, showToast, focusDatabase, selectCollection, finalizeNavigateFieldReference, pushFieldPath, flashChangedPaths]);

  const setDocumentQuery = useCallback(async (patch: Partial<DocumentListQuery>) => {
    const prev = documentQueryRef.current;
    const next = { ...prev, ...patch };
    const criteriaChanged = next.filter !== prev.filter || next.sort !== prev.sort;
    if (criteriaChanged && patch.page === undefined) next.page = 0;
    // 입력창이 바로 반응하도록 먼저 반영하고, 결과는 응답이 오면 채운다
    applyDocumentQuery(next);
    const db = activeDatabaseRef.current;
    const col = activeCollectionRef.current;
    if (!db || !col) return;
    try {
      await loadDocuments(db, col, next);
    } catch {
      showToast('Could not load documents.', 'error');
    }
  }, [applyDocumentQuery, loadDocuments, showToast]);

  return {
    connectionStatus,
    activeDatabase,
    activePaths,
    databases,
    collections,
    documents,
    documentPage,
    documentQuery,
    openDocument,
    editingId,
    isLoading,
    changedPaths,
    toast,
    uniqueOids,
    referenceCandidates,
    visibleColumns,
    breadcrumbs,
    maxVisibleColumns,
    setMaxVisibleColumns,
    initialize,
    selectDatabase,
    selectCollection,
    selectDocument,
    setDocumentQuery,
    pushJsonPath,
    popToIndex,
    pushFieldPath,
    pushReference,
    navigateToReference,
    navigateToChange,
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
  };
}
