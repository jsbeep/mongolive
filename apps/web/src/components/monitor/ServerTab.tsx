// Monitor › Server (9-7) — 서버 전체 기준. 범위 바의 DB·컬렉션과는 상관없다.
//   Members (9-7a): replSetGetStatus — 멤버마다 상태·lag·ping·마지막 하트비트·동기화 소스, 설정 배지(hidden·delayed·votes 0 …)
//                    lag 차트·상태 변화는 서버가 10초마다 읽어 최근 1시간만 메모리에 둔다(긴 기간이면 최근 1시간을 보여 주고 그렇다고 적는다)
// 10초마다 묻는다(탭이 안 보이면 쉼). standalone·mongos·권한 없음은 안내 한 줄.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, CircleAlert, Loader2 } from 'lucide-react';
import type { MongoTopology, MonitorRange, ReplicaChange, ReplicaMember, ReplicaReport } from '../../types/explorer';
import { LIVE_RANGES } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { TimeChart, type ChartSeries } from './charts';
import { chartWindow, fmtAgo, fmtClock, fmtDateTime, fmtDuration, fmtMs, fmtUptime, RANGE_LABEL } from './format';

const POLL_MS = 10_000;
const C = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'] as const;
// 이보다 뒤처지면 눈에 띄게(일부러 늦추는 delayed 멤버는 그 시간만큼 더 봐준다)
const LAG_WARN_MS = 10_000;
// 하트비트는 2초마다 — 이보다 오래 소식이 없으면 눈에 띄게
const SEEN_WARN_MS = 10_000;

const styles = {
  body: 'flex flex-col gap-4 px-4 pb-5 pt-3',
  sectionTitle: 'text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400',
  card: 'flex min-w-0 flex-col gap-2 rounded-xl border border-slate-200/70 bg-white px-3.5 pb-3 pt-3',
  title: 'text-[13px] font-semibold text-slate-800',
  sub: 'text-[11px] text-slate-500',
  note: 'flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-slate-500',
  warn: 'flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-amber-800',
  table: 'w-full border-collapse text-[12px]',
  th: 'whitespace-nowrap px-2 py-1.5 text-left text-[11px] font-medium text-slate-500',
  td: 'whitespace-nowrap px-2 py-1.5 align-middle text-slate-700',
  num: 'text-right tabular-nums',
  muted: 'text-slate-400',
  badge: 'rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-500',
  grid: 'grid grid-cols-1 gap-3 lg:grid-cols-2',
} as const;

const DOWN = '(not reachable/healthy)';
// 상태 이름 — 색만으로 구분하지 않게 글자도 같이. DOWN은 짧게
const stateLabel = (state: string) => (state === DOWN ? 'Down' : state);
const stateTone = (state: string, healthy: boolean) => {
  if (!healthy || state === DOWN) return 'bg-rose-50 text-rose-700';
  if (state === 'PRIMARY') return 'bg-emerald-50 text-emerald-700';
  if (state === 'SECONDARY') return 'bg-sky-50 text-sky-700';
  if (state === 'ARBITER') return 'bg-slate-100 text-slate-600';
  // STARTUP·STARTUP2·RECOVERING·ROLLBACK·REMOVED·UNKNOWN — 아직 일을 못 받는 상태
  return 'bg-amber-50 text-amber-800';
};
const STATE_TIP: Record<string, string> = {
  PRIMARY: 'Takes all writes',
  SECONDARY: 'Copies the primary’s writes and can serve reads',
  ARBITER: 'Votes in elections, holds no data',
  STARTUP: 'Starting — has not read its config yet',
  STARTUP2: 'Copying data from another member (initial sync)',
  RECOVERING: 'Catching up or in maintenance — can’t serve reads yet',
  ROLLBACK: 'Undoing writes that never reached a majority',
  REMOVED: 'No longer in the replica set config',
  [DOWN]: 'Not reachable or not healthy from the member mongolive is connected to',
};

