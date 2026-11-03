// 문서 프로젝션 — 참조 미리보기에서 경로 하나만 남기고 나머지 컨테이너는 비운다.
import type { Document } from './contract';
import { isContainer, isEjsonObject, valueKind, type EjsonObject, type EjsonValue } from './ejson';

// 프로젝션 미리보기 — 컨테이너는 비우고 스칼라(래퍼 포함)는 그대로 둔다
const previewValue = (value: EjsonValue): EjsonValue => {
  if (!isContainer(value)) {
    return value;
  }

  return valueKind(value) === 'array' ? [] : {};
};

const shallowDocument = (document: Document): Document => {
  const preview: EjsonObject = {};
  for (const [key, value] of Object.entries(document)) {
    preview[key] = previewValue(value as EjsonValue);
  }
  return preview as Document;
};

const projectValue = (value: EjsonValue, path: string[]): EjsonValue => {
  if (path.length === 0) {
    return previewValue(value);
  }

  const [segment, ...rest] = path;

  if (Array.isArray(value)) {
    const index = Number(segment);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      throw new Error('Projection path not found');
    }

    return [projectValue(value[index], rest)];
  }

  if (!isEjsonObject(value)) {
    throw new Error('Projection path not found');
  }

  const objectValue: EjsonObject = value;
  if (!(segment in objectValue)) {
    throw new Error('Projection path not found');
  }

  const nextValue = objectValue[segment];
  const projected: EjsonObject = {
    [segment]: projectValue(nextValue, rest),
  };

  return projected;
};

export const projectDocument = (document: Document, projectionPath?: string[]): Document => {
  if (!projectionPath || projectionPath.length === 0) {
    return shallowDocument(document);
  }

  return projectValue(document, projectionPath) as Document;
};
