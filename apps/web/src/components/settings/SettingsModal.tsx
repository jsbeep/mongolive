// 설정 창 (상태바의 톱니바퀴). 왼쪽 목록 + 오른쪽 내용.
//   Display     — 값 표시(Date 시간대, ObjectId 줄임). 이 브라우저에만(services/preferences)
//   Safety      — read-only·보호 대상(서버 settings.json, 모든 브라우저 공통 — 서버가 막는다), 삭제 확인 강도·Undo 단계(이 브라우저)
//   Realtime    — 실시간 반영 간격(즉시 / 느슨하게)
//   Data        — 샘플 데이터 불러오기
//   Diagnostics — 서버·MongoDB·changeStream·권한 (GET /api/diagnostics)
//   Security    — 보안 설정(.env)을 읽기만. 화면에서 바꿀 수 있으면 세션 하나만 탈취돼도 인증을 끌 수 있어서
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'framer-motion';
import { CircleAlert, Download, Keyboard, Upload, CircleCheck, Database, Loader2, Lock, Monitor, Plus, Radio, RefreshCw, Shield, ShieldCheck, Sparkles, Stethoscope, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import type { CollectionSummary, DatabaseSummary, Diagnostics, MutationRequest } from '../../types/explorer';
import { api, dataSourceKind } from '../../services/api';
import { sanitizeFontName, setPreference, usePreferences, UNDO_DEPTHS, type Animations, type DateDisplay, type Theme, type DeleteConfirmLarge, type DeleteConfirmSmall, type LiveBatch, type OidDisplay, type UndoDepth } from '../../services/preferences';
import { ANIMATION_DISABLE_THRESHOLD_MB } from '../../utils/motionPresets';
import { saveServerSettings, useServerSettings } from '../../services/serverSettings';
import { applyBackup, buildBackup, downloadBackup, parseBackup, type SettingsBackup } from '../../services/settingsBackup';
import { buildForumEjsonSample, buildForumJsonSample, FORUM_EJSON_DATABASE_NAME, FORUM_JSON_DATABASE_NAME } from '../../data/sampleData';
import { formatDate, formatOid, offsetLabel } from '../../utils/formatValue';
import { cn } from '../../utils/cn';

export type SettingsSection = 'display' | 'safety' | 'realtime' | 'keyboard' | 'data' | 'diagnostics' | 'security';
type Section = SettingsSection;

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'display', label: 'Display', icon: Monitor },
  { id: 'safety', label: 'Safety', icon: ShieldCheck },
  { id: 'realtime', label: 'Realtime', icon: Radio },
  { id: 'keyboard', label: 'Keyboard', icon: Keyboard },
  { id: 'data', label: 'Data', icon: Database },
  { id: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { id: 'security', label: 'Security', icon: Shield },
];

interface SettingsModalProps {
  open: boolean;
  // 열 때 보여 줄 칸(상태바의 Read-only 배지 → Safety)
  initialSection?: Section;
  onClose: () => void;
  databases: DatabaseSummary[];
  onMutate: (op: MutationRequest) => Promise<unknown>;
  // Data 칸에서 이미 있는 샘플 DB 열기(창은 닫힌다)
  onOpenDatabase: (database: string) => void;
}

