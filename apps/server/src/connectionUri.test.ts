import { describe, expect, it } from 'vitest';
import { URI_SECRET_MASK as M } from '@mongolive/shared';
import { checkUri, describeUri, maskUri, restoreUri } from './connectionUri';
import { HttpError } from './names';

const STORED = 'mongodb://admin:s3cr%40t@h1:27017,h2:27017/app?replicaSet=rs0&tlsCertificateKeyFilePassword=kp&authSource=admin';

const rejects = (run: () => unknown) => {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    return;
  }
  throw new Error('거절되지 않았습니다');
};

describe('maskUri', () => {
  it('비밀번호와 비밀 옵션만 가리고 나머지는 그대로', () => {
    expect(maskUri(STORED)).toBe(`mongodb://admin:${M}@h1:27017,h2:27017/app?replicaSet=rs0&tlsCertificateKeyFilePassword=${M}&authSource=admin`);
  });

  it('비밀번호가 없으면 바꾸지 않는다', () => {
    expect(maskUri('mongodb://localhost:27017/')).toBe('mongodb://localhost:27017/');
    expect(maskUri('mongodb+srv://reader@cluster0.example.net')).toBe('mongodb+srv://reader@cluster0.example.net');
  });

  it('옵션 이름은 대소문자를 가리지 않는다', () => {
    expect(maskUri('mongodb://h/?PROXYPASSWORD=pp&authMechanismProperties=AWS_SESSION_TOKEN:t')).toBe(
      `mongodb://h/?PROXYPASSWORD=${M}&authMechanismProperties=${M}`,
    );
  });

  it('나뉘지 않는 주소는 원문 대신 통째로 가린다', () => {
    expect(maskUri('not a uri')).toBe(M);
  });
});

describe('restoreUri', () => {
  it('가린 그대로 돌아오면 원래 값으로 채운다', () => {
    expect(restoreUri(maskUri(STORED), STORED)).toBe(STORED);
  });

  it('보낼 곳이 같으면 다른 옵션을 고쳐도 채운다', () => {
    const edited = maskUri(STORED).replace('authSource=admin', 'authSource=admin&appName=x');
    expect(restoreUri(edited, STORED)).toBe(`${STORED}&appName=x`);
  });

  it('새 비밀번호를 넣으면 그 값을 쓴다', () => {
    const edited = maskUri(STORED).replace(`admin:${M}@`, 'admin:new@');
    expect(restoreUri(edited, STORED)).toContain('admin:new@');
  });

  it('호스트·사용자·scheme이 바뀌면 채우지 않는다', () => {
    rejects(() => restoreUri(maskUri(STORED).replace('h1:27017,h2:27017', 'evil.example:27017'), STORED));
    rejects(() => restoreUri(maskUri(STORED).replace('admin:', 'root:'), STORED));
    rejects(() => restoreUri(maskUri(STORED).replace('mongodb://', 'mongodb+srv://'), STORED));
  });

  it('인증 방식·프록시·TLS 설정이 바뀌면 채우지 않는다', () => {
    rejects(() => restoreUri(`${maskUri(STORED)}&authMechanism=PLAIN`, STORED));
    rejects(() => restoreUri(`${maskUri(STORED)}&proxyHost=evil.example`, STORED));
    rejects(() => restoreUri(`${maskUri(STORED)}&tlsAllowInvalidCertificates=true`, STORED));
  });

  it('저장된 주소나 값이 없으면 채울 수 없다', () => {
    rejects(() => restoreUri(`mongodb://admin:${M}@h1`, null));
    rejects(() => restoreUri(`mongodb://admin:${M}@h1`, 'mongodb://admin@h1'));
    rejects(() => restoreUri(`mongodb://h1/?proxyPassword=${M}`, 'mongodb://h1/'));
  });

  it('가린 자리가 없으면 보낸 그대로(앞뒤 공백만 뺀다)', () => {
    expect(restoreUri('  mongodb://other:27017  ', STORED)).toBe('mongodb://other:27017');
  });
});

describe('describeUri', () => {
  it('카드에 보일 호스트·사용자', () => {
    expect(describeUri(STORED)).toEqual({ srv: false, hosts: ['h1:27017', 'h2:27017'], username: 'admin' });
    expect(describeUri('mongodb+srv://a%40b@cluster0.example.net/')).toEqual({ srv: true, hosts: ['cluster0.example.net'], username: 'a@b' });
  });
});

describe('checkUri', () => {
  it('올바른 주소는 다듬어 돌려준다', () => {
    expect(checkUri(' mongodb://localhost:27017/ ')).toBe('mongodb://localhost:27017/');
  });

  it('잘못된 주소·가린 표시가 남은 주소는 거절', () => {
    rejects(() => checkUri(''));
    rejects(() => checkUri('http://localhost'));
    rejects(() => checkUri('mongodb://u:p@ss@host'));
    rejects(() => checkUri(`mongodb://u:${M}@host`));
    rejects(() => checkUri('mongodb://host/?notARealOption=1&replicaSet='));
  });
});
