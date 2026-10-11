import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../.codex/design-preview-dist',
    emptyOutDir: true,
    rollupOptions: { input: 'design-preview.html' },
  },
});
