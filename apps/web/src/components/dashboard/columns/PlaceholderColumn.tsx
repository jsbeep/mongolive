import { Database, Folder, Braces, Layers } from 'lucide-react';

interface PlaceholderColumnProps {
  slotIndex: number;
  aggregation?: boolean;
}

// aggregation 모드 — 2번 칸은 '스테이지를 고르면 그 출력', 그 뒤는 '결과를 고르면 그 필드'
const AGGREGATION_HINTS = [
  { icon: Layers, text: 'Pick a stage to see its output' },
  { icon: Braces, text: 'Pick a result to see its fields' },
] as const;

const SLOT_HINTS = [
  { icon: Database, text: 'Select a database' },
  { icon: Folder, text: 'Select a collection' },
  { icon: Braces, text: 'Select a document to view its fields' },
] as const;

export function PlaceholderColumn({ slotIndex, aggregation = false }: PlaceholderColumnProps) {
  const hint = aggregation && slotIndex >= 2
    ? AGGREGATION_HINTS[slotIndex === 2 ? 0 : 1]
    : (SLOT_HINTS[slotIndex] ?? SLOT_HINTS[2]);
  const Icon = hint.icon;

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center bg-white">
      <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center">
        <Icon size={18} className="text-slate-400" />
      </div>
      <p className="text-[12px] text-slate-400 leading-relaxed">{hint.text}</p>
    </div>
  );
}
