import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
      '@renderer': new URL('./src/renderer', import.meta.url).pathname,
    },
  },
});

