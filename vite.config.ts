import { resolve } from 'path';
import { defineConfig } from 'vite';

const nodeBuiltins = [
  'vscode',
  'path',
  'fs',
  'os',
  'node:path',
  'node:fs',
  'node:os',
];

export default defineConfig(({ mode }) => ({
  build: {
    outDir: 'out',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/extension.ts'),
      formats: ['cjs'],
      fileName: () => 'extension.js',
    },
    rollupOptions: {
      external: (id) => nodeBuiltins.includes(id) || id.startsWith('node:'),
    },
    sourcemap: mode !== 'production',
    minify: mode === 'production',
    target: 'node18',
    copyPublicDir: false,
  },
}));
