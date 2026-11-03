// path: src/components/dashboard/columns/HeaderIcon.tsx
import { Braces, List } from 'lucide-react';
import type { JsonValue } from '../../../types/explorer';

export function HeaderIcon({ node }: { node: JsonValue }) {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) return <List size={14} className="text-slate-400 shrink-0" />;
  return <Braces size={14} className="text-slate-400 shrink-0" />;
}
