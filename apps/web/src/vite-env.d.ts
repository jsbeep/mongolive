/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_SOURCE?: 'remote' | 'mock';
  // 'true' = 공개 데모 빌드(GitHub Pages) — Mock 첫 방문에 샘플 DB 둘을 넣어 둔다
  readonly VITE_DEMO?: string;
}

declare module '*.css' {
  const content: string;
  export default content;
}
