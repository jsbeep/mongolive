// 설정 창 (상태바의 톱니바퀴). 왼쪽 목록 + 오른쪽 내용.
//   Display     — 값 표시(Date 시간대, ObjectId 줄임). 이 브라우저에만(services/preferences)
//   Data        — 샘플 데이터 불러오기
//   Diagnostics — 서버·MongoDB·changeStream·권한 (GET /api/diagnostics)
//   Security    — 보안 설정(.env)을 읽기만. 화면에서 바꿀 수 있으면 세션 하나만 탈취돼도 인증을 끌 수 있어서
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'framer-motion';
import { CircleAlert, CircleCheck, Database, Loader2, Monitor, RefreshCw, Shield, Sparkles, Stethoscope, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import type { DatabaseSummary, Diagnostics, MutationRequest } from '../../types/explorer';
import { api, dataSourceKind } from '../../services/api';
import { setPreference, usePreferences, type DateDisplay, type OidDisplay } from '../../services/preferences';
import { buildForumEjsonSample, buildForumJsonSample } from '../../data/sampleData';
import { formatDate, formatOid, offsetLabel } from '../../utils/formatValue';
import { cn } from '../../utils/cn';

type Section = 'display' | 'data' | 'diagnostics' | 'security';

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'display', label: 'Display', icon: Monitor },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { id: 'security', label: 'Security', icon: Shield },
];

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  databases: DatabaseSummary[];
  onMutate: (op: MutationRequest) => Promise<unknown>;
}

const styles = {
  // z-[1000]: 모달 층(툴팁 900 위)
  backdrop: 'fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/20 p-4 backdrop-blur-[2px]',
  panel: 'flex h-[min(600px,calc(100vh-2rem))] w-[min(820px,100%)] overflow-hidden rounded-2xl bg-white shadow-elevated ring-1 ring-slate-200/70',
  nav: 'flex w-48 shrink-0 flex-col gap-0.5 border-r border-slate-100 bg-slate-50/70 p-3',
  navTitle: 'px-2 pb-3 pt-1 text-sm font-semibold text-slate-900',
  // 켜짐/꺼짐은 둘 중 하나만(cn은 겹침을 정리해 주지 않는다)
  navItem: 'flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors',
  navIdle: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  navOn: 'bg-white font-medium text-slate-900 shadow-sm ring-1 ring-slate-200/70',
  body: 'flex min-w-0 flex-1 flex-col',
  head: 'flex h-12 shrink-0 items-center justify-between border-b border-slate-100 pl-6 pr-3',
  headTitle: 'text-sm font-semibold text-slate-900',
  close: 'rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600',
  content: 'flex-1 overflow-y-auto px-6 py-5',
  group: 'mb-7',
  groupTitle: 'mb-1 text-[13px] font-semibold text-slate-800',
  groupHint: 'mb-3 text-xs leading-relaxed text-slate-500',
  segment: 'inline-flex rounded-lg bg-slate-100 p-0.5',
  segBtn: 'rounded-md px-3 py-1.5 text-xs transition-colors',
  segIdle: 'text-slate-500 hover:text-slate-800',
  segOn: 'bg-white font-semibold text-slate-900 shadow-sm',
  preview: 'mt-2 rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600',
  row: 'flex items-start gap-3 border-b border-slate-100 py-2.5 last:border-b-0',
  rowLabel: 'w-40 shrink-0 text-xs text-slate-500',
  rowValue: 'min-w-0 flex-1 break-words font-mono text-xs text-slate-800',
  callout: 'mt-3 rounded-lg px-4 py-3 text-xs leading-relaxed',
  code: 'mt-2 block whitespace-pre rounded-md bg-slate-900/90 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100',
  btn: 'inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50',
  btnPrimary: 'inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-60',
} as const;

function Segment<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className={styles.segment} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cn(styles.segBtn, value === o.value ? styles.segOn : styles.segIdle)} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{children}</span>
    </div>
  );
}

