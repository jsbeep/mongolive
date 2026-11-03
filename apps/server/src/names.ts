// URL로 들어온 DB/컬렉션 이름 검사. 시스템 DB·컬렉션은 이 앱에서 보이지도, 건드리지도 못하게 한다.

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// MongoDB 내부용 DB
export const HIDDEN_DATABASES = new Set(['admin', 'local', 'config']);

// MongoDB DB 이름 규칙: 64바이트 미만, / \ . " $ * < > : | ? 공백 NUL 불가
const DB_NAME = /^[^/\\. "$*<>:|?\0]{1,63}$/;

export const checkDatabaseName = (name: string): string => {
  if (!DB_NAME.test(name)) throw new HttpError(400, `잘못된 DB 이름: ${name}`);
  if (HIDDEN_DATABASES.has(name)) throw new HttpError(403, `접근할 수 없는 DB: ${name}`);
  return name;
};

export const isHiddenCollection = (name: string): boolean => name.startsWith('system.');

export const checkCollectionName = (name: string): string => {
  if (name.length === 0 || name.length > 255 || name.includes('\0') || name.includes('$')) {
    throw new HttpError(400, `잘못된 컬렉션 이름: ${name}`);
  }
  if (isHiddenCollection(name)) throw new HttpError(403, `접근할 수 없는 컬렉션: ${name}`);
  return name;
};
