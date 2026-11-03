/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_SOURCE?: 'remote' | 'mock';
}

declare module '*.css' {
  const content: string;
  export default content;
}
