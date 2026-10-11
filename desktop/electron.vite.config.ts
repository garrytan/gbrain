import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    publicDir: resolve('..', 'admin/public'),
    resolve: {
      alias: {
        'react-dom': resolve('..', 'admin/node_modules/react-dom'),
        react: resolve('..', 'admin/node_modules/react'),
      },
    },
    esbuild: { jsx: 'automatic' },
  },
});