function Status({ ok, warn, children }: { ok: boolean; warn?: boolean; children: ReactNode }) {
  const Icon = ok ? CircleCheck : warn ? TriangleAlert : CircleAlert;
  return (
    <span className="inline-flex items-start gap-1.5">
      <Icon size={13} className={cn('mt-px shrink-0', ok ? 'text-emerald-500' : warn ? 'text-amber-500' : 'text-rose-500')} />
      <span>{children}</span>
    </span>
  );
}

// ── Display ──────────────────────────────────────────────────────────────────

// 예시 값 — 지금 시각, 그리고 지금 만든 것 같은 ObjectId
const SAMPLE_OID = `${Math.floor(Date.now() / 1000).toString(16).padStart(8, '0')}a1b2c3d4e5f60718`;

function DisplaySection() {
  const prefs = usePreferences();
  const now = Date.now();
  return (
    <>
      <div className={styles.group}>
        <p className={styles.groupTitle}>Dates</p>
        <p className={styles.groupHint}>
          MongoDB stores dates in UTC. This only changes how they're shown (and the time zone of the date editor) — stored values stay the same. Hover a date to see all three.
        </p>
        <Segment<DateDisplay>
          value={prefs.dateDisplay}
          onChange={(v) => setPreference('dateDisplay', v)}
          options={[
            { value: 'local', label: `Local (${offsetLabel(now)})` },
            { value: 'utc', label: 'UTC' },
            { value: 'iso', label: 'ISO (as stored)' },
          ]}
        />
        <p className={styles.preview}>{formatDate(now, prefs.dateDisplay)}</p>
      </div>
      <div className={styles.group}>
        <p className={styles.groupTitle}>ObjectIds</p>
        <p className={styles.groupHint}>Short shows the last 8 characters. Hover any ObjectId for the full value and when it was created (the first 8 hex digits are a timestamp). Copy always copies the full value.</p>
        <Segment<OidDisplay>
          value={prefs.oidDisplay}
          onChange={(v) => setPreference('oidDisplay', v)}
          options={[
            { value: 'full', label: 'Full' },
            { value: 'short', label: 'Short' },
          ]}
        />
        <p className={styles.preview}>{formatOid(SAMPLE_OID, prefs.oidDisplay)}</p>
      </div>
    </>
  );
}

// ── Data ─────────────────────────────────────────────────────────────────────

const SAMPLES = [
  { kind: 'ejson' as const, label: 'EJSON sample', hint: 'MongoDB style — embedded comment trees, ObjectId references' },
  { kind: 'json' as const, label: 'JSON sample', hint: 'Firebase / HN API style — plain ids, references declared as links' },
];

