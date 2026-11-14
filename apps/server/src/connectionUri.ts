// 접속 주소(MongoDB URI) 다루기 — 비밀 값 가리기 / 되돌려 채우기 / 카드에 보일 정보 / 문법 검사.
//
//   mongodb://user:pass@h1:27017,h2:27017/db?replicaSet=rs0&tlsCertificateKeyFilePassword=xyz
//   └scheme┘ └user┘└pw┘ └────── hosts ──────┘└──────────── rest(경로 + 옵션) ───────────────┘
//
// 브라우저에는 pw와 비밀 옵션 값을 URI_SECRET_MASK로 바꾼 주소만 보낸다. 편집 화면에서 그 표시를 그대로 두고
// 저장하면 서버가 원래 값으로 채운다 — 단, 보낼 곳(호스트·사용자·인증 방식·프록시·TLS)이 그대로일 때만.
// 그렇지 않으면 "호스트만 내 서버로 바꾸고 테스트"로 저장된 비밀번호를 빼낼 수 있기 때문이다.
import { MongoClient } from 'mongodb';
import { URI_SECRET_MASK } from '@mongolive/shared';
import { HttpError } from './names';

// 드라이버(mongodb-connection-string-url)와 같은 규칙으로 나눈다. 드라이버가 받아 주는 주소라면
// 비밀번호에 : / ? # [ ] @가 그대로 들어 있을 수 없으므로(퍼센트 인코딩해야 함) 경계가 분명하다.
const URI_PARTS = /^(?<scheme>[^/]+):\/\/(?:(?<username>[^:@]*)(?::(?<password>[^@]*))?@)?(?<hosts>(?!:)[^/?@]*)(?<rest>.*)$/s;

// 값이 비밀일 수 있는 옵션(소문자로 비교)
const SECRET_OPTIONS = new Set(['authmechanismproperties', 'tlscertificatekeyfilepassword', 'sslpemkeypassword', 'proxypassword']);

// 바뀌면 가린 값을 채워 주지 않는 옵션 — 비밀번호가 '어디로, 어떻게' 가는지를 바꾼다
//   authMechanism=PLAIN이면 비밀번호가 그대로 전송되고, proxy*는 경로를, tls*는 암호화·인증서 검사를 바꾼다
const ROUTING_OPTIONS = [
  'authmechanism',
  'proxyhost',
  'proxyport',
  'proxyusername',
  'tls',
  'ssl',
  'tlsinsecure',
  'tlsallowinvalidcertificates',
  'tlsallowinvalidhostnames',
];

export const MAX_URI_LENGTH = 8192;

interface UriParts {
  scheme: string;
  username: string | null;
  password: string | null;
  hosts: string;
  path: string;
  // 옵션을 원래 순서·표기 그대로. key/value는 인코딩된 채(raw)
  options: { key: string; value: string }[];
}

const safeDecode = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const parse = (uri: string): UriParts | null => {
  const groups = URI_PARTS.exec(uri)?.groups;
  if (!groups) return null;
  const { rest } = groups;
  const q = rest.indexOf('?');
  const path = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? '' : rest.slice(q + 1);
  const options = query
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1 ? { key: pair, value: '' } : { key: pair.slice(0, eq), value: pair.slice(eq + 1) };
    });
  return {
    scheme: groups.scheme,
    username: groups.username ?? null,
    password: groups.password ?? null,
    hosts: groups.hosts,
    path,
    options,
  };
};

const format = (parts: UriParts): string => {
  const auth =
    parts.username !== null || parts.password !== null
      ? `${parts.username ?? ''}${parts.password !== null ? `:${parts.password}` : ''}@`
      : '';
  const query = parts.options.map(({ key, value }) => `${key}=${value}`).join('&');
  return `${parts.scheme}://${auth}${parts.hosts}${parts.path}${query ? `?${query}` : ''}`;
};

const optionKey = (raw: string) => safeDecode(raw).toLowerCase();
const isMask = (raw: string | null) => raw !== null && safeDecode(raw) === URI_SECRET_MASK;

// 비밀번호와 비밀 옵션 값을 가린 주소. 저장된 주소는 이미 검사를 통과한 것이라 나뉘지 않는 경우는 없지만,
// 혹시 그래도 원문을 내보내지 않고 통째로 가린다
export const maskUri = (uri: string): string => {
  const parts = parse(uri);
  if (!parts) return URI_SECRET_MASK;
  return format({
    ...parts,
    password: parts.password ? URI_SECRET_MASK : parts.password,
    options: parts.options.map((o) => (SECRET_OPTIONS.has(optionKey(o.key)) && o.value ? { ...o, value: URI_SECRET_MASK } : o)),
  });
};

