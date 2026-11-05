// 필드 하나 바꾸기(MutateFieldSpec) — Mock과 서버가 같은 규칙을 쓰도록 여기 둔다.
// 문서를 제자리에서 고친다(호출하는 쪽이 복제본을 넘긴다). 값은 Canonical EJSON.
import type { Document, FriendlyPatchEvent, MutateFieldSpec } from './contract';
import { isEjsonObject, type EjsonObject, type EjsonValue } from './ejson';

const isJsonObject = (value: unknown): value is EjsonObject => isEjsonObject(value);

// 컨테이너(객체/배열)만 새로 만들고 래퍼 리프({$oid} 등)는 그대로 공유한다 — 래퍼는 통째로만 교체된다
export const cloneValue = (value: EjsonValue): EjsonValue => {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (isJsonObject(value)) {
    const next: EjsonObject = {};
    for (const [key, child] of Object.entries(value)) next[key] = cloneValue(child);
    return next;
  }
  return value;
};

export const resolveMutableContainer = (document: Document, path: string[]): EjsonValue | undefined => {
  let current: EjsonValue = document;
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
  oldValue: EjsonValue | undefined,
  newValue: EjsonValue | undefined,
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
  const oldValue = index < target.length ? (target[index] as EjsonValue) : undefined;
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
