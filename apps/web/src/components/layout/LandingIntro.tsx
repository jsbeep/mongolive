// path: src/components/layout/LandingIntro.tsx
import { useState } from 'react';
import { motion } from 'framer-motion';
import { GitBranch, MousePointerClick, PencilLine, FlaskConical, X, Sparkles, Loader2 } from 'lucide-react';

type SampleKind = 'ejson' | 'json';

interface LandingIntroProps {
  onClose: () => void;
  onLoadSample: (kind: SampleKind) => Promise<void>;
}

// 같은 포럼 데이터를 두 가지 NoSQL 모델링으로 나눠 담은 샘플 — 어느 쪽 데이터를
// 갖고 왔든 하나는 자기 얘기라는 걸 버튼 두 개로 바로 보여준다.
const SAMPLES = [
  {
    kind: 'ejson' as const,
    label: 'EJSON Sample',
    hint: 'MongoDB style — embedded comment trees, ObjectId references',
  },
  {
    kind: 'json' as const,
    label: 'JSON Sample',
    hint: 'Firebase / HN API style — plain ids, references declared as links',
  },
];

const FEATURES = [
  {
    icon: GitBranch,
    title: 'Miller Column Drill-down',
    description: 'Dive deeper column by column to intuitively explore any JSON or EJSON document.',
  },
  {
    icon: MousePointerClick,
    title: 'Reference Tracking',
    description: 'Automatically detects ObjectId, DBRef, and reference fields, jumping to linked documents with a single click.',
  },
  {
    icon: PencilLine,
    title: 'Inline Editing',
    description: 'Double-click to edit values instantly — including EJSON types like Date, Decimal128, and Long — with full Undo support.',
  },
  {
    icon: FlaskConical,
    title: 'Mock Data Prototyping',
    description: 'A project that validates UI with shared-type mock data before wiring up the real MongoDB API.',
  },
] as const;

const TECH_STACK = ['React 18', 'TypeScript', 'Vite', 'TailwindCSS', 'Framer Motion'] as const;

const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  visible: { opacity: 1, y: 0 },
};

export function LandingIntro({ onClose, onLoadSample }: LandingIntroProps) {
  const [loadingKind, setLoadingKind] = useState<SampleKind | null>(null);

  const handleLoadSample = async (kind: SampleKind) => {
    setLoadingKind(kind);
    try {
      await onLoadSample(kind);
      onClose(); // 성공하면 인트로를 닫아 바로 결과를 보여줌
    } catch {
      // mutate 훅이 이미 에러 토스트를 띄움 — 여기서는 모달 유지만
    } finally {
      setLoadingKind(null);
    }
  };

  return (
    <section className="relative flex-1 flex-col w-full px-6 py-24 sm:px-10 lg:px-20">
      <button
        type="button"
        className="absolute top-4 left-1/2 -translate-x-1/2 flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-600"
        onClick={onClose}
        aria-label="Dismiss intro section"
        title="Dismiss intro section"
      >
        <X size={16} />
      </button>

      <div className="mx-auto flex max-w-5xl flex-col items-center text-center">
        <motion.span
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.6 }}
          variants={fadeUp}
          transition={{ duration: 0.5 }}
          className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700"
        >
          JSON & EJSON Explorer
        </motion.span>

        <motion.h2
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.6 }}
          variants={fadeUp}
          transition={{ duration: 0.5, delay: 0.05 }}
          className="flex flex-col items-center mt-5 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl"
        >
          Miller Column으로 탐색하는
          <br className="hidden sm:block" />
          가장 직관적인 JSON · EJSON 뷰어
          <div className="mt-5 h-1 w-16 rounded-full bg-emerald-400/25" />
        </motion.h2>

        <motion.p
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.6 }}
          variants={fadeUp}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mt-4 max-w-2xl text-base leading-relaxed text-slate-500"
        >
          A free explorer for any JSON — with full EJSON support unlocked for MongoDB and Firebase data (ObjectId, DBRef,
          Date, Decimal128, Long). Reference tracking, inline editing, and mock-data-based prototyping, built as the
          foundation for a future MongoDB real-time dashboard.
        </motion.p>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.6 }}
          variants={fadeUp}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="mt-6 flex flex-col items-center gap-2 sm:flex-row"
        >
          {SAMPLES.map(({ kind, label, hint }) => (
            <button
              key={kind}
              type="button"
              onClick={() => void handleLoadSample(kind)}
              disabled={loadingKind !== null}
              data-tt={hint}
              className="inline-flex items-center gap-2 rounded-full border border-emerald-600 bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-soft transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadingKind === kind ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {label}
            </button>
          ))}
        </motion.div>

        <p className="mt-3 max-w-xl text-xs leading-relaxed text-slate-400">
          Same forum, two NoSQL models — comment threads embedded in each post, or split across collections and linked by id.
        </p>
      </div>

      <div className="mx-auto mt-8 grid max-w-5xl grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map(({ icon: Icon, title, description }, index) => (
          <motion.div
            key={title}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.4 }}
            variants={fadeUp}
            transition={{ duration: 0.5, delay: index * 0.08 }}
            className="rounded-2xl border border-slate-200 bg-white p-6 shadow-panel transition-transform hover:-translate-y-1"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-emerald-50 text-emerald-600">
              <Icon size={20} strokeWidth={2} />
            </div>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">{description}</p>
          </motion.div>
        ))}
      </div>

      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.6 }}
        variants={fadeUp}
        transition={{ duration: 0.5 }}
        className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-2 text-xs font-medium text-slate-400"
      >
        {TECH_STACK.map((tech) => (
          <span key={tech} className="rounded-full border border-slate-200 bg-white px-3 py-1">
            {tech}
          </span>
        ))}
      </motion.div>
    </section>
  );
}
