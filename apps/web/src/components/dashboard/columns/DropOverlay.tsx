// path: src/components/dashboard/columns/DropOverlay.tsx
import { AnimatePresence, motion } from 'framer-motion';
import { Upload } from 'lucide-react';
import { SPRING_SOFT } from '../../../utils/motionPresets';

export function DropOverlay({ visible, label }: { visible: boolean; label: string }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={SPRING_SOFT}
          className="absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/60 text-emerald-700 text-sm font-medium pointer-events-none"
        >
          <Upload size={18} />
          {label}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
