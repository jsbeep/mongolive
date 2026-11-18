// 쿼리 바의 Explain 결과 칸 (9-9) — 판정 한 줄 · 단계 흐름 · 숫자 · 단계마다 쉬운 설명
//   쿼리 글자를 고치면 '이전 쿼리' 표시와 함께 흐리게(stale). 복사: 날것 JSON / mongosh explain 명령
import { Braces, CircleCheck, Info, SquareTerminal, TriangleAlert, X } from 'lucide-react';
import type { ExplainSummary } from '../../types/explorer';
import { cn } from '../../utils/cn';
import { CopyBtn } from '../dashboard/columns/CopyBtn';
import { explainVerdict, fmtCount, flowText, stageNote, stagesOf } from './explain';

const styles = {
  box: 'mt-2 rounded-lg border border-slate-200 bg-white px-2.5 pb-2 pt-1.5 text-xs',
  head: 'flex items-center gap-1',
  title: 'font-medium text-slate-700',
  iconBtn: 'shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600',
  flow: 'mt-1.5 break-words font-mono text-[12px] leading-5 text-slate-700',
  nums: 'mt-1 flex flex-wrap gap-x-1 text-slate-500 tabular-nums',
  legend: 'mt-1.5 flex flex-col gap-0.5 border-t border-slate-100 pt-1.5 text-[11px] leading-4 text-slate-500',
} as const;

const TONE = {
  good: { icon: CircleCheck, cls: 'text-emerald-700' },
  warn: { icon: TriangleAlert, cls: 'text-amber-700' },
  info: { icon: Info, cls: 'text-slate-600' },
} as const;

const plural = (n: number, word: string) => `${fmtCount(n)} ${word}${n === 1 ? '' : 's'}`;

interface ExplainPanelProps {
  summary: ExplainSummary;
  // 쿼리 글자가 그 뒤로 바뀌었다
  stale: boolean;
  mongoshCommand: string;
  onClose: () => void;
}

export function ExplainPanel({ summary, stale, mongoshCommand, onClose }: ExplainPanelProps) {
  const verdict = explainVerdict(summary);
  const Tone = TONE[verdict.tone];
  const nums: { text: string; tip: string }[] = [];
  if (summary.returned !== null) nums.push({ text: `${fmtCount(summary.returned)} returned`, tip: 'Documents that matched the query' });
  if (summary.keysExamined !== null && summary.indexes.length) {
    nums.push({ text: `${plural(summary.keysExamined, 'index key')} read`, tip: "Entries read from the index's sorted list" });
  }
  if (summary.docsExamined !== null) {
    nums.push({ text: `${plural(summary.docsExamined, 'document')} read`, tip: 'Documents MongoDB opened to check — ideally close to the number returned' });
  }
  if (summary.timeMs !== null) nums.push({ text: `${fmtCount(summary.timeMs)} ms`, tip: 'Time the server spent on this run' });
  if (summary.rejectedPlans) {
    nums.push({ text: `${plural(summary.rejectedPlans, 'other plan')} tried`, tip: 'Plans MongoDB tried and dropped before picking this one' });
  }
  const legend = stagesOf(summary.plan)
    .map((stage) => ({ stage, note: stageNote(stage) }))
    .filter((s): s is { stage: string; note: string } => !!s.note);

  return (
    <section className={styles.box} aria-label="Explain result">
      <div className={styles.head}>
        <span className={styles.title}>Explain</span>
        {stale && <span className="text-slate-400">· for the previous query</span>}
        <span className="flex-1" />
        {summary.raw && <CopyBtn text={summary.raw} icon={Braces} size={13} tip="Copy the full explain output (JSON)" className={styles.iconBtn} />}
        <CopyBtn text={mongoshCommand} icon={SquareTerminal} size={13} tip="Copy as a mongosh explain command" className={styles.iconBtn} />
        <button type="button" className={styles.iconBtn} aria-label="Close explain" data-tt="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className={cn(stale && 'opacity-50')}>
        <p className={cn('mt-1 flex items-start gap-1.5 leading-4', Tone.cls)}>
          <Tone.icon size={13} className="mt-px shrink-0" />
          <span>{verdict.text}</span>
        </p>
        <p className={styles.flow} title="Steps in the order MongoDB ran them">
          {flowText(summary.plan)}
        </p>
        {nums.length > 0 && (
          <p className={styles.nums}>
            {nums.map((n, i) => (
              // 점은 앞 항목 뒤에 — 줄이 접혀도 다음 줄이 점으로 시작하지 않게
              <span key={n.text} data-tt={n.tip}>
                {n.text}
                {i < nums.length - 1 && ' ·'}
              </span>
            ))}
          </p>
        )}
        {legend.length > 0 && (
          <ul className={styles.legend}>
            {legend.map((s) => (
              <li key={s.stage}>
                <span className="font-mono text-slate-600">{s.stage}</span> — {s.note}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
