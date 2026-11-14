// 연결 추가·수정 창 (Compass의 New Connection처럼 — 접속 주소 중심).
//   주소(URI) · 이름 · 색 · 즐겨찾기 / Test · Save · Save & connect / Delete(두 번 눌러 확인)
// 저장된 주소는 비밀번호와 비밀 옵션이 ••••••로 가려져 온다. 그대로 두면 서버가 원래 값으로 채운다
// — 단 호스트·사용자·인증 방식·프록시·TLS가 그대로일 때만(아니면 서버가 다시 입력하라고 한다).
// .env 연결은 주소를 여기서 바꿀 수 없다(이름·색·즐겨찾기만).
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Loader2, Server, Star, Trash2, XCircle } from 'lucide-react';
import {
  CONNECTION_COLORS,
  URI_SECRET_MASK,
  connectionLabel,
  type ConnectionColor,
  type ConnectionInfo,
  type ConnectionInput,
  type ConnectionTestResult,
} from '../../types/explorer';
import { api } from '../../services/api';
import { forgetConnectionStorage } from '../../services/connectionStorage';
import { cn } from '../../utils/cn';
import { CONNECTION_COLOR_CLASSES } from './connectionColors';

// 'new' = 새 연결, 아니면 고칠 연결
export type ConnectionModalTarget = 'new' | ConnectionInfo;

interface ConnectionModalProps {
  target: ConnectionModalTarget | null;
  // 저장하고 바로 그 연결로(웰컴·패널의 접속과 같은 길 — 먼저 접속해 본다)
  onConnect: (id: string) => Promise<void>;
  onClose: () => void;
}

const NEW_URI = 'mongodb://localhost:27017/';

const TOPOLOGY_LABEL: Record<ConnectionTestResult['topology'], string> = {
  replicaSet: 'replica set — live updates on',
  sharded: 'sharded cluster — live updates on',
  standalone: 'standalone — no live updates (not a replica set)',
  unknown: 'connected',
};

const styles = {
  backdrop: 'fixed inset-0 flex items-center justify-center p-4',
  overlay: 'absolute inset-0 bg-black/40 backdrop-blur-sm',
  card: 'relative z-[10] flex max-h-[calc(100vh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-elevated',
  head: 'flex items-center gap-3 border-b border-slate-100 px-6 py-4',
  headIcon: 'flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700',
  title: 'text-base font-semibold text-slate-900',
  sub: 'text-[12px] text-slate-500',
  body: 'flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-5',
  label: 'mb-1.5 block text-[12px] font-semibold text-slate-600',
  input: 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/20',
  uri: 'min-h-[84px] resize-y font-mono text-[13px] leading-relaxed',
  readOnly: 'cursor-default bg-slate-50 text-slate-500 focus:border-slate-200 focus:ring-0',
  hint: 'mt-1.5 text-[12px] leading-relaxed text-slate-500',
  swatch: 'h-6 w-6 rounded-full transition-transform hover:scale-110 focus-visible:outline-none',
  foot: 'flex flex-wrap items-center gap-2 border-t border-slate-100 px-6 py-4',
  btn: 'inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
  ghost: 'text-slate-600 hover:bg-slate-100',
  soft: 'bg-slate-100 text-slate-700 hover:bg-slate-200',
  primary: 'bg-emerald-600 text-white hover:bg-emerald-700',
  danger: 'text-rose-600 hover:bg-rose-50',
  dangerArmed: 'bg-rose-500 text-white hover:bg-rose-600',
} as const;

export function ConnectionModal({ target, onConnect, onClose }: ConnectionModalProps) {
  return <AnimatePresence>{target && <ModalBody key={target === 'new' ? 'new' : target.id} target={target} onConnect={onConnect} onClose={onClose} />}</AnimatePresence>;
}

