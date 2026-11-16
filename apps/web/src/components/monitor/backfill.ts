// 빈 구간 불러오기(9-4)의 화면용 계산 — 배너의 진행률·문구, 차트 띠의 툴팁. 화면 없이 테스트할 수 있게 따로 둔다.
import type { BackfillGap, HistoryFill, HistoryGap } from '../../types/explorer';
import { fmtDateTime, fmtDuration, fmtNumber } from './format';

const MINUTE = 60_000;

// 빈 구간 길이 — 45s / 38m / 2h 38m
export const fmtGapLength = (ms: number): string => (ms < MINUTE ? `${Math.max(1, Math.round(ms / 1000))}s` : fmtDuration(ms));

// 진행률 0..1 — 구간 전체 이벤트 수를 알면 개수로, 모르면 불러온 시각으로
export const backfillProgress = (gap: BackfillGap): number => {
  const total = gap.estimate?.total;
  if (total) return Math.min(1, gap.loaded / total);
  if (gap.loadedTo === null) return 0;
  const start = gap.partialFrom ?? gap.from;
  if (gap.to <= start) return 0;
  return Math.min(1, Math.max(0, (gap.loadedTo - start) / (gap.to - start)));
};

// 남은(또는 전체) 쓰기 — "~30K writes" / "unknown number of writes"
export const fmtEventCount = (n: number | null): string => (n === null ? 'an unknown number of writes' : `~${fmtNumber(n)} write${n === 1 ? '' : 's'}`);

// 크기 — 512 B / 12.3 KB / 4.5 MB / 1.2 GB
export const fmtSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};

// 기한까지 남은 시간 — 지났으면 null
export const timeLeft = (deadline: number | null, now: number): string | null => (deadline !== null && deadline > now ? fmtDuration(deadline - now) : null);

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) => a.from < b.to && a.to > b.from;

export interface GapBand {
  label: string;
  // 쓰기를 나중에 불러왔다 — 차트의 띠를 더 옅게(그 구간의 쓰기 수는 실제 값이다)
  filled: boolean;
}

// 기록 파일 차트의 빈 구간 띠 — 그 구간의 쓰기를 나중에 불러왔는지 덧붙인다(Collections 쓰기 차트)
export const gapBand = (gap: HistoryGap, fills: HistoryFill[], pending: BackfillGap[]): GapBand => {
  const base = `Not recording ${fmtDateTime(gap.from)} – ${fmtDateTime(gap.to)}`;
  if (pending.some((p) => overlaps(p, gap))) return { label: `${base} · writes not loaded yet`, filled: false };
  const mine = fills.filter((f) => overlaps(f, gap));
  if (mine.length === 0) return { label: base, filled: false };
  const events = mine.reduce((s, f) => s + f.events, 0);
  if (events === 0) {
    return mine.some((f) => f.lost)
      ? { label: `${base} · writes couldn't be loaded — the oplog no longer had them`, filled: false }
      : { label: `${base} · checked afterwards: no writes`, filled: true };
  }
  const partial = mine.map((f) => f.partialFrom).find((t) => t !== undefined);
  const count = `${events.toLocaleString('en-US')} write${events === 1 ? '' : 's'}`;
  return {
    label: partial !== undefined
      ? `${base} · ${count} loaded afterwards, from ${fmtDateTime(partial)} on (earlier ones were gone from the oplog)`
      : `${base} · ${count} loaded afterwards from the change stream`,
    filled: true,
  };
};
