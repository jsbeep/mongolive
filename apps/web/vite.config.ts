import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot);
  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:31501';

  return {
    plugins: [react()],
    server: {
      // 기본은 로컬 전용. 외부 노출은 인증 단계(7단계)에서 프록시/인증과 함께 연다.
      host: env.VITE_HOST || '127.0.0.1',
      port: Number(env.VITE_PORT) || 5173,
      // 포트가 이미 쓰이고 있으면 다음 번호로 넘어가지 않고 멈춘다 — 31500 다음인 31501은 서버 자리라 겹치면 안 된다
      strictPort: true,
      // /api 요청을 서버(apps/server)로 넘긴다 — 브라우저 입장에선 같은 주소라 CORS 설정이 필요 없다.
      // changeOrigin: false — Host 헤더를 브라우저가 보낸 그대로 넘긴다. 서버 문지기가 Origin과 Host를 맞춰 보기 때문
      // (문자열로만 쓰면 Vite가 changeOrigin: true로 바꿔 Host가 서버 주소가 되고, 모든 요청이 거절된다)
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false },
        // 실시간 변경(socket.io) — WebSocket 연결도 넘긴다
        '/socket.io': { target: apiTarget, changeOrigin: false, ws: true },
      },
    },
    resolve: {
      alias: {
        '@': resolve(projectRoot, 'src'),
      },
    },
  };
});