const fmtLag = (ms: number) => (ms < 600_000 ? fmtMs(ms) : fmtDuration(ms));
const fmtDelay = (sec: number) => (sec < 60 ? `${sec}s` : sec % 3600 === 0 ? `${sec / 3600}h` : fmtDuration(sec * 1000));

function useReplica(range: MonitorRange) {
  const [report, setReport] = useState<ReplicaReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // 긴 기간이면 1h로 묻는다 — 서버 메모리에 그만큼만 있다
  const queryRange = (LIVE_RANGES.includes(range) ? range : '1h') as '5m' | '1h';
  const query = useRef(queryRange);
  query.current = queryRange;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.hidden) return; // 다시 보일 때 visibilitychange가 이어 간다
      try {
        const next = await api.getReplica(query.current);
        if (!alive) return;
        setFailed(null);
        setReport(next);
      } catch (e) {
        if (alive) setFailed(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    const onVisible = () => {
      if (!document.hidden && alive) {
        clearTimeout(timer);
        void tick();
      }
    };
    void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [queryRange]);

  return { report, failed };
}

function StatePill({ state, healthy }: { state: string; healthy: boolean }) {
  return (
    <span className={cn('rounded-full px-1.5 py-px text-[11px] font-medium', stateTone(state, healthy))} data-tt={STATE_TIP[state] ?? state}>
      {stateLabel(state)}
    </span>
  );
}

// 설정에서 온 배지 — 보통과 다른 것만
function ConfigBadges({ member }: { member: ReplicaMember }) {
  const c = member.config;
  const badges: { label: string; tip: string }[] = [];
  if (member.self) badges.push({ label: 'connected', tip: 'mongolive talks to this member — the status below is what it sees' });
  if (c) {
    if (c.hidden) badges.push({ label: 'hidden', tip: 'Invisible to applications — never chosen for reads' });
    if (c.delaySec > 0) badges.push({ label: `delayed ${fmtDelay(c.delaySec)}`, tip: 'Applies writes this long after the primary, on purpose' });
    if (c.priority === 0 && !c.arbiterOnly) badges.push({ label: 'priority 0', tip: 'Can never become primary' });
    if (c.votes === 0) badges.push({ label: 'no vote', tip: 'Does not vote in elections' });
    if (!c.buildIndexes) badges.push({ label: 'no indexes', tip: 'Does not build indexes (backup-only member)' });
  }
  const tags = c ? Object.entries(c.tags) : [];
  if (badges.length === 0 && tags.length === 0) return null;
  return (
    <>
      {badges.map((b) => (
        <span key={b.label} className={styles.badge} data-tt={b.tip}>{b.label}</span>
      ))}
      {tags.length > 0 && (
        <span className={styles.badge} data-tt={tags.map(([k, v]) => `${k}: ${v}`).join(' · ')}>
          {tags.length === 1 ? `${tags[0][0]}: ${tags[0][1]}` : `${tags.length} tags`}
        </span>
      )}
    </>
  );
}