function DataSection({ databases, onMutate }: Pick<SettingsModalProps, 'databases' | 'onMutate'>) {
  const [loading, setLoading] = useState<'ejson' | 'json' | null>(null);
  const load = async (kind: 'ejson' | 'json') => {
    setLoading(kind);
    try {
      const existing = databases.map((d) => d.name);
      const database = kind === 'ejson' ? buildForumEjsonSample(existing) : buildForumJsonSample(existing);
      await onMutate({ type: 'createDatabase', database });
    } finally {
      setLoading(null);
    }
  };
  return (
    <div className={styles.group}>
      <p className={styles.groupTitle}>Sample data</p>
      <p className={styles.groupHint}>The same forum in two NoSQL models — comment threads embedded in each post, or split across collections and linked by id. Each click adds a new database.</p>
      {dataSourceKind === 'remote' && (
        <p className={cn(styles.callout, 'mb-3 mt-0 bg-amber-50 text-amber-800')}>
          This creates a real database on your MongoDB server. Delete it from the sidebar when you're done.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {SAMPLES.map((s) => (
          <div key={s.kind} className="flex items-center gap-3">
            <button type="button" className={styles.btnPrimary} disabled={loading !== null} onClick={() => void load(s.kind)}>
              {loading === s.kind ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {s.label}
            </button>
            <span className="text-xs text-slate-500">{s.hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Diagnostics / Security ───────────────────────────────────────────────────

const uptime = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const mi = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${mi}m` : `${mi}m`;
};

function useDiagnostics(enabled: boolean) {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getDiagnostics());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (enabled && dataSourceKind === 'remote') void reload();
  }, [enabled, reload]);
  return { data, error, loading, reload };
}

function MockNotice() {
  return <p className={cn(styles.callout, 'mt-0 bg-slate-50 text-slate-600')}>Running on in-browser mock data — there's no server or MongoDB to check. Start the app with <code className="font-mono">pnpm dev:web:remote</code> to see this.</p>;
}

function DiagnosticsSection({ diag }: { diag: ReturnType<typeof useDiagnostics> }) {
  if (dataSourceKind === 'mock') return <MockNotice />;
  const { data, error, loading, reload } = diag;
  return (
    <>
      <div className="mb-4 flex justify-end">
        <button type="button" className={styles.btn} onClick={() => void reload()} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          Check again
        </button>
      </div>
      {error && <p className={cn(styles.callout, 'mt-0 bg-rose-50 text-rose-700')}>{error}</p>}
      {!data ? (
        !error && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Checking…</p>
      ) : (
        <>
          <div className={styles.group}>
            <p className={styles.groupTitle}>Server</p>
            <Row label="MongoLive">v{data.server.version}</Row>
            <Row label="Node.js">{data.server.node}</Row>
            <Row label="Uptime">{uptime(data.server.uptimeSec)}</Row>
          </div>

          <div className={styles.group}>
            <p className={styles.groupTitle}>MongoDB</p>
            <Row label="Connection">
              <Status ok={data.mongo.ok}>{data.mongo.ok ? 'Connected' : data.mongo.error ?? 'Not reachable'}</Status>
            </Row>
            <Row label="Version">{data.mongo.version ?? '—'}</Row>
            <Row label="Topology">
              {data.mongo.topology === 'replicaSet' && <Status ok>Replica set “{data.mongo.replicaSet}”</Status>}
              {data.mongo.topology === 'sharded' && <Status ok>Sharded cluster (mongos)</Status>}
              {data.mongo.topology === 'standalone' && <Status ok={false} warn>Standalone — live updates need a replica set</Status>}
              {data.mongo.topology === 'unknown' && '—'}
            </Row>
            {data.mongo.topology === 'standalone' && (
              <div className={cn(styles.callout, 'bg-amber-50 text-amber-900')}>
                <p className="font-semibold">Why live updates don't work</p>
                <p className="mt-1">
                  MongoDB change streams only run on a replica set (or a sharded cluster). A single-node replica set is enough — it keeps working like your current server.
                </p>
                <code className={styles.code}>{`# 1. start mongod as a replica set (or set replication.replSetName in mongod.conf)
mongod --replSet rs0 ...

# 2. once, in mongosh
rs.initiate()

# Docker
docker run -d --name mongo -p 27017:27017 mongo --replSet rs0
docker exec mongo mongosh --eval "rs.initiate()"`}</code>
                <p className="mt-2">Then restart the MongoLive server.</p>
              </div>
            )}
          </div>

          <div className={styles.group}>
            <p className={styles.groupTitle}>Live updates &amp; permissions</p>
            <Row label="Change stream">
              {data.realtime.state === 'running' ? (
                <Status ok>Running</Status>
              ) : data.realtime.state === 'connecting' ? (
                <Status ok={false} warn>Starting…</Status>
              ) : (
                <Status ok={false}>{data.realtime.error ?? 'Not running'}</Status>
              )}
            </Row>
            <Row label="Server metrics">
              {data.serverStatus === 'ok' ? (
                <Status ok>Allowed</Status>
              ) : data.serverStatus === 'denied' ? (
                <Status ok={false} warn>No permission — the Metrics tab needs the <span className="font-semibold">clusterMonitor</span> role</Status>
              ) : (
                <Status ok={false}>Could not read serverStatus</Status>
              )}
            </Row>
            {data.realtime.state === 'error' && data.mongo.topology !== 'standalone' && (
              <p className={cn(styles.callout, 'bg-slate-50 text-slate-600')}>
                If the error mentions authorization: MongoLive watches the whole cluster, so the MongoDB user needs the <span className="font-semibold">changeStream</span> and <span className="font-semibold">find</span> actions on all databases — the built-in <span className="font-semibold">readAnyDatabase</span> role covers it.
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}

function SecuritySection({ diag }: { diag: ReturnType<typeof useDiagnostics> }) {
  if (dataSourceKind === 'mock') return <MockNotice />;
  const s = diag.data?.security;
  return (
    <>
      <p className={cn(styles.callout, 'mb-5 mt-0 bg-slate-50 text-slate-600')}>
        Read-only on purpose. If these could be changed here, one stolen session could switch sign-in off. Change them in <code className="font-mono">apps/server/.env</code> and restart the server. To change the password, run <code className="font-mono">pnpm set-password</code> (this signs out every browser).
      </p>
      {diag.error && <p className={cn(styles.callout, 'mt-0 bg-rose-50 text-rose-700')}>{diag.error}</p>}
      {!s ? (
        !diag.error && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Loading…</p>
      ) : (
        <div className={styles.group}>
          <Row label="AUTH_MODE">{s.authMode}</Row>
          <Row label="HOST · PORT">{s.host}:{s.port}</Row>
          <Row label="HTTPS (TLS_CERT/KEY)">{s.https ? 'On' : 'Off'}</Row>
          <Row label="TRUST_PROXY">{s.trustProxy ? 'On' : 'Off'}</Row>
          <Row label="ALLOW_INSECURE_HTTP">{s.allowInsecureHttp ? <Status ok={false} warn>On — passwords travel unencrypted</Status> : 'Off'}</Row>
          <Row label="MONGODB_URI">{s.mongoUri}</Row>
          <Row label="Password file">{s.authFile}</Row>
          <Row label="Metadata file">{s.metaFile}</Row>
        </div>
      )}
    </>
  );
}

// ── 창 ───────────────────────────────────────────────────────────────────────

export function SettingsModal({ open, onClose, databases, onMutate }: SettingsModalProps) {
  const [section, setSection] = useState<Section>('display');
  // Diagnostics·Security가 같은 응답을 쓴다 — 둘 중 하나를 열 때 한 번 받는다
  const diag = useDiagnostics(open && (section === 'diagnostics' || section === 'security'));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const current = SECTIONS.find((s) => s.id === section)!;

  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <m.div
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ type: 'spring', stiffness: 460, damping: 36 }}
          >
            <nav className={styles.nav} aria-label="Settings sections">
              <p className={styles.navTitle}>Settings</p>
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <button key={id} type="button" className={cn(styles.navItem, section === id ? styles.navOn : styles.navIdle)} onClick={() => setSection(id)} aria-current={section === id ? 'page' : undefined}>
                  <Icon size={15} className={section === id ? 'text-emerald-600' : 'text-slate-400'} />
                  {label}
                </button>
              ))}
            </nav>
            <div className={styles.body}>
              <div className={styles.head}>
                <span className={styles.headTitle}>{current.label}</span>
                <button type="button" className={styles.close} onClick={onClose} aria-label="Close settings" data-tt="Close (Esc)">
                  <X size={16} />
                </button>
              </div>
              <div className={styles.content}>
                {section === 'display' && <DisplaySection />}
                {section === 'data' && <DataSection databases={databases} onMutate={onMutate} />}
                {section === 'diagnostics' && <DiagnosticsSection diag={diag} />}
                {section === 'security' && <SecuritySection diag={diag} />}
              </div>
            </div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
