// path: src/components/dashboard/columns/CopyBtn.tsx
import { useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from '../../../utils/clipboard';

export function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors shrink-0"
      onClick={(e) => {
        e.stopPropagation();
        copyToClipboard(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {copied
          ? <m.span key="c" initial={{ scale: 0.5 }} animate={{ scale: 1 }} exit={{ scale: 0.5 }} className="block">
              <Check size={16} className="text-emerald-500" />
            </m.span>
          : <m.span key="d" initial={{ scale: 0.5 }} animate={{ scale: 1 }} exit={{ scale: 0.5 }} className="block">
              <Copy size={16} />
            </m.span>
        }
      </AnimatePresence>
    </button>
  );
}
