// 서버 신분 — 기록 폴더 이름 (9-3)
//
// 주소 글자가 아니라 MongoDB가 알려 주는 값으로 정한다: localhost:27017과 127.0.0.1:27017은 같은 서버.
// 연결의 주소를 바꿨다가 되돌리면 신분이 같아서 옛 폴더에 다시 이어 붙고, 비밀번호만 바꾼 경우도 그대로 이어진다.
//   replica set + replSetGetConfig 권한  → replicaSetId(RS를 만들 때 생기는 고유 id — 멤버를 바꿔도 그대로)
//   replica set, 권한 없음                → RS 이름 + 멤버 주소 목록(RS 설정의 이름이라 접속 주소 표기와 상관없음)
//   단독 / mongos                        → 접속 주소의 호스트 목록(MongoDB가 고유 id를 주지 않는다)
// 폴더 이름엔 해시만 — 호스트 이름이 파일 이름에 드러나지 않게.
import { createHash } from 'node:crypto';
import type { MongoClient } from 'mongodb';
import { describeUri } from '../connectionUri';

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
// 파일 이름에 쓸 수 있는 글자만
const safe = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'rs';

export const clusterFingerprint = async (client: MongoClient, uri: string): Promise<string> => {
  const admin = client.db('admin');
  const hello = await admin.command({ hello: 1 });
  if (typeof hello.setName === 'string') {
    try {
      const reply = await admin.command({ replSetGetConfig: 1 });
      const id = (reply.config as { settings?: { replicaSetId?: { toHexString?: () => string } } } | undefined)?.settings?.replicaSetId;
      const hex = id?.toHexString?.();
      if (hex) return `rs-${safe(hello.setName)}-${hash(hex)}`;
    } catch {
      // 권한 없음 — 아래로
    }
    const members = [...(hello.hosts ?? []), ...(hello.passives ?? []), ...(hello.arbiters ?? [])].map(String).sort();
    return `rs-${safe(hello.setName)}-${hash(`members:${members.join(',')}`)}`;
  }
  const hosts = [...describeUri(uri).hosts].map((h) => h.toLowerCase()).sort();
  return `${hello.msg === 'isdbgrid' ? 'mongos' : 'sa'}-${hash(`hosts:${hosts.join(',')}`)}`;
};
