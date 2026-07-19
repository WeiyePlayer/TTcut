import { defineConfig } from 'vite';

export default defineConfig({
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