const optionValues = (parts: UriParts, key: string): string[] =>
  parts.options.filter((o) => optionKey(o.key) === key).map((o) => safeDecode(o.value).toLowerCase());

// 비밀 값이 갈 곳이 그대로인가
const sameDestination = (a: UriParts, b: UriParts): boolean =>
  a.scheme.toLowerCase() === b.scheme.toLowerCase() &&
  safeDecode(a.username ?? '') === safeDecode(b.username ?? '') &&
  a.hosts.toLowerCase() === b.hosts.toLowerCase() &&
  ROUTING_OPTIONS.every((key) => optionValues(a, key).join(',') === optionValues(b, key).join(','));

const REENTER = '주소의 호스트·사용자·인증 방식·프록시·TLS 설정이 바뀌어 저장된 비밀 값을 그대로 쓸 수 없습니다. 비밀번호(가려진 ••••••)를 다시 입력하세요.';

// 브라우저가 보낸 주소의 가린 자리(URI_SECRET_MASK)를 저장된 주소(stored)의 원래 값으로 채운다.
// 가린 자리가 없으면 보낸 그대로. stored가 없거나(새 연결) 보낼 곳이 바뀌었으면 400.
export const restoreUri = (submitted: string, stored: string | null): string => {
  const trimmed = submitted.trim();
  const next = parse(trimmed);
  if (!next) return trimmed; // 문법 오류는 checkUri가 알려 준다
  const maskedPassword = isMask(next.password);
  const maskedOptions = next.options.filter((o) => isMask(o.value));
  if (!maskedPassword && maskedOptions.length === 0) return trimmed;

  const prev = stored === null ? null : parse(stored);
  if (!prev) throw new HttpError(400, '가려진 비밀 값(••••••)을 채울 저장된 주소가 없습니다. 실제 값을 입력하세요.');
  if (!sameDestination(prev, next)) throw new HttpError(400, REENTER);

  const restored: UriParts = { ...next, options: next.options.map((o) => ({ ...o })) };
  if (maskedPassword) {
    if (!prev.password) throw new HttpError(400, '저장된 비밀번호가 없습니다. 비밀번호를 입력하세요.');
    restored.password = prev.password;
  }
  for (const option of restored.options) {
    if (!isMask(option.value)) continue;
    const original = prev.options.find((o) => optionKey(o.key) === optionKey(option.key));
    if (!original?.value || isMask(original.value)) {
      throw new HttpError(400, `저장된 ${safeDecode(option.key)} 값이 없습니다. 값을 입력하세요.`);
    }
    option.value = original.value;
  }
  return format(restored);
};

// 카드에 보일 정보(비밀 아님)
export const describeUri = (uri: string): { srv: boolean; hosts: string[]; username: string | null } => {
  const parts = parse(uri);
  if (!parts) return { srv: false, hosts: [], username: null };
  return {
    srv: parts.scheme.toLowerCase() === 'mongodb+srv',
    hosts: parts.hosts.split(',').filter(Boolean),
    username: parts.username ? safeDecode(parts.username) : null,
  };
};

// 저장 전 문법 검사. 드라이버가 클라이언트를 만들 때 하는 검사를 그대로 쓴다(만들기만 하고 접속은 하지 않는다).
// 가린 표시가 남아 있으면(채울 수 없었던 것) 실제 비밀번호로 저장되지 않게 막는다.
export const checkUri = (uri: string): string => {
  const trimmed = uri.trim();
  if (!trimmed) throw new HttpError(400, '접속 주소를 입력하세요.');
  if (trimmed.length > MAX_URI_LENGTH) throw new HttpError(400, `접속 주소가 너무 깁니다(최대 ${MAX_URI_LENGTH}자).`);
  if (!/^mongodb(\+srv)?:\/\//i.test(trimmed)) throw new HttpError(400, '접속 주소는 mongodb:// 또는 mongodb+srv://로 시작해야 합니다.');
  if (trimmed.includes(URI_SECRET_MASK)) throw new HttpError(400, '가려진 값(••••••)이 남아 있습니다. 실제 값을 입력하세요.');
  try {
    new MongoClient(trimmed);
  } catch (e) {
    throw new HttpError(400, `접속 주소 형식이 올바르지 않습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  return trimmed;
};
