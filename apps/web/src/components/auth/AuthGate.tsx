// 앱 앞의 관문 — 로그인했으면 앱을, 아니면 로그인 화면을 보여 준다.
//   Mock 모드: 서버가 없으니 그냥 통과
//   remote 모드: 서버에 "로그인했나?"를 물어보고(/api/auth/me) 결정
//
// 쓰는 도중 출입증이 무효가 되면(401) 로그인 화면으로 돌아간다. 다시 로그인하면 페이지를 새로 불러온다
// — 끊긴 실시간 연결과 화면 상태를 한 번에 깨끗하게 되살리는 가장 확실한 방법이라서.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Loader2, RefreshCw, ServerOff } from 'lucide-react';
import { dataSourceKind } from '../../services/api';
import { fetchAuthStatus, logout, onSessionExpired } from '../../services/auth';
import { LoginPage } from './LoginPage';

interface AuthContextValue {
  // 로그아웃 버튼을 보여 줄지 — Mock 모드엔 로그인이 없다
  canLogout: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({ canLogout: false, logout: async () => undefined });

export const useAuth = (): AuthContextValue => useContext(AuthContext);

type Phase =
  | { name: 'checking' }
  | { name: 'unreachable' }
  | { name: 'login'; expired: boolean }
  | { name: 'ready' };

const styles = {
  screen: 'flex min-h-screen w-full items-center justify-center bg-grid-fade p-4',
  card: 'flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl bg-white p-6 text-center shadow-elevated',
  iconWrap: 'flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50',
  title: 'text-base font-semibold text-slate-900',
  message: 'text-sm leading-relaxed text-slate-500',
  retryBtn:
    'inline-flex items-center gap-2 rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-200',
} as const;

function RemoteAuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ name: 'checking' });

  const check = useCallback(async () => {
    setPhase({ name: 'checking' });
    try {
      const status = await fetchAuthStatus();
      setPhase(status.authenticated ? { name: 'ready' } : { name: 'login', expired: false });
    } catch {
      setPhase({ name: 'unreachable' });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // 쓰는 도중 401 → 로그인 화면(이미 로그인 화면이면 그대로)
  useEffect(
    () => onSessionExpired(() => setPhase((current) => (current.name === 'ready' ? { name: 'login', expired: true } : current))),
    [],
  );

  const handleLoggedIn = useCallback(() => {
    if (phase.name === 'login' && phase.expired) window.location.reload();
    else setPhase({ name: 'ready' });
  }, [phase]);

  const handleLogout = useCallback(async () => {
    await logout();
    // 실시간 연결과 화면에 남은 데이터를 함께 정리
    window.location.reload();
  }, []);

  if (phase.name === 'checking') {
    return (
      <div className={styles.screen}>
        <Loader2 size={22} className="animate-spin text-slate-400" aria-label="Checking sign-in" />
      </div>
    );
  }

  if (phase.name === 'unreachable') {
    return (
      <div className={styles.screen}>
        <div className={styles.card} role="alert">
          <div className={styles.iconWrap}>
            <ServerOff size={22} className="text-rose-500" />
          </div>
          <div>
            <p className={styles.title}>Can't reach the server</p>
            <p className={`${styles.message} mt-1`}>Check that apps/server is running, then try again.</p>
          </div>
          <button type="button" className={styles.retryBtn} onClick={() => void check()}>
            <RefreshCw size={14} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (phase.name === 'login') return <LoginPage expired={phase.expired} onLoggedIn={handleLoggedIn} />;

  return <AuthContext.Provider value={{ canLogout: true, logout: handleLogout }}>{children}</AuthContext.Provider>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  if (dataSourceKind === 'mock') return <>{children}</>;
  return <RemoteAuthGate>{children}</RemoteAuthGate>;
}
