import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    __TTCUT_INDEPENDENT_BETA__: JSON.stringify(process.env.TTCUT_INDEPENDENT_BETA === '1'),
  },
  build: {
    sourcemap: true,
    minify: false,
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
      },
    },
  },
});
