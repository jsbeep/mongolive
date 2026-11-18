// 활동 기록(클러스터 전체 변경 로그) — 앱 전체에서 한 번만 구독한다.
// 패널이 닫혀 있어도 계속 받아야 Activity 버튼에 '안 읽은 개수'를 띄울 수 있다.
//
// 기록의 원본은 서버 메모리(연결마다 최근 200건, 모든 브라우저 공유)다. 브라우저는 두 시점만 기억한다(localStorage, 연결마다 따로):
//   clearedAt — '비우기'를 누른 시점. 그 이전 기록은 서버가 다시 보내도 숨긴다(서버 기록은 그대로).
//   seenAt    — 마지막으로 '모두 읽음'을 누른 시점. 그 이후 기록 = 안 읽음(목록에 하늘색, 버튼에 초록 점).
//               탭을 연다고 자동으로 읽음 처리하지 않는다 — 어디부터 안 봤는지 보여주기 위해.
//   readIds   — 눌러서 바로가기 한 기록(하나씩 읽음). 최근 MAX_ENTRIES개만 기억한다.
// 시점은 브라우저 시계가 아니라 기록의 serverTime(서버 시계)으로 잰다 — 두 기기 시계가 달라도 어긋나지 않게.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LiveLogEntry } from '../types/explorer';
import { api, dataSourceKind } from '../services/api';
import { connectionScoped, type ConnectionScoped } from '../services/connectionStorage';

const MAX_ENTRIES = 300;
// 이 훅을 쓰는 페이지는 연결이 바뀌면 다시 만들어지므로(App의 key) 처음 읽을 때 지금 연결의 값이 나온다
const CLEARED = connectionScoped('mongolive.activity.clearedAt');
const SEEN = connectionScoped('mongolive.activity.seenAt');
const READ = connectionScoped('mongolive.activity.readIds');

const readIdsOf = (): Set<string> => {
  try {
    const list: unknown = JSON.parse(READ.read() ?? '[]');
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
};

const readTime = (storage: ConnectionScoped): number | null => {
  const n = Number(storage.read());
  return Number.isFinite(n) && n > 0 ? n : null;
};
// 저장 공간이 꽉 차도 기능은 동작한다(새로고침하면 잊을 뿐)
const writeTime = (storage: ConnectionScoped, value: number) => storage.write(String(value));

export interface ActivityLog {
  // 비운 시점 이후의 기록, 최신이 앞
  entries: LiveLogEntry[];
  // 이 시점(serverTime) 이후 기록이 안 읽음. null = 아직 기준 없음(첫 접속 직후)
  seenAt: number | null;
  unread: number;
  // 하나씩 읽은 기록(바로가기로 누른 것)
  readIds: ReadonlySet<string>;
  clear: () => void;
  markSeen: () => void;
  markRead: (ids: string[]) => void;
}

export function useActivityLog(): ActivityLog {
  const [all, setAll] = useState<LiveLogEntry[]>([]);
  const [clearedAt, setClearedAt] = useState<number>(() => readTime(CLEARED) ?? 0);
  // null = 이 브라우저에서 처음 — 첫 기록 묶음(backlog)을 받으면 '다 읽음'으로 시작한다
  const [seenAt, setSeenAt] = useState<number | null>(() => readTime(SEEN));
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(readIdsOf);

  useEffect(() => {
    if (dataSourceKind !== 'remote') return;
    return api.onActivityLog((incoming, isBacklog) => {
      setAll((prev) => {
        // 재연결 때 backlog가 다시 오므로 id로 중복을 거르고, 시간순(최신이 앞)으로 맞춘다
        const seen = new Set(prev.map((e) => e.id));
        const fresh = incoming.filter((e) => !seen.has(e.id));
        if (fresh.length === 0) return prev;
        return [...fresh, ...prev].sort((a, b) => b.serverTime - a.serverTime).slice(0, MAX_ENTRIES);
      });
      if (isBacklog) {
        const newest = incoming.reduce((max, e) => Math.max(max, e.serverTime), 0);
        setSeenAt((current) => {
          if (current !== null || newest === 0) return current;
          writeTime(SEEN, newest);
          return newest;
        });
      }
    });
  }, []);

  const entries = useMemo(() => all.filter((e) => e.serverTime > clearedAt), [all, clearedAt]);
  // 이 탭이 한 저장(own)은 안 읽음으로 세지 않는다 — 방금 내가 한 일이므로
  const unread = useMemo(
    () => (seenAt === null ? 0 : entries.filter((e) => e.serverTime > seenAt && !e.own && !readIds.has(e.id)).length),
    [entries, seenAt, readIds],
  );

  const newestTime = entries[0]?.serverTime;

  const clear = useCallback(() => {
    if (newestTime === undefined) return;
    setClearedAt(newestTime);
    writeTime(CLEARED, newestTime);
  }, [newestTime]);

  const markSeen = useCallback(() => {
    if (newestTime === undefined) return;
    setSeenAt((current) => {
      if (current !== null && current >= newestTime) return current;
      writeTime(SEEN, newestTime);
      return newestTime;
    });
  }, [newestTime]);

  const markRead = useCallback((ids: string[]) => {
    setReadIds((prev) => {
      const fresh = ids.filter((id) => !prev.has(id));
      if (fresh.length === 0) return prev;
      const next = [...prev, ...fresh].slice(-MAX_ENTRIES);
      READ.write(JSON.stringify(next));
      return new Set(next);
    });
  }, []);

  return { entries, seenAt, unread, readIds, clear, markSeen, markRead };
}
