import type { TTcutApi } from '../shared/api';

declare global {
  interface Window {
    ttcut: TTcutApi;
  }
}

export {};

