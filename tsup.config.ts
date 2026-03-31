import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    'server/index': 'src/server/index.ts',
    'client/index': 'src/client/index.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  external: ['better-sqlite3'],
  banner: {
    js: '#!/usr/bin/env node',
  },
  esbuildOptions(options) {
    options.banner = {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    };
  },
});
