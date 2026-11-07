// 알림 센터의 System 탭 — 에러 토스트와 실시간 연결 끊김/복구 기록(services/systemLog). 최신이 위.
import { CircleAlert, CircleCheck, Info, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { SystemEntry, SystemLevel } from '../../services/systemLog';

const LEVEL: Record<SystemLevel, { icon: LucideIcon; color: string }> = {
  error: { icon: CircleAlert, color: 'text-rose-500' },
  warning: { icon: TriangleAlert, color: 'text-amber-500' },
  success: { icon: CircleCheck, color: 'text-emerald-500' },
  info: { icon: Info, color: 'text-sky-500' },
};

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const styles = {
  toolbar: 'flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-1.5',
  hint: 'flex-1 text-[11px] text-slate-400',
  iconBtn: 'rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 disabled:pointer-events-none disabled:opacity-40',
  list: 'flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5',
  row: 'flex items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-slate-50',
  message: 'min-w-0 flex-1 break-words text-xs leading-relaxed text-slate-700',
  time: 'shrink-0 pt-px font-mono text-[11px] tabular-nums text-slate-400',
  empty: 'flex flex-col items-center justify-center gap-1 py-16 text-center text-xs text-slate-400',
} as const;

export function SystemTab({ entries, onClear }: { entries: SystemEntry[]; onClear: () => void }) {
  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.hint}>Errors and connection changes in this tab — not saved</span>
        <button type="button" className={styles.iconBtn} onClick={onClear} disabled={entries.length === 0} data-tt="Clear">
          <Trash2 size={14} />
        </button>
      </div>
      <div className={styles.list}>
        {entries.length === 0 ? (
          <div className={styles.empty}>
            <span>Nothing here</span>
            <span>Errors and connection drops show up here.</span>
          </div>
        ) : (
          entries.map((e) => {
            const { icon: Icon, color } = LEVEL[e.level];
            return (
              <div key={e.id} className={styles.row}>
                <Icon size={14} className={`mt-0.5 shrink-0 ${color}`} />
                <p className={styles.message}>{e.message}</p>
                <span className={styles.time}>{clock(e.at)}</span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