function ModalBody({ target, onConnect, onClose }: { target: ConnectionModalTarget; onConnect: (id: string) => Promise<void>; onClose: () => void }) {
  const editing = target === 'new' ? null : target;
  const isEnv = editing?.source === 'env';
  const [uri, setUri] = useState(editing?.uri ?? NEW_URI);
  const [name, setName] = useState(editing?.name ?? '');
  const [color, setColor] = useState<ConnectionColor | null>(editing?.color ?? null);
  const [favorite, setFavorite] = useState(editing?.favorite ?? false);
  const [busy, setBusy] = useState<'test' | 'save' | 'connect' | 'delete' | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const uriRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) uriRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, editing, onClose]);

  const uriChanged = !editing || uri.trim() !== editing.uri;
  const masked = !!editing && uri.includes(URI_SECRET_MASK);

  // 바뀐 것만 보낸다 — 주소를 안 건드렸으면 주소는 빼서 서버가 다시 검사·복원할 일이 없게
  const payload = (): ConnectionInput => {
    const input: ConnectionInput = {};
    if (!editing || (name.trim() || null) !== editing.name) input.name = name.trim() || null;
    if (!editing || color !== editing.color) input.color = color;
    if (!editing || favorite !== editing.favorite) input.favorite = favorite;
    if (!isEnv && uriChanged) input.uri = uri;
    return input;
  };

  const run = async <T,>(kind: NonNullable<typeof busy>, task: () => Promise<T>): Promise<T | undefined> => {
    setBusy(kind);
    setError(null);
    try {
      return await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const doTest = () =>
    run('test', async () => {
      setTest(null);
      // 저장된 연결이면 id도 — 가린 자리(••••••)를 서버가 원래 값으로 채워서 시험한다
      setTest(await api.testConnection(isEnv ? { id: editing!.id } : editing ? { id: editing.id, uri } : { uri }));
    });

  const save = async (): Promise<ConnectionInfo | undefined> => {
    if (!editing) return api.createConnection(payload());
    const input = payload();
    return Object.keys(input).length ? api.updateConnection(editing.id, input) : editing;
  };

  const doSave = () => run('save', async () => (await save()) && onClose());

  const doSaveAndConnect = () =>
    run('connect', async () => {
      const saved = await save();
      if (!saved) return;
      onClose();
      await onConnect(saved.id);
    });

  const doDelete = () => {
    if (!editing) return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    void run('delete', async () => {
      await api.deleteConnection(editing.id);
      // 이 브라우저에 남은 그 연결의 북마크·기록·파이프라인도
      forgetConnectionStorage(editing.id);
      onClose();
    });
  };

  const placeholderName = editing ? connectionLabel({ name: null, hosts: editing.hosts }) : 'Defaults to the host';

  return (
    <motion.div className={styles.backdrop} style={{ zIndex: 1000 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
      <div className={styles.overlay} onClick={() => !busy && onClose()} />
      <motion.div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit connection' : 'New connection'}
        initial={{ scale: 0.96, opacity: 0, y: 8 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 8 }}
        transition={{ type: 'spring', stiffness: 340, damping: 30 }}
      >
        <div className={styles.head}>
          <span className={styles.headIcon}>
            <Server size={17} />
          </span>
          <div className="min-w-0">
            <p className={styles.title}>{editing ? `Edit ${connectionLabel(editing)}` : 'New connection'}</p>
            <p className={styles.sub}>Saved on the server ({isEnv ? 'apps/server/.env' : '~/.mongolive/connections.json'}) — never in your MongoDB</p>
          </div>
        </div>

        <div className={styles.body}>
          <div>
            <label className={styles.label} htmlFor="connection-uri">
              Connection string
            </label>
            <textarea
              id="connection-uri"
              ref={uriRef}
              className={cn(styles.input, styles.uri, isEnv && styles.readOnly)}
              value={uri}
              readOnly={isEnv}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setUri(e.target.value);
                setTest(null);
              }}
            />
            {isEnv ? (
              <p className={styles.hint}>Set by MONGODB_URI in apps/server/.env — change it there. Name, color and favorite are saved here.</p>
            ) : masked ? (
              <p className={styles.hint}>
                <code className="rounded bg-slate-100 px-1 font-mono">{URI_SECRET_MASK}</code> keeps the saved password. Changing the host, user, auth mechanism, proxy or TLS settings needs it typed again.
              </p>
            ) : (
              <p className={styles.hint}>
                e.g. <code className="font-mono">mongodb://user:pass@host:27017/?replicaSet=rs0&amp;authSource=admin</code> or <code className="font-mono">mongodb+srv://…</code>
              </p>
            )}
          </div>

          <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
            <div>
              <label className={styles.label} htmlFor="connection-name">
                Name
              </label>
              <input id="connection-name" className={styles.input} value={name} placeholder={placeholderName} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <span className={styles.label}>Color</span>
              <div className="flex h-[38px] items-center gap-1.5" role="radiogroup" aria-label="Color">
                <button
                  type="button"
                  role="radio"
                  aria-checked={color === null}
                  aria-label="No color"
                  data-tt="No color"
                  className={cn(styles.swatch, 'border border-dashed border-slate-300 bg-white', color === null && 'ring-2 ring-slate-400 ring-offset-2')}
                  onClick={() => setColor(null)}
                />
                {CONNECTION_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={color === c}
                    aria-label={c}
                    data-tt={c}
                    className={cn(styles.swatch, CONNECTION_COLOR_CLASSES[c].bar, color === c && cn('ring-2 ring-offset-2', CONNECTION_COLOR_CLASSES[c].ring))}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-600" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />
            <span>
              <span className="flex items-center gap-1 text-sm font-medium text-slate-700">
                <Star size={13} className="text-amber-400" fill="currentColor" />
                Favorite
              </span>
              <span className="text-[12px] text-slate-500">Shown first on the welcome screen.</span>
            </span>
          </label>

          {test && (
            <div className={cn('flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[13px] ring-1', test.ok ? 'bg-emerald-50 text-emerald-800 ring-emerald-200/70' : 'bg-rose-50 text-rose-700 ring-rose-200/70')} role="status">
              {test.ok ? <CheckCircle2 size={15} className="mt-px shrink-0" /> : <XCircle size={15} className="mt-px shrink-0" />}
              <span className="min-w-0 break-words">
                {test.ok
                  ? [`Connected — ${TOPOLOGY_LABEL[test.topology]}`, test.replicaSet && `(${test.replicaSet})`, test.version && `· MongoDB ${test.version}`, test.latencyMs !== null && `· ${test.latencyMs} ms`].filter(Boolean).join(' ')
                  : test.error ?? "Couldn't connect"}
              </span>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-2.5 text-[13px] text-rose-700 ring-1 ring-rose-200/70" role="alert">
              <XCircle size={15} className="mt-px shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
        </div>

        <div className={styles.foot}>
          {editing && !isEnv && (
            <button type="button" className={cn(styles.btn, armedDelete ? styles.dangerArmed : styles.danger)} onClick={doDelete} disabled={!!busy} onBlur={() => setArmedDelete(false)}>
              {busy === 'delete' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              {armedDelete ? 'Click again to delete' : 'Delete'}
            </button>
          )}
          <div className="flex-1" />
          <button type="button" className={cn(styles.btn, styles.ghost)} onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="button" className={cn(styles.btn, styles.soft)} onClick={() => void doTest()} disabled={!!busy || !uri.trim()}>
            {busy === 'test' && <Loader2 size={14} className="animate-spin" />}
            Test
          </button>
          <button type="button" className={cn(styles.btn, styles.soft)} onClick={() => void doSave()} disabled={!!busy || !uri.trim()}>
            {busy === 'save' && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
          <button type="button" className={cn(styles.btn, styles.primary)} onClick={() => void doSaveAndConnect()} disabled={!!busy || !uri.trim()}>
            {busy === 'connect' && <Loader2 size={14} className="animate-spin" />}
            Save & connect
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
