// HTTP 또는 HTTPS 서버 만들기.
//
// TLS_CERT / TLS_KEY가 있으면 HTTPS. 인증서를 어디서 구할지는 각자 환경의 일이다:
//   공인 인증기관(Let's Encrypt — 도메인 필요), mkcert(내 기기들이 믿는 나만의 인증기관), Tailscale 등.
// 인증서는 보통 주기적으로 갱신된다(Let's Encrypt는 90일). 파일이 바뀌면 서버를 다시 켜지 않고 새 인증서로 바꿔 낀다.
import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { createServer as createHttpServer, type RequestListener, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';

interface TlsFiles {
  cert: string;
  key: string;
}

const readPair = (files: TlsFiles): { cert: Buffer; key: Buffer } => {
  const read = (path: string, what: string): Buffer => {
    try {
      return readFileSync(path);
    } catch (e) {
      throw new Error(`${what} 파일을 읽을 수 없습니다: ${path} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
  };
  return { cert: read(files.cert, 'TLS_CERT 인증서'), key: read(files.key, 'TLS_KEY 비밀키') };
};

export interface AppServer {
  server: HttpServer | HttpsServer;
  scheme: 'http' | 'https';
  stop: () => void;
}

export const createAppServer = (app: RequestListener, files: TlsFiles | null): AppServer => {
  if (!files) return { server: createHttpServer(app), scheme: 'http', stop: () => undefined };

  // 인증서와 비밀키가 짝이 안 맞으면 여기서 에러가 난다 — 켜기 전에 알 수 있다
  const server = createHttpsServer(readPair(files), app);

  // 갱신 도구는 두 파일을 차례로 바꾸므로, 마지막 변경 뒤 잠깐 기다렸다가 한 번에 다시 읽는다
  let timer: NodeJS.Timeout | undefined;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        server.setSecureContext(readPair(files));
        console.log('[tls] 인증서를 새로 읽었습니다');
      } catch (e) {
        // 반쯤 바뀐 상태 등 — 지금 쓰는 인증서를 그대로 두고 다음 변경을 기다린다
        console.error('[tls] 새 인증서를 쓸 수 없어 이전 것을 계속 씁니다:', (e as Error).message);
      }
    }, 2000);
  };
  // watchFile: 일정 간격으로 수정 시각을 비교 — 파일이 지워졌다 새로 생겨도(갱신 도구가 흔히 그렇게 한다) 놓치지 않는다
  const INTERVAL = { interval: 60 * 1000 };
  watchFile(files.cert, INTERVAL, reload);
  watchFile(files.key, INTERVAL, reload);

  return {
    server,
    scheme: 'https',
    stop: () => {
      clearTimeout(timer);
      unwatchFile(files.cert);
      unwatchFile(files.key);
    },
  };
};
