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
      entry: {
        extension: resolve(__dirname, 'src/extension.ts'),
        'hooks/track': resolve(__dirname, 'src/hooks/track.ts'),
        'hooks/limit': resolve(__dirname, 'src/hooks/limit.ts'),
      },
      formats: ['cjs'],
      fileName: (_, name) => (name === 'extension' ? 'extension.js' : `${name}.js`),
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
