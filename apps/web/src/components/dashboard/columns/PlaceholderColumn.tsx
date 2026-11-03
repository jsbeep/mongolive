import { Database, Layers, Braces } from 'lucide-react';

interface PlaceholderColumnProps {
  slotIndex: number;
}

const SLOT_HINTS = [
  { icon: Database, text: 'Select a database' },
  { icon: Layers, text: 'Select a collection' },
  { icon: Braces, text: 'Select a document to view its fields' },
] as const;

export function PlaceholderColumn({ slotIndex }: PlaceholderColumnProps) {
  const hint = SLOT_HINTS[slotIndex] ?? SLOT_HINTS[2];
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
