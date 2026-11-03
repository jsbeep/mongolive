// path: src/components/layout/Footer.tsx
import { Github } from 'lucide-react';

export function Footer() {
  return (
    <footer className="w-full border-t border-slate-200/60 px-6 py-8 sm:px-10 lg:px-20">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 sm:flex-row">
        <p className="text-xs text-slate-400">
          © {new Date().getFullYear()} JSON Explorer & Editor. Built by jsbeep.
        </p>
        <a
          href="https://github.com/jsbeep/json-explorer"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-emerald-300 hover:text-emerald-700"
        >
          <Github size={14} />
          GitHub Repository
        </a>
      </div>
    </footer>
  );
}