const styles = {
  // z-[1000]: 모달 층(툴팁 900 위)
  backdrop: 'fixed inset-0 z-[1000] flex items-center justify-center bg-black/20 p-4 backdrop-blur-[2px]',
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
  // 테마와 상관없이 어두운 터미널 모양(black/짙은 남색 고정 — slate는 다크에서 뒤집힌다)
  code: 'mt-2 block whitespace-pre rounded-md bg-[#1e1e1e] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#dadada]',
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

// 고정폭 글꼴 — 이 컴퓨터에 설치된 것만 쓴다(내려받지 않음)
const FONT_PRESETS = ['', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'D2Coding', 'Consolas'];

// 설치돼 있나 — 같은 글자를 '그 글꼴, 기본'과 '기본'으로 그려 폭이 다르면 있는 것. 판단 못 하면 null
const isFontInstalled = (name: string): boolean | null => {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const text = 'mmmmmmmmmmlli10OOWW';
  return ['monospace', 'serif', 'sans-serif'].some((base) => {
    ctx.font = `72px ${base}`;
    const fallback = ctx.measureText(text).width;
    ctx.font = `72px "${name}", ${base}`;
    return ctx.measureText(text).width !== fallback;
  });
};

function MonoFontPicker() {
  const prefs = usePreferences();
  const [custom, setCustom] = useState(FONT_PRESETS.includes(prefs.monoFont) ? '' : prefs.monoFont);
  const installed = prefs.monoFont ? isFontInstalled(prefs.monoFont) : true;
  return (
    <div className={styles.group}>
      <p className={styles.groupTitle}>Monospace font</p>
      <p className={styles.groupHint}>Used for keys, values, ids and code. Only fonts installed on this computer — nothing is downloaded. Saved in this browser.</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {FONT_PRESETS.map((name) => (
          <button
            key={name || 'default'}
            type="button"
            className={cn('rounded-md px-2.5 py-1.5 text-xs transition-colors', prefs.monoFont === name ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}
            style={name ? { fontFamily: `"${name}", monospace` } : { fontFamily: 'var(--font-mono)' }}
            onClick={() => {
              setCustom('');
              setPreference('monoFont', name);
            }}
          >
            {name || 'Default'}
          </button>
        ))}
        <input
          className="w-44 rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
          placeholder="Other font name…"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setPreference('monoFont', sanitizeFontName(custom));
          }}
          onBlur={() => {
            if (custom.trim()) setPreference('monoFont', sanitizeFontName(custom));
          }}
          aria-label="Other monospace font"
        />
      </div>
      <p className={cn(styles.preview, 'font-mono')}>{'{ "_id": ObjectId("6720a1"), "count": 42 }  0O 1lI'}</p>
      {installed === false && (
        <p className="mt-1.5 text-[11px] text-amber-700">"{prefs.monoFont}" doesn't seem to be installed on this computer — the default font is shown instead.</p>
      )}
    </div>
  );
}

// 예시 값 — 지금 시각, 그리고 지금 만든 것 같은 ObjectId
const SAMPLE_OID = `${Math.floor(Date.now() / 1000).toString(16).padStart(8, '0')}a1b2c3d4e5f60718`;

function DisplaySection() {
  const prefs = usePreferences();
  const now = Date.now();
  return (
    <>
      <div className={styles.group}>
        <p className={styles.groupTitle}>Theme</p>
        <p className={styles.groupHint}>System follows your computer's light/dark setting and switches with it. Dark is a neutral, Obsidian-style gray with an olive-green accent. Saved in this browser.</p>
        <Segment<Theme>
          value={prefs.theme}
          onChange={(v) => setPreference('theme', v)}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </div>
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
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600" checked={prefs.showMs} onChange={(e) => setPreference('showMs', e.target.checked)} />
          Show milliseconds
          <span className="text-slate-400">— off: hidden in the list and the editor, but kept when you save. ISO always shows them.</span>
        </label>
        <p className={styles.preview}>{formatDate(now, prefs.dateDisplay, prefs.showMs)}</p>
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
      <MonoFontPicker />
      <div className={styles.group}>
        <p className={styles.groupTitle}>Animations</p>
        <p className={styles.groupHint}>
          Auto moves smoothly but turns column animations off while you look at a large collection (over {ANIMATION_DISABLE_THRESHOLD_MB} MB) and follows your system's "reduce motion" setting. Off is the fastest — things change in place without sliding.
        </p>
        <Segment<Animations>
          value={prefs.animations}
          onChange={(v) => setPreference('animations', v)}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'on', label: 'Always' },
            { value: 'off', label: 'Off (fastest)' },
          ]}
        />
      </div>
    </>
  );
}

