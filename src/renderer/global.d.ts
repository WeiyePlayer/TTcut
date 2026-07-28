import type { TTcutApi } from '../shared/api';

declare global {
  interface Window {
    ttcut: TTcutApi;
  }
}

declare module '*.png' {
  const source: string;
  export default source;
}

export {};
