// 레플리카 셋 멤버 (9-7a) — Monitor › Server의 Members 카드·Lag 차트·상태 변화
//
// 샘플러 박자(10초)마다 replSetGetStatus를 한 번 묻는다(읽기 전용, 멤버당 약 1KB). 연결한 멤버(보통 primary)가 아는 멤버 상태다.
//   lag = primary가 마지막으로 적용한 쓰기의 시각 − 그 멤버가 마지막으로 적용한 쓰기의 시각 (lastAppliedWallTime, ms 단위)
//         optime/optimeDate는 하트비트(2초) 주기로만 바뀌고 초 단위라 쓰지 않는다(없을 때만 대신 쓴다)
//         쓰기가 드물면 실제보다 크게 보일 수 있다 — primary의 두 쓰기 사이 간격이 그대로 lag로 잡힌다
//   상태 변화 = 지난 읽기와 stateStr이 다른 멤버(primary 교체, DOWN 등)
// lag·변화는 최근 1시간만 메모리에 둔다(파일에 적지 않는다 — 피드가 닫히면 사라진다).
// 설정(votes·priority·hidden·delay)은 replSetGetConfig로 — 처음과 설정 버전이 바뀔 때만 읽는다.
// standalone(76)·mongos/Atlas(59/8000)는 다시 묻지 않는다. 권한이 없으면(13) 5분 뒤 다시.
// primary가 없어도(선거 중·과반 잃음) 읽을 수 있게 primaryPreferred로 묻는다 — 그땐 secondary가 본 상태다(화면에 표시).
import type { MongoClient } from 'mongodb';
import type { ActivityRange, ReplicaChange, ReplicaMember, ReplicaMemberConfig, ReplicaReport } from '@mongolive/shared';
import { isUnauthorized } from './operations';
import { withTimeout } from './sampler';
import { RANGE_MS } from './slowQueries';

const MINUTE = 60_000;
const KEEP_MS = 60 * MINUTE;
const DENIED_RETRY_MS = 5 * MINUTE;
const MAX_CHANGES = 200;
const NO_REPLICATION = 76;
const COMMAND_NOT_FOUND = 59;
const ATLAS_ERROR = 8000;
const PRIMARY = 1;
const ARBITER = 7;
// 이 탭이 가장 필요한 때가 primary가 없을 때라서 — 기본(primary)이면 서버 선택에서 5초 기다리다 실패한다
const ANY_MEMBER = { readPreference: 'primaryPreferred' } as const;

