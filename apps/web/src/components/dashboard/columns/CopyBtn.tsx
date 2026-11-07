// path: src/components/dashboard/columns/CopyBtn.tsx
import { useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { Check, Copy, type LucideIcon } from 'lucide-react';
import { copyToClipboard } from '../../../utils/clipboard';

interface CopyBtnProps {
  text: string;
  // 기본은 복사 아이콘 — 경로 복사·쿼리 복사처럼 뜻이 다르면 다른 아이콘
  icon?: LucideIcon;
  tip?: string;
  size?: number;
  className?: string;
}

export function CopyBtn({ text, icon: Icon = Copy, tip, size = 16, className = 'p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors shrink-0' }: CopyBtnProps) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      aria-label={tip ?? 'Copy'}
      data-tt={copied ? 'Copied' : tip}
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
              <Check size={size} className="text-emerald-500" />
            </m.span>
          : <m.span key="d" initial={{ scale: 0.5 }} animate={{ scale: 1 }} exit={{ scale: 0.5 }} className="block">
              <Icon size={size} />
            </m.span>
        }
      </AnimatePresence>
    </button>
  );
}
