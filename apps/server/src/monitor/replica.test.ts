import type { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { createReplica, memberChanges, readConfig, readMembers } from './replica';

const T = Date.UTC(2026, 10, 17, 9, 0, 0);
const at = (ms: number) => new Date(T + ms);

// replSetGetStatus의 멤버 하나
const member = (id: number, stateStr: string, state: number, extra: Record<string, unknown> = {}) => ({
  _id: id,
  name: `h${id}:27017`,
  health: 1,
  state,
  stateStr,
  uptime: 100,
  optimeDate: at(0),
  lastAppliedWallTime: at(0),
  pingMs: 1,
  lastHeartbeatRecv: at(-500),
  syncSourceHost: '',
  infoMessage: '',
  lastHeartbeatMessage: '',
  configVersion: 1,
  configTerm: 1,
  ...extra,
});
const status = (members: unknown[], extra: Record<string, unknown> = {}) => ({ set: 'rs0', term: 3, writeMajorityCount: 2, votingMembersCount: 3, members, ok: 1, ...extra });

describe('readMembers', () => {
  it('lag = primary의 마지막 적용 시각 − 멤버의 것, primary·arbiter·DOWN은 null', () => {
    const members = readMembers(
      status([
        member(0, 'PRIMARY', 1, { self: true, lastAppliedWallTime: at(5000), electionDate: at(-60_000), infoMessage: 'Could not find member to sync from' }),
        member(1, 'SECONDARY', 2, { lastAppliedWallTime: at(3500), syncSourceHost: 'h0:27017' }),
        member(2, 'ARBITER', 7, { lastAppliedWallTime: undefined, optimeDate: undefined }),
        member(3, '(not reachable/healthy)', 8, { health: 0, optimeDate: new Date(0), lastHeartbeatMessage: 'Connection refused' }),
      ]),
      null,
    );
    expect(members.map((m) => [m.name, m.lagMs])).toEqual([['h0:27017', null], ['h1:27017', 1500], ['h2:27017', null], ['h3:27017', null]]);
    expect(members[0]).toMatchObject({ self: true, pingMs: null, lastSeenAt: null, message: null, electedAt: T - 60_000 });
    expect(members[1]).toMatchObject({ syncSource: 'h0:27017', pingMs: 1, lastSeenAt: T - 500, electedAt: null });
    expect(members[3]).toMatchObject({ healthy: false, appliedAt: null, pingMs: null, message: 'Connection refused' });
  });

  it('primary가 없으면 가장 앞선 멤버 기준, 설정은 _id로 붙인다', () => {
    const configs = readConfig({
      members: [
        { _id: 0, votes: 1, priority: 1, hidden: false, secondaryDelaySecs: 0, tags: { dc: 'east' } },
        { _id: 1, votes: 0, priority: 0, hidden: true, slaveDelay: 3600 },
      ],
    });
    const members = readMembers(
      status([member(0, 'SECONDARY', 2, { lastAppliedWallTime: at(9000) }), member(1, 'SECONDARY', 2, { lastAppliedWallTime: undefined, optimeDate: at(4000) })]),
      configs,
    );
    expect(members.map((m) => m.lagMs)).toEqual([0, 5000]);
    expect(members[0].config).toMatchObject({ tags: { dc: 'east' }, delaySec: 0 });
    expect(members[1].config).toMatchObject({ votes: 0, priority: 0, hidden: true, delaySec: 3600, buildIndexes: true });
  });
});

describe('memberChanges', () => {
  it('상태가 바뀐 멤버, 새로 들어온·빠진 멤버', () => {
    const prev = new Map([['a', 'PRIMARY'], ['b', 'SECONDARY'], ['gone', 'SECONDARY']]);
    const now = readMembers(status([{ ...member(0, 'SECONDARY', 2), name: 'a' }, { ...member(1, 'PRIMARY', 1), name: 'b' }, { ...member(2, 'SECONDARY', 2), name: 'new' }]), null);
    expect(memberChanges(prev, now, 7)).toEqual([
      { at: 7, member: 'a', from: 'PRIMARY', to: 'SECONDARY' },
      { at: 7, member: 'b', from: 'SECONDARY', to: 'PRIMARY' },
      { at: 7, member: 'new', from: null, to: 'SECONDARY' },
      { at: 7, member: 'gone', from: 'SECONDARY', to: null },
    ]);
  });
});

describe('createReplica', () => {
  const setup = (replies: unknown[], config: unknown = { config: { version: 1, term: 1, members: [] } }) => {
    let now = T;
    let i = 0;
    const calls: string[] = [];
    const client = {
      db: () => ({
        command: async (cmd: Record<string, unknown>) => {
          const name = Object.keys(cmd)[0];
          calls.push(name);
          const next = name === 'replSetGetConfig' ? config : replies[Math.min(i++, replies.length - 1)];
          if (next instanceof Error) throw next;
          return next;
        },
      }),
    } as unknown as MongoClient;
    const replica = createReplica({ client: async () => client, clock: () => now });
    return { replica, calls, advance: (ms: number) => (now += ms) };
  };
  const err = (code: number) => Object.assign(new Error(`code ${code}`), { code });

  it('읽을 때마다 lag 칸, 상태 변화는 둘째 읽기부터 — 설정은 버전이 바뀔 때만', async () => {
    const healthy = status([member(0, 'PRIMARY', 1, { self: true, lastAppliedWallTime: at(2000) }), member(1, 'SECONDARY', 2, { lastAppliedWallTime: at(1000) })]);
    const down = status([
      member(0, 'PRIMARY', 1, { self: true, lastAppliedWallTime: at(2000), configVersion: 2 }),
      member(1, '(not reachable/healthy)', 8, { health: 0 }),
    ]);
    const { replica, calls, advance } = setup([healthy, healthy, down]);
    await replica.poll();
    advance(10_000);
    await replica.poll();
    advance(10 * 60_000);
    await replica.poll();
    expect(calls.filter((c) => c === 'replSetGetConfig')).toHaveLength(2);

    const hour = replica.report({ range: '1h' });
    expect(hour).toMatchObject({ status: 'ok', set: 'rs0', term: 3, writeMajority: 2, since: T });
    expect(hour.lag.times).toHaveLength(3);
    expect(hour.lag.series).toEqual([{ member: 'h1:27017', values: [1000, 1000, null] }]);
    expect(hour.changes).toEqual([{ at: T + 610_000, member: 'h1:27017', from: 'SECONDARY', to: '(not reachable/healthy)' }]);

    // 5m — 앞의 두 칸은 빠지고, lag 값이 없는 멤버는 선을 만들지 않는다
    const recent = replica.report({ range: '5m' });
    expect(recent.lag.times).toEqual([T + 610_000]);
    expect(recent.lag.series).toEqual([]);
    expect(recent.since).toBe(T + 610_000 - 5 * 60_000);
  });

  it('standalone(76)·mongos(59)는 다시 묻지 않고, 권한 없음(13)은 5분 뒤 다시 — 설정 권한만 없으면 설정 없이', async () => {
    const sa = setup([err(76), status([])]);
    await sa.replica.poll();
    await sa.replica.poll();
    expect(sa.calls).toEqual(['replSetGetStatus']);
    expect(sa.replica.report({ range: '1h' })).toMatchObject({ status: 'standalone', members: [], since: null });

    const mongos = setup([err(59)]);
    await mongos.replica.poll();
    expect(mongos.replica.report({ range: '1h' }).status).toBe('unsupported');

    const ok = status([member(0, 'PRIMARY', 1, { self: true })]);
    const denied = setup([err(13), ok]);
    await denied.replica.poll();
    await denied.replica.poll();
    expect(denied.calls).toEqual(['replSetGetStatus']);
    denied.advance(5 * 60_000);
    await denied.replica.poll();
    expect(denied.replica.report({ range: '1h' })).toMatchObject({ status: 'ok', members: [{ name: 'h0:27017' }] });

    const noConfig = setup([ok], err(13));
    await noConfig.replica.poll();
    expect(noConfig.replica.report({ range: '1h' })).toMatchObject({ status: 'ok', configDenied: true, members: [{ config: null }] });
  });
});