type Raw = Record<string, unknown>;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown) => Number((e as { code?: unknown })?.code);
// 숫자·Long → number. 없으면 null
const num = (value: unknown): number | null => {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) return (value as { toNumber: () => number }).toNumber();
  return null;
};
// Date → ms. 1970(모름) → null
const time = (value: unknown): number | null => (value instanceof Date && value.getTime() > 0 ? value.getTime() : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

// replSetGetConfig의 멤버 _id → 설정
export const readConfig = (config: Raw | undefined): Map<number, ReplicaMemberConfig> => {
  const out = new Map<number, ReplicaMemberConfig>();
  for (const m of (Array.isArray(config?.members) ? config.members : []) as Raw[]) {
    const id = num(m._id);
    if (id === null) continue;
    const tags = m.tags && typeof m.tags === 'object' ? Object.fromEntries(Object.entries(m.tags).map(([k, v]) => [k, String(v)])) : {};
    out.set(id, {
      votes: num(m.votes) ?? 1,
      priority: num(m.priority) ?? 1,
      hidden: m.hidden === true,
      arbiterOnly: m.arbiterOnly === true,
      // 5.0부터 secondaryDelaySecs, 그 전엔 slaveDelay
      delaySec: num(m.secondaryDelaySecs) ?? num(m.slaveDelay) ?? 0,
      buildIndexes: m.buildIndexes !== false,
      tags,
    });
  }
  return out;
};

// replSetGetStatus → 멤버 목록(lag 포함). 설정은 따로 붙인다
export const readMembers = (status: Raw, configs: Map<number, ReplicaMemberConfig> | null): ReplicaMember[] => {
  const raws = (Array.isArray(status.members) ? status.members : []) as Raw[];
  const members = raws.map((m): ReplicaMember & { stateCode: number } => {
    const stateCode = num(m.state) ?? -1;
    const healthy = num(m.health) === 1;
    const id = num(m._id) ?? -1;
    const self = m.self === true;
    return {
      id,
      name: String(m.name ?? `member ${id}`),
      state: String(m.stateStr ?? stateCode),
      stateCode,
      healthy,
      self,
      uptimeSec: num(m.uptime),
      appliedAt: healthy && stateCode !== ARBITER ? time(m.lastAppliedWallTime) ?? time(m.optimeDate) : null,
      lagMs: null,
      pingMs: self || !healthy ? null : num(m.pingMs),
      lastSeenAt: self ? null : time(m.lastHeartbeatRecv),
      syncSource: text(m.syncSourceHost),
      message: text(m.lastHeartbeatMessage) ?? (stateCode === PRIMARY ? null : text(m.infoMessage)),
      electedAt: stateCode === PRIMARY ? time(m.electionDate) : null,
      config: configs?.get(id) ?? null,
    };
  });
  const primary = members.find((m) => m.stateCode === PRIMARY && m.appliedAt !== null);
  const applied = members.map((m) => m.appliedAt).filter((v): v is number => v !== null);
  const base = primary?.appliedAt ?? (applied.length > 0 ? Math.max(...applied) : null);
  return members.map(({ stateCode, ...m }) => ({
    ...m,
    lagMs: base !== null && m.appliedAt !== null && stateCode !== PRIMARY ? Math.max(0, base - m.appliedAt) : null,
  }));
};

// 지난 읽기와 상태가 달라진 멤버 — 빠진 멤버는 to null, 새 멤버는 from null
export const memberChanges = (prev: Map<string, string>, members: ReplicaMember[], at: number): ReplicaChange[] => {
  const out: ReplicaChange[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    seen.add(m.name);
    const before = prev.get(m.name);
    if (before !== m.state) out.push({ at, member: m.name, from: before ?? null, to: m.state });
  }
  for (const [name, state] of prev) if (!seen.has(name)) out.push({ at, member: name, from: state, to: null });
  return out;
};

export interface ReplicaHooks {
  client: () => Promise<MongoClient>;
  clock?: () => number;
}

export interface Replica {
  // 샘플러 박자마다 — 실패해도 던지지 않는다
  poll: () => Promise<void>;
  // 주소가 바뀜(다른 서버일 수 있다) — 지난 값을 버리고 처음부터
  reset: () => void;
  report: (query: { range: ActivityRange }) => ReplicaReport;
  // 레플리카 셋인지 — Oplog 카드가 standalone·mongos면 묻지 않으려고
  status: () => ReplicaReport['status'];
}

interface LagPoint {
  at: number;
  lag: Map<string, number | null>;
}

export const createReplica = (hooks: ReplicaHooks): Replica => {
  const clock = hooks.clock ?? Date.now;
  let status: ReplicaReport['status'] = 'ok';
  let error: string | null = null;
  let retryAt = 0;
  let generation = 0;
  let last: { at: number; set: string | null; term: number | null; writeMajority: number | null; votingMembers: number | null; members: ReplicaMember[] } | null = null;
  let firstAt: number | null = null;
  let states: Map<string, string> | null = null;
  let points: LagPoint[] = [];
  let changes: ReplicaChange[] = [];
  // 설정 — 읽은 버전·term이 멤버의 configVersion·configTerm과 다르면 다시 읽는다
  let configs: Map<number, ReplicaMemberConfig> | null = null;
  let configKey: string | null = null;
  let configDenied = false;
  let configRetryAt = 0;

  const loadConfig = async (client: MongoClient, key: string | null, gen: number) => {
    if (key === null || key === configKey || clock() < configRetryAt) return;
    try {
      const reply = await withTimeout(client.db('admin').command({ replSetGetConfig: 1 }, ANY_MEMBER));
      if (gen !== generation) return;
      const config = reply.config as Raw | undefined;
      configs = readConfig(config);
      configKey = `${num(config?.version)}/${num(config?.term)}`;
      configDenied = false;
    } catch (e) {
      if (gen !== generation) return;
      if (isUnauthorized(e)) {
        configDenied = true;
        configs = null;
      }
      // 실패하면 5분 뒤 다시(그동안 설정 없이 보여 준다)
      configRetryAt = clock() + DENIED_RETRY_MS;
    }
  };

  return {
    async poll() {
      if (status === 'standalone' || status === 'unsupported' || clock() < retryAt) return;
      const gen = generation;
      try {
        const client = await hooks.client();
        const reply = (await withTimeout(client.db('admin').command({ replSetGetStatus: 1 }, ANY_MEMBER))) as Raw;
        if (gen !== generation) return;
        const self = ((Array.isArray(reply.members) ? reply.members : []) as Raw[]).find((m) => m.self === true);
        await loadConfig(client, self ? `${num(self.configVersion)}/${num(self.configTerm)}` : null, gen);
        if (gen !== generation) return;
        const at = clock();
        const members = readMembers(reply, configs);
        if (states) changes.push(...memberChanges(states, members, at));
        states = new Map(members.map((m) => [m.name, m.state]));
        points.push({ at, lag: new Map(members.filter((m) => m.appliedAt !== null).map((m) => [m.name, m.lagMs])) });
        const cutoff = at - KEEP_MS;
        points = points.filter((p) => p.at >= cutoff);
        changes = changes.filter((c) => c.at >= cutoff).slice(-MAX_CHANGES);
        firstAt ??= at;
        last = {
          at,
          set: text(reply.set),
          term: num(reply.term),
          writeMajority: num(reply.writeMajorityCount),
          votingMembers: num(reply.votingMembersCount),
          members,
        };
        status = 'ok';
        error = null;
      } catch (e) {
        if (gen !== generation) return;
        const code = codeOf(e);
        if (isUnauthorized(e)) {
          status = 'denied';
          retryAt = clock() + DENIED_RETRY_MS;
        } else if (code === NO_REPLICATION) {
          status = 'standalone';
        } else if (code === COMMAND_NOT_FOUND || code === ATLAS_ERROR) {
          status = 'unsupported';
        } else {
          // 잠깐의 실패(시간 초과 등) — 지난 값을 두고 다음 박자에 다시
          status = 'error';
          error = errorMessage(e);
        }
      }
    },
    reset() {
      generation += 1;
      status = 'ok';
      error = null;
      retryAt = 0;
      last = null;
      firstAt = null;
      states = null;
      points = [];
      changes = [];
      configs = null;
      configKey = null;
      configDenied = false;
      configRetryAt = 0;
    },
    status: () => status,
    report({ range }) {
      const from = clock() - (RANGE_MS[range] ?? KEEP_MS);
      const kept = points.filter((p) => p.at >= from);
      // 기간 안에 lag 값이 한 번이라도 있던 멤버 — 지금 멤버 순서, 빠진 멤버는 뒤에
      const names: string[] = [];
      for (const m of last?.members ?? []) if (kept.some((p) => p.lag.get(m.name) != null)) names.push(m.name);
      for (const p of kept) for (const [name, lag] of p.lag) if (lag !== null && !names.includes(name)) names.push(name);
      const ok = status === 'ok' || status === 'error';
      return {
        status,
        error,
        at: ok ? last?.at ?? null : null,
        set: ok ? last?.set ?? null : null,
        term: ok ? last?.term ?? null : null,
        writeMajority: ok ? last?.writeMajority ?? null : null,
        votingMembers: ok ? last?.votingMembers ?? null : null,
        members: ok ? last?.members ?? [] : [],
        configDenied,
        since: ok && firstAt !== null ? Math.max(firstAt, from) : null,
        lag: {
          times: kept.map((p) => p.at),
          series: names.map((member) => ({ member, values: kept.map((p) => p.lag.get(member) ?? null) })),
        },
        changes: changes.filter((c) => c.at >= from),
      };
    },
  };
};
