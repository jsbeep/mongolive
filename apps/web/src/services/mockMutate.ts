// path: src/services/mockMutate.ts
// 필드 변경 규칙은 서버와 공유한다(@mongolive/shared fieldMutation.ts) — 여기엔 Mock 전용만 남긴다.
import { type MockSnapshot } from '../types/explorer';

export { getMutationPath, mutateDocumentField, toChangeEvent } from '@mongolive/shared';

export const updateCollectionTimestamps = (
  snapshot: MockSnapshot,
  databaseName: string,
  collectionName: string,
  timestamp: number,
): void => {
  snapshot.databases[databaseName].collections[collectionName].updatedAt = timestamp;
  snapshot.databases[databaseName].updatedAt = timestamp;
  snapshot.updatedAt = timestamp;
};
