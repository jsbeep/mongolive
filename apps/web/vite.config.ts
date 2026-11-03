import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot);

  return {
    plugins: [react()],
    server: {
      // 기본은 로컬 전용. 외부 노출은 인증 단계(7단계)에서 프록시/인증과 함께 연다.
      host: env.VITE_HOST || '127.0.0.1',
      port: Number(env.VITE_PORT) || 5173,
    },
    resolve: {
      alias: {
        '@': resolve(projectRoot, 'src'),
      },
    },
  };
});
