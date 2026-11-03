// path: src/services/mockMutate.ts
import {
  type Document,
  type FriendlyPatchEvent,
  type JsonValue,
  type MutateFieldSpec,
  type MockSnapshot,
} from '../types/explorer';
import { cloneValue, isJsonObject } from './mockClone';

const resolveMutableContainer = (document: Document, path: string[]): JsonValue | undefined => {
  let current: JsonValue = document;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    if (!isJsonObject(current) || !(segment in current)) {
      return undefined;
    }

    const objectCurrent = current;
    current = objectCurrent[segment];
  }

  return current;
};

const normalizePath = (path: string[]): string => path.filter((segment) => segment.length > 0).join('.');

export const getMutationPath = (basePath: string[], key: string): string => normalizePath([...basePath, key]);

export const toChangeEvent = (
  fieldPath: string,
  op: FriendlyPatchEvent['op'],
  oldValue: JsonValue | undefined,
  newValue: JsonValue | undefined,
): FriendlyPatchEvent => ({
  field: fieldPath,
  op,
  oldValue,
  newValue,
});

const mutateObjectField = (
  document: Document,
  field: MutateFieldSpec,
): { document: Document; changedPaths: string[]; patch: FriendlyPatchEvent[] } => {
  const target = resolveMutableContainer(document, field.path);
  if (!isJsonObject(target)) {
    throw new Error('Invalid mutate path');
  }

  const targetObject = target;

  const fieldPath = getMutationPath(field.path, field.key);
  const patch: FriendlyPatchEvent[] = [];

  switch (field.action) {
    case 'add': {
      const nextValue = cloneValue(field.value ?? null);
      targetObject[field.key] = nextValue;
      patch.push(toChangeEvent(fieldPath, 'added', undefined, nextValue));
      return {
        document,
        changedPaths: [fieldPath],
        patch,
      };
    }
    case 'edit': {
      const nextValue = cloneValue(field.value ?? null);
      const oldValue = typeof targetObject[field.key] === 'undefined' ? undefined : targetObject[field.key];
      if (field.nextKey && field.nextKey !== field.key) {
        delete targetObject[field.key];
        targetObject[field.nextKey] = nextValue;
        patch.push(toChangeEvent(getMutationPath(field.path, field.nextKey), 'updated', oldValue, nextValue));
        return {
          document,
          changedPaths: [fieldPath, getMutationPath(field.path, field.nextKey)],
          patch,
        };
      }

      targetObject[field.key] = nextValue;
      patch.push(toChangeEvent(fieldPath, 'updated', oldValue, nextValue));
      return {
        document,
        changedPaths: [fieldPath],
        patch,
      };
    }
    case 'delete': {
      const oldValue = typeof targetObject[field.key] === 'undefined' ? undefined : targetObject[field.key];
      delete targetObject[field.key];
      patch.push(toChangeEvent(fieldPath, 'removed', oldValue, undefined));
      return {
        document,
        changedPaths: [fieldPath],
        patch,
      };
    }
    default:
      return {
        document,
        changedPaths: [],
        patch,
      };
  }
};

const mutateArrayField = (
  document: Document,
  field: MutateFieldSpec,
): { document: Document; changedPaths: string[]; patch: FriendlyPatchEvent[] } => {
  const target = resolveMutableContainer(document, field.path);
  if (!Array.isArray(target)) {
    throw new Error('Invalid mutate path');
  }

  const index = Number(field.key);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('Invalid array index');
  }

  const pathAtIndex = getMutationPath(field.path, String(index));
  const oldValue = index < target.length ? (target[index] as JsonValue) : undefined;
  const patch: FriendlyPatchEvent[] = [];

  switch (field.action) {
    case 'add': {
      const insertIndex = Math.min(index, target.length);
      const nextValue = cloneValue(field.value ?? null);
      target.splice(insertIndex, 0, nextValue);
      patch.push(toChangeEvent(getMutationPath(field.path, String(insertIndex)), 'added', undefined, nextValue));
      return {
        document,
        changedPaths: [getMutationPath(field.path, String(insertIndex))],
        patch,
      };
    }
    case 'edit': {
      const nextValue = cloneValue(field.value ?? null);
      if (index >= target.length) {
        target.push(nextValue);
      } else {
        target[index] = nextValue;
      }
      patch.push(toChangeEvent(pathAtIndex, 'updated', oldValue, nextValue));
      return {
        document,
        changedPaths: [pathAtIndex],
        patch,
      };
    }
    case 'delete': {
      if (index >= target.length) {
        throw new Error('Array index not found');
      }
      target.splice(index, 1);
      patch.push(toChangeEvent(pathAtIndex, 'removed', oldValue, undefined));
      return {
        document,
        changedPaths: [pathAtIndex],
        patch,
      };
    }
    default:
      return {
        document,
        changedPaths: [],
        patch,
      };
  }
};

export const mutateDocumentField = (
  document: Document,
  field: MutateFieldSpec,
): { document: Document; changedPaths: string[]; patch: FriendlyPatchEvent[] } => {
  const target = resolveMutableContainer(document, field.path);
  if (field.containerType === 'array') {
    if (!Array.isArray(target)) {
      throw new Error('Invalid mutate path');
    }
    return mutateArrayField(document, field);
  }

  if (!isJsonObject(target)) {
    throw new Error('Invalid mutate path');
  }

  return mutateObjectField(document, field);
};

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