function MembersTable({ members, now }: { members: ReplicaMember[]; now: number }) {
  return (
    <div className="overflow-x-auto">
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.th}>Member</th>
            <th className={styles.th}>State</th>
            <th className={cn(styles.th, 'text-right')} data-tt="How far behind the primary — time between the last write the primary applied and the last one this member applied. With few writes it can look larger than it is.">Lag</th>
            <th className={cn(styles.th, 'text-right')} data-tt="Heartbeat round trip from the connected member">Ping</th>
            <th className={cn(styles.th, 'text-right')} data-tt="When the connected member last heard from it (heartbeats every 2 s)">Last heard</th>
            <th className={styles.th}>Syncs from</th>
            <th className={cn(styles.th, 'text-right')}>Up</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const delayMs = (m.config?.delaySec ?? 0) * 1000;
            const lagWarn = m.lagMs !== null && m.lagMs > delayMs + LAG_WARN_MS;
            const seenWarn = m.lastSeenAt !== null && now - m.lastSeenAt > SEEN_WARN_MS;
            const down = !m.healthy || m.state === DOWN;
            return (
              <tr key={m.name} className="border-t border-slate-100 align-top">
                <td className={cn(styles.td, 'whitespace-normal')}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12px] text-slate-800">{m.name}</span>
                    <ConfigBadges member={m} />
                  </div>
                  {m.message && <p className={cn('mt-0.5 max-w-[60ch] text-[11px]', down ? 'text-rose-600' : 'text-slate-500')}>{m.message}</p>}
                </td>
                <td className={styles.td}>
                  <span data-tt={m.electedAt !== null ? `Primary since ${fmtDateTime(m.electedAt)}` : undefined}>
                    <StatePill state={m.state} healthy={m.healthy} />
                  </span>
                </td>
                <td className={cn(styles.td, styles.num, m.lagMs === null && styles.muted, lagWarn && 'font-medium text-amber-700')}>
                  {m.lagMs === null ? '—' : fmtLag(m.lagMs)}
                </td>
                <td className={cn(styles.td, styles.num, m.pingMs === null && styles.muted)}>{m.pingMs === null ? '—' : `${m.pingMs} ms`}</td>
                <td className={cn(styles.td, styles.num, m.lastSeenAt === null && styles.muted, seenWarn && (down ? 'text-rose-600' : 'text-amber-700'))}>
                  {m.lastSeenAt === null ? '—' : <span data-tt={fmtDateTime(m.lastSeenAt)}>{fmtAgo(m.lastSeenAt, now) === 'now' ? 'just now' : `${fmtAgo(m.lastSeenAt, now)} ago`}</span>}
                </td>
                <td className={cn(styles.td, 'font-mono text-[11px]', !m.syncSource && styles.muted)}>{m.syncSource ?? '—'}</td>
                <td className={cn(styles.td, styles.num, m.uptimeSec === null && styles.muted)}>{m.uptimeSec === null || down ? '—' : fmtUptime(m.uptimeSec)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ChangeLine({ change }: { change: ReplicaChange }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-slate-100 py-1.5 text-[12px] first:border-t-0">
      <span className="font-mono text-[11px] text-slate-400" data-tt={fmtDateTime(change.at)}>{fmtClock(change.at, true)}</span>
      <span className="font-mono text-slate-800">{change.member}</span>
      {change.from === null ? (
        <span className="flex items-center gap-1.5 text-slate-500">joined as <StatePill state={change.to ?? ''} healthy /></span>
      ) : change.to === null ? (
        <span className="flex items-center gap-1.5 text-slate-500">left the set — was <StatePill state={change.from} healthy={change.from !== DOWN} /></span>
      ) : (
        <span className="flex items-center gap-1.5">
          <StatePill state={change.from} healthy={change.from !== DOWN} />
          <ArrowRight size={12} className="text-slate-400" aria-label="to" />
          <StatePill state={change.to} healthy={change.to !== DOWN} />
        </span>
      )}
    </li>
  );
}

interface ServerTabProps {
  range: MonitorRange;
  // Overview가 받은 서버 정보 — replSetGetStatus가 없을 때 mongos인지 가려 안내한다
  topology: MongoTopology | null;
}

export function ServerTab({ range, topology }: ServerTabProps) {
  const { report, failed } = useReplica(range);
  const live = LIVE_RANGES.includes(range);

  const section = (children: ReactNode) => (
    <div className={styles.body}>
      <h2 className={styles.sectionTitle}>Replica set · whole server</h2>
      {children}
    </div>
  );

  if (!report) {
    return section(
      failed ? (
        <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Could not load the replica set status: {failed}</p>
      ) : (
        <p className={cn(styles.muted, 'flex items-center gap-2 py-3 text-[12px]')}><Loader2 size={13} className="animate-spin" /> Loading…</p>
      ),
    );
  }
  if (report.status === 'standalone') {
    return section(<p className={styles.note}>Standalone server — there is no replica set, so no members or replication lag to show.</p>);
  }
  if (report.status === 'unsupported') {
    return section(
      <p className={styles.note}>
        {topology === 'sharded'
          ? 'Connected through mongos — each shard is its own replica set, and mongos can’t report their members.'
          : 'This server doesn’t allow replSetGetStatus (some hosted tiers block it), so members and lag can’t be shown.'}
      </p>,
    );
  }
  if (report.status === 'denied') {
    return section(
      <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> This account can’t read the replica set status — grant it the clusterMonitor role to see members and lag. Trying again every 5 minutes.</p>,
    );
  }
  if (report.status === 'closed' || report.at === null) {
    return section(
      report.status === 'error' ? (
        <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Could not read the replica set status: {report.error}</p>
      ) : (
        <p className={cn(styles.muted, 'flex items-center gap-2 py-3 text-[12px]')}><Loader2 size={13} className="animate-spin" /> Waiting for the first reading (about 10 s)…</p>
      ),
    );
  }

  const now = report.at;
  const self = report.members.find((m) => m.self);
  const secondaries = report.members.filter((m) => m.appliedAt !== null && m.state !== 'PRIMARY');
  const noPrimary = !report.members.some((m) => m.state === 'PRIMARY');
  const since = report.since;
  const kept = live ? RANGE_LABEL[range].toLowerCase() : 'the last hour — kept in memory for one hour only';
  const windowMs = range === '5m' ? 5 * 60_000 : chartWindow(report.lag.times[0], now).ms;
  const series: ChartSeries[] = report.lag.series.map((s, i) => ({ key: s.member, label: s.member, color: C[i % C.length], values: s.values }));
  const changes = [...report.changes].reverse();

  return section(
    <>
      {report.status === 'error' && (
        <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Could not read the replica set status just now: {report.error} — showing the last reading.</p>
      )}
      {noPrimary && (
        <p className={styles.warn}><CircleAlert size={14} className="mt-0.5 shrink-0" /> No primary right now — writes are refused until the members elect one.</p>
      )}
      <section className={styles.card} aria-label="Members">
        <div className="min-w-0">
          <h3 className={styles.title}>Members{report.set && <span className="font-normal text-slate-500"> · {report.set}</span>}</h3>
          <p className={styles.sub}>
            {report.members.length} {report.members.length === 1 ? 'member' : 'members'}
            {report.votingMembers !== null && ` · ${report.votingMembers} voting`}
            {report.writeMajority !== null && (
              <span data-tt="A write with writeConcern 'majority' waits for this many members"> · majority = {report.writeMajority}</span>
            )}
            {report.term !== null && <span data-tt="Goes up by one with every election"> · term {report.term}</span>}
            {self && <> · as seen by <span className="font-mono">{self.name}</span>{self.state !== 'PRIMARY' && ' (not the primary)'}</>}
            <span data-tt={fmtDateTime(now)}> · read {fmtClock(now, true)}</span>
          </p>
        </div>
        {report.configDenied && (
          <p className={cn(styles.muted, 'text-[11px]')}>Can’t read the replica set config (replSetGetConfig) — hidden, delayed, priority and votes aren’t shown.</p>
        )}
        <MembersTable members={report.members} now={now} />
      </section>
      <div className={styles.grid}>
        {(secondaries.length > 0 || series.length > 0) && (
          <TimeChart
            title="Replication lag"
            subtitle={<>How far each member is behind the primary · {kept}</>}
            times={report.lag.times}
            series={series}
            format={fmtLag}
            windowMs={windowMs}
            now={now}
            gapMs={POLL_MS * 2.5}
            emptyText="No lag readings yet"
          />
        )}
        <section className={styles.card} aria-label="Member changes">
          <div className="min-w-0">
            <h3 className={styles.title}>Member changes</h3>
            <p className={styles.sub}>
              Elections, members going down or coming back · {kept}
            </p>
          </div>
          {changes.length > 0 ? (
            <ul className="flex flex-col">
              {changes.map((c) => <ChangeLine key={`${c.at}-${c.member}`} change={c} />)}
            </ul>
          ) : (
            <p className={cn(styles.muted, 'py-3 text-center text-[12px]')}>
              No changes since {since === null ? '…' : <span data-tt={fmtDateTime(since)}>{fmtClock(since)}</span>}.
            </p>
          )}
        </section>
      </div>
    </>,
  );
}