// ── Safety ───────────────────────────────────────────────────────────────────

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-amber-500' : 'bg-slate-200')}
    >
      {/* left-0을 꼭 준다 — 없으면 버튼의 가운데 정렬 위치에서 출발해 손잡이가 밖으로 삐져나온다 */}
      <span className={cn('absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

function SafetySection({ databases }: { databases: DatabaseSummary[] }) {
  const settings = useServerSettings();
  const prefs = usePreferences();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickDb, setPickDb] = useState('');
  const [pickCol, setPickCol] = useState('');
  const [cols, setCols] = useState<CollectionSummary[]>([]);

  useEffect(() => {
    setPickCol('');
    if (!pickDb) {
      setCols([]);
      return;
    }
    api.getCollections(pickDb).then(setCols, () => setCols([]));
  }, [pickDb]);

  const save = async (next: typeof settings) => {
    setSaving(true);
    setError(null);
    try {
      await saveServerSettings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const where = dataSourceKind === 'remote' ? 'Saved on the server and applied to every browser. The server refuses blocked edits (undo too).' : 'Mock mode: saved in this browser.';

  return (
    <>
      <div className={styles.group}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className={styles.groupTitle}>Read-only mode</p>
            <p className={styles.groupHint}>Blocks every edit — documents, collections and databases. Handy when browsing a database you must not change. {where}</p>
          </div>
          <Switch label="Read-only mode" checked={settings.readOnly} onChange={(v) => void save({ ...settings, readOnly: v })} />
        </div>
      </div>

      <div className={styles.group}>
        <p className={styles.groupTitle}>Protected databases &amp; collections</p>
        <p className={styles.groupHint}>Editing is blocked only here; everything else stays editable. Declaring references (Manage references) still works — it doesn't touch MongoDB.</p>
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-400/60" value={pickDb} onChange={(e) => setPickDb(e.target.value)} aria-label="Database">
            <option value="">Database…</option>
            {databases.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
          <select className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 disabled:opacity-50" value={pickCol} onChange={(e) => setPickCol(e.target.value)} disabled={!pickDb} aria-label="Collection">
            <option value="">Whole database</option>
            {cols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          <button
            type="button"
            className={styles.btn}
            disabled={!pickDb || saving}
            onClick={() => {
              void save({ ...settings, protected: [...settings.protected, pickCol ? { database: pickDb, collection: pickCol } : { database: pickDb }] });
              setPickDb('');
            }}
          >
            <Plus size={13} />
            Protect
          </button>
        </div>
        {settings.protected.length > 0 ? (
          <ul className="mt-3 flex flex-col">
            {settings.protected.map((p) => {
              const label = p.collection ? `${p.database}.${p.collection}` : p.database;
              return (
                <li key={label} className={styles.row}>
                  <Lock size={13} className="mt-px shrink-0 text-amber-500" />
                  <span className={styles.rowValue}>{label}</span>
                  <span className="text-[11px] text-slate-400">{p.collection ? 'collection' : 'whole database'}</span>
                  <button
                    type="button"
                    className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                    aria-label={`Unprotect ${label}`}
                    data-tt="Unprotect"
                    onClick={() => void save({ ...settings, protected: settings.protected.filter((x) => x !== p) })}
                  >
                    <X size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-slate-400">Nothing protected.</p>
        )}
        {error && <p className={cn(styles.callout, 'bg-rose-50 text-rose-700')}>{error}</p>}
      </div>

      <div className={styles.group}>
        <p className={styles.groupTitle}>Delete confirmation</p>
        <p className={styles.groupHint}>Saved in this browser.</p>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="w-40 shrink-0 text-xs text-slate-500">Databases &amp; collections</span>
            <Segment<DeleteConfirmLarge>
              value={prefs.deleteConfirmLarge}
              onChange={(v) => setPreference('deleteConfirmLarge', v)}
              options={[
                { value: 'type', label: 'Type the name' },
                { value: 'confirm', label: 'Confirm' },
              ]}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-40 shrink-0 text-xs text-slate-500">Documents &amp; fields</span>
            <Segment<DeleteConfirmSmall>
              value={prefs.deleteConfirmSmall}
              onChange={(v) => setPreference('deleteConfirmSmall', v)}
              options={[
                { value: 'confirm', label: 'Confirm' },
                { value: 'none', label: "Don't ask" },
              ]}
            />
          </div>
        </div>
      </div>

      <div className={styles.group}>
        <p className={styles.groupTitle}>Undo</p>
        <p className={styles.groupHint}>
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono">Ctrl</kbd>+<kbd className="rounded border border-slate-200 bg-slate-50 px-1 font-mono">Z</kbd> (⌘Z on Mac) undoes your latest document or field edit; press again for the one before. Each step only goes through if nobody changed that spot since. Collection and database changes can't be undone and start a fresh history. Inside a text box it undoes typing instead.
        </p>
        <div className="flex items-center gap-3">
          <span className="w-40 shrink-0 text-xs text-slate-500">Steps to remember</span>
          <Segment<string>
            value={String(prefs.undoDepth)}
            onChange={(v) => setPreference('undoDepth', Number(v) as UndoDepth)}
            options={UNDO_DEPTHS.map((n) => ({ value: String(n), label: String(n) }))}
          />
        </div>
        {dataSourceKind === 'mock' && <p className="mt-2 text-[11px] text-slate-400">Mock mode keeps at most 10 (each step is a full copy of the data).</p>}
      </div>
    </>
  );
}

// ── Realtime ─────────────────────────────────────────────────────────────────

function RealtimeSection() {
  const prefs = usePreferences();
  return (
    <div className={styles.group}>
      <p className={styles.groupTitle}>Update pace</p>
      <p className={styles.groupHint}>
        Changes from MongoDB are gathered for a moment and applied together. Relaxed waits longer — when something writes a lot (an import, a script), the screen and the server stay calmer. Saved in this browser.
      </p>
      <Segment<LiveBatch>
        value={prefs.liveBatch}
        onChange={(v) => setPreference('liveBatch', v)}
        options={[
          { value: 'immediate', label: 'Immediate (0.15 s)' },
          { value: 'relaxed', label: 'Relaxed (1.5 s)' },
        ]}
      />
    </div>
  );
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
const MOD = isMac ? '⌘' : 'Ctrl';

const SHORTCUTS: { title: string; rows: [keys: string[], what: string][] }[] = [
  {
    title: 'Anywhere',
    rows: [
      [[MOD, 'K'], 'Quick jump — databases, collections, ObjectIds, commands'],
      [[MOD, 'Z'], 'Undo your last document or field edit (again for the one before)'],
      [[MOD, 'B'], 'Sidebar: full ↔ icons (opens it again if hidden)'],
      [['?'], 'This list'],
    ],
  },
  {
    title: 'In the columns',
    rows: [
      [['↑', '↓'], 'Move within a column (also k / j) — past the first or last row turns the page'],
      [['→', 'Enter'], 'Open the row into the next column (also l)'],
      [['←'], 'Back to the previous column (also h)'],
      [['e'], 'Edit the row (also F2; Enter on a field that has nothing to open)'],
      [['Delete'], 'Delete the row — asks first, per Safety'],
      [['/'], 'Filter this column (from the collection list: the documents)'],
      [['q'], 'Query the open collection — MongoDB filter, server mode'],
      [['Esc'], 'Hide the keyboard cursor'],
    ],
  },
];

function KeyboardSection() {
  return (
    <>
      <p className={cn(styles.groupHint, 'mb-4')}>
        The first arrow key shows a cursor in the columns; clicking a row moves it there. Keys do nothing while you're typing in a box or a dialog is open.
      </p>
      {SHORTCUTS.map((group) => (
        <div key={group.title} className={styles.group}>
          <p className={styles.groupTitle}>{group.title}</p>
          {group.rows.map(([keys, what]) => (
            <div key={what} className={styles.row}>
              <span className="flex w-40 shrink-0 flex-wrap items-center gap-1">
                {keys.map((k) => (
                  <kbd key={k} className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{k}</kbd>
                ))}
              </span>
              <span className="text-xs text-slate-700">{what}</span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// ── Data ─────────────────────────────────────────────────────────────────────

const SAMPLES = [
  { kind: 'ejson' as const, name: FORUM_EJSON_DATABASE_NAME, label: 'EJSON sample', hint: 'MongoDB style — embedded comment trees, ObjectId references', build: buildForumEjsonSample },
  { kind: 'json' as const, name: FORUM_JSON_DATABASE_NAME, label: 'JSON sample', hint: 'Firebase / HN API style — plain ids, references declared as links', build: buildForumJsonSample },
];

// 설정 내보내기/가져오기 — 이 브라우저 설정 + (고르면) 서버 Safety 설정. services/settingsBackup
function SettingsBackupGroup() {
  const server = useServerSettings();
  const prefs = usePreferences();
  const [withServer, setWithServer] = useState(true);
  const [pending, setPending] = useState<SettingsBackup | null>(null);
  const [applyServer, setApplyServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    setError(null);
    setPending(null);
    if (!file) return;
    try {
      setPending(parseBackup(await file.text()));
      setApplyServer(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the file');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const localCount = pending ? Object.keys(pending.local).length : 0;
  return (
    <div className={styles.group}>
      <p className={styles.groupTitle}>Settings backup</p>
      <p className={styles.groupHint}>
        Move your settings to another browser or keep a copy: display, safety, realtime, animations and font, sidebar layout, change-log filters and per-collection filters. Security settings (.env) and the password are never included.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={styles.btn} onClick={() => downloadBackup(buildBackup(withServer ? server : null))}>
          <Download size={13} />
          Export…
        </button>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600" checked={withServer} onChange={(e) => setWithServer(e.target.checked)} />
          Include the server's Safety settings (read-only, protected)
        </label>
      </div>
      <div className="mt-3">
        <button type="button" className={styles.btn} onClick={() => fileRef.current?.click()}>
          <Upload size={13} />
          Import…
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>
      {error && <p className={cn(styles.callout, 'bg-rose-50 text-rose-700')}>{error}</p>}
      {pending && (
        <div className={cn(styles.callout, 'bg-slate-50 text-slate-700')}>
          {/* 내보낸 시각은 Display의 날짜 형식으로(파일엔 UTC로 들어 있다) */}
          <p className="font-semibold">Ready to import{pending.exportedAt && !Number.isNaN(Date.parse(pending.exportedAt)) ? ` — exported ${formatDate(Date.parse(pending.exportedAt), prefs.dateDisplay, false)}` : ''}</p>
          <p className="mt-1">{localCount} browser setting{localCount === 1 ? '' : 's'} will replace yours. The page reloads afterwards.</p>
          {pending.server && (
            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 accent-amber-600" checked={applyServer} onChange={(e) => setApplyServer(e.target.checked)} />
              <span>
                Also apply the server's Safety settings — read-only {pending.server.readOnly ? 'on' : 'off'}, {pending.server.protected.length} protected.{' '}
                <span className="text-amber-700">This changes it for every browser.</span>
              </span>
            </label>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={styles.btnPrimary}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await applyBackup(pending, applyServer);
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not apply');
                  setBusy(false);
                }
              }}
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              Import and reload
            </button>
            <button type="button" className={styles.btn} onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// 샘플 DB 이름이 시그니처 — 이미 있으면 다시 넣지 않고 '열기'로(복사본이 쌓이지 않게)
function DataSection({ databases, onMutate, onOpenDatabase }: Pick<SettingsModalProps, 'databases' | 'onMutate' | 'onOpenDatabase'>) {
  const [loading, setLoading] = useState<'ejson' | 'json' | null>(null);
  const load = async (sample: (typeof SAMPLES)[number]) => {
    setLoading(sample.kind);
    try {
      // 화면의 목록이 오래됐을 수 있다(다른 탭에서 넣었거나) — 넣기 직전에 한 번 더 확인해 있으면 그냥 연다
      const latest = await api.listDatabases();
      if (latest.some((d) => d.name === sample.name)) {
        onOpenDatabase(sample.name);
        return;
      }
      await onMutate({ type: 'createDatabase', database: sample.build() });
    } finally {
      setLoading(null);
    }
  };
  return (
    <>
    <div className={styles.group}>
      <p className={styles.groupTitle}>Sample data</p>
      <p className={styles.groupHint}>
        The same forum in two NoSQL models — comment threads embedded in each post, or split across collections and linked by id. Each sample goes into its own database with a fixed name, so it's added only once; delete that database to start over.
      </p>
      {dataSourceKind === 'remote' && (
        <p className={cn(styles.callout, 'mb-3 mt-0 bg-amber-50 text-amber-800')}>
          This creates a real database on your MongoDB server. Delete it from the sidebar when you're done.
        </p>
      )}
      <div className="flex flex-col gap-2.5">
        {SAMPLES.map((sample) => {
          const exists = databases.some((d) => d.name === sample.name);
          return (
            <div key={sample.kind} className="flex items-center gap-3">
              {exists ? (
                <button type="button" className={cn(styles.btn, 'w-40 shrink-0 justify-center whitespace-nowrap')} onClick={() => onOpenDatabase(sample.name)} data-tt={`Already added as "${sample.name}" — open it`}>
                  <CircleCheck size={14} className="text-emerald-500" />
                  Open
                </button>
              ) : (
                <button type="button" className={cn(styles.btnPrimary, 'w-40 shrink-0 justify-center whitespace-nowrap')} disabled={loading !== null} onClick={() => void load(sample)}>
                  {loading === sample.kind ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {sample.label}
                </button>
              )}
              <div className="min-w-0">
                <p className="text-xs text-slate-600">{sample.hint}</p>
                <p className="font-mono text-[11px] text-slate-400">{sample.name}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
    <SettingsBackupGroup />
    </>
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

export function SettingsModal({ open, initialSection, onClose, databases, onMutate, onOpenDatabase }: SettingsModalProps) {
  const [section, setSection] = useState<Section>('display');
  // 열 때마다 요청받은 칸으로(없으면 마지막에 보던 칸)
  useEffect(() => {
    if (open && initialSection) setSection(initialSection);
  }, [open, initialSection]);
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
                {section === 'safety' && <SafetySection databases={databases} />}
                {section === 'realtime' && <RealtimeSection />}
                {section === 'keyboard' && <KeyboardSection />}
                {section === 'data' && (
                  <DataSection
                    databases={databases}
                    onMutate={onMutate}
                    onOpenDatabase={(name) => {
                      onClose();
                      onOpenDatabase(name);
                    }}
                  />
                )}
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
