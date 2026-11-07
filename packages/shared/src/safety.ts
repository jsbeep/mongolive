// 안전장치(설정 창 › Safety) — 서버와 브라우저가 같은 규칙을 쓴다.
//   서버(routes/mutate)  : 진짜로 막는 곳. 403으로 거절한다
//   브라우저(useExplorerState): 보내기 전에 미리 알려 주는 곳(토스트) — 서버가 최종 판단
// 실수 방지용이지 보안 장치가 아니다: 세션을 가진 사람은 설정도 바꿀 수 있다.
// 메타데이터 연산(titleKey/PK/FK 선언)은 MongoDB를 건드리지 않으므로 막지 않는다.
import type { MutationRequest } from './contract';

export interface ProtectedTarget {
  database: string;
  // 없으면 DB 전체
  collection?: string;
}

// 서버 쪽 설정(~/.mongolive/settings.json). 모든 브라우저에 똑같이 적용된다
export interface ServerSettings {
  // 켜면 문서·컬렉션·DB 쓰기를 전부 거절한다(되돌리기 포함)
  readOnly: boolean;
  // 편집을 막을 DB/컬렉션
  protected: ProtectedTarget[];
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = { readOnly: false, protected: [] };

// 이 쓰기가 건드리는 곳. null = MongoDB를 건드리지 않는 연산(메타데이터)
export const mutationTarget = (op: MutationRequest): { database: string; collections: string[] } | null => {
  switch (op.type) {
    case 'createDatabase':
      return { database: op.database.name, collections: [] };
    case 'deleteDatabase':
      return { database: op.database, collections: [] };
    case 'createCollection':
      return { database: op.database, collections: [op.collection.name] };
    case 'renameCollection':
      return { database: op.database, collections: [op.oldName, op.newName] };
    // 복제는 원본을 읽기만 한다 — 새 컬렉션이 생기는 DB만 본다
    case 'duplicateCollection':
      return { database: op.database, collections: [] };
    case 'deleteCollection':
    case 'upsertDocument':
    case 'duplicateDocument':
    case 'deleteDocument':
    case 'mutateField':
      return { database: op.database, collections: [op.collection] };
    case 'setCollectionTitleKey':
    case 'setCollectionPrimaryKey':
    case 'setCollectionReferenceField':
      return null;
  }
};

export const isProtected = (settings: ServerSettings, database: string, collection?: string): boolean =>
  settings.protected.some((p) => p.database === database && (p.collection === undefined || p.collection === collection));

// 막혀 있으면 이유(사용자에게 보일 문장), 아니면 null
export const writeBlockedReason = (settings: ServerSettings, op: MutationRequest): string | null => {
  const target = mutationTarget(op);
  if (!target) return null;
  if (settings.readOnly) return 'Read-only mode is on — turn it off in Settings › Safety to edit.';
  if (isProtected(settings, target.database)) return `Database "${target.database}" is protected — change it in Settings › Safety.`;
  const blocked = target.collections.find((c) => isProtected(settings, target.database, c));
  if (blocked) return `Collection "${target.database}.${blocked}" is protected — change it in Settings › Safety.`;
  return null;
};

// 바깥에서 온 값(파일·요청 본문)을 ServerSettings로 — 모르는 값은 버린다
export const normalizeServerSettings = (raw: unknown): ServerSettings => {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(obj.protected) ? obj.protected : [];
  const seen = new Set<string>();
  const protectedTargets: ProtectedTarget[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { database, collection } = item as Record<string, unknown>;
    if (typeof database !== 'string' || !database) continue;
    if (collection !== undefined && (typeof collection !== 'string' || !collection)) continue;
    const key = `${database}\u0000${collection ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    protectedTargets.push(collection === undefined ? { database } : { database, collection });
  }
  return { readOnly: obj.readOnly === true, protected: protectedTargets };
};
