// 로그인 화면 — 비밀번호 하나만 받는다(혼자 쓰는 앱이라 아이디가 없다).
// 틀리면 카드가 살짝 흔들리고, 너무 많이 틀려 잠기면 남은 시간을 거꾸로 센다.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { motion, useAnimationControls } from 'framer-motion';
import { Eye, EyeOff, Loader2, LockKeyhole } from 'lucide-react';
import { login, LoginError, type LoginFailure } from '../../services/auth';

const styles = {
  screen: 'flex min-h-screen w-full items-center justify-center bg-grid-fade p-4',
  card: 'flex w-full max-w-sm flex-col gap-5 rounded-2xl bg-white p-6 shadow-elevated',
  brand: 'flex items-center gap-2.5',
  // Header의 로고와 같은 모양
  logoMark:
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] border border-emerald-200 bg-emerald-50 text-sm font-bold text-emerald-700',
  brandName: 'text-sm font-semibold tracking-tight text-slate-900',
  title: 'text-base font-semibold text-slate-900',
  subtitle: 'mt-1 text-sm text-slate-500',
  notice: 'rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-700',
  form: 'flex flex-col gap-3',
  label: 'text-xs font-medium text-slate-500',
  inputWrap: 'relative',
  // 테두리 색은 하나만 붙인다 — cn이 겹치는 클래스를 정리해 주지 않으므로 상태별 전체 문자열로 나눈다
  input:
    'w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-3 pr-10 text-sm text-slate-900 outline-none transition-colors focus:border-emerald-300 focus:ring-2 focus:ring-emerald-500/20 disabled:bg-slate-50',
  inputError:
    'w-full rounded-xl border border-rose-300 bg-white py-2.5 pl-3 pr-10 text-sm text-slate-900 outline-none transition-colors focus:border-rose-300 focus:ring-2 focus:ring-rose-500/20 disabled:bg-slate-50',
  eyeBtn:
    'absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600',
  error: 'text-sm text-rose-600',
  submit:
    'inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-emerald-500',
  hint: 'text-xs leading-relaxed text-slate-400',
  code: 'rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-600',
} as const;

const formatSeconds = (total: number): string => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;

const failureMessage = (failure: LoginFailure, secondsLeft: number): string => {
  switch (failure.kind) {
    case 'wrong':
      return 'Wrong password.';
    case 'locked':
      return `Too many attempts. Try again in ${formatSeconds(secondsLeft)}.`;
    case 'busy':
      return 'The server is busy. Try again in a few seconds.';
    case 'unreachable':
      return "Can't reach the server.";
    case 'other':
      return failure.message;
  }
};

interface LoginPageProps {
  // 쓰는 도중 출입증이 무효가 되어 다시 온 경우
  expired: boolean;
  onLoggedIn: () => void;
}

export function LoginPage({ expired, onLoggedIn }: LoginPageProps) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<LoginFailure | null>(null);
  // 잠금이 풀리는 시각 — 1초마다 남은 시간을 다시 그린다
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const shake = useAnimationControls();

  const secondsLeft = Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  const locked = secondsLeft > 0;

  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  // 잠금이 풀리면 안내를 지우고 다시 입력할 수 있게
  useEffect(() => {
    if (lockedUntil !== 0 && !locked) {
      setLockedUntil(0);
      setFailure(null);
      inputRef.current?.focus();
    }
  }, [locked, lockedUntil]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || pending || locked) return;
    setPending(true);
    setFailure(null);
    try {
      await login(password);
      onLoggedIn();
    } catch (e) {
      const next: LoginFailure = e instanceof LoginError ? e.failure : { kind: 'unreachable' };
      setFailure(next);
      if (next.kind === 'locked') {
        setNow(Date.now());
        setLockedUntil(Date.now() + next.retryAfter * 1000);
      }
      if (next.kind === 'wrong' || next.kind === 'locked') {
        setPassword('');
        void shake.start({ x: [0, -8, 8, -6, 6, -3, 0], transition: { duration: 0.4 } });
      }
      // 입력칸이 disabled에서 풀린 뒤에 포커스
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } finally {
      setPending(false);
    }
  };

  const hasError = failure !== null;

  return (
    <div className={styles.screen}>
      <motion.div
        className={styles.card}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: 'easeOut' }}
      >
        <motion.div animate={shake} className="flex flex-col gap-5">
          <div className={styles.brand}>
            <div className={styles.logoMark} aria-hidden="true">
              ML
            </div>
            <span className={styles.brandName}>MongoLive</span>
          </div>

          <div>
            <h1 className={styles.title}>Sign in</h1>
            <p className={styles.subtitle}>Enter the password for this server.</p>
          </div>

          {expired && <p className={styles.notice}>Your session ended. Sign in again to continue.</p>}

          <form className={styles.form} onSubmit={handleSubmit}>
            {/* 비밀번호 관리자가 '어느 계정의 비밀번호인지' 알 수 있게 — 화면엔 안 보인다 */}
            <input type="text" name="username" autoComplete="username" value="mongolive" readOnly hidden />
            <label htmlFor="login-password" className={styles.label}>
              Password
            </label>
            <div className={styles.inputWrap}>
              <input
                ref={inputRef}
                id="login-password"
                name="password"
                type={visible ? 'text' : 'password'}
                autoComplete="current-password"
                autoFocus
                className={hasError ? styles.inputError : styles.input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={pending || locked}
                aria-invalid={hasError}
                aria-describedby={hasError ? 'login-error' : undefined}
              />
              <button
                type="button"
                className={styles.eyeBtn}
                onClick={() => setVisible((v) => !v)}
                aria-label={visible ? 'Hide password' : 'Show password'}
              >
                {visible ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>

            {failure && (
              <p id="login-error" className={styles.error} role="alert">
                {failureMessage(failure, secondsLeft)}
              </p>
            )}

            <button type="submit" className={styles.submit} disabled={!password || pending || locked}>
              {pending ? <Loader2 size={15} className="animate-spin" /> : <LockKeyhole size={15} />}
              {pending ? 'Checking…' : 'Sign in'}
            </button>
          </form>

          <p className={styles.hint}>
            Forgot it? Set a new one on the server machine:
            <br />
            <code className={styles.code}>corepack pnpm --filter @mongolive/server set-password</code>
          </p>
        </motion.div>
      </motion.div>
    </div>
  );
}
