import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    sourcemap: true,
    bundle: true,
    dts: true,
    clean: true,
    minify: true,
    outDir: 'build/esm',
    external: ['@renmx-aiflow/plugin-core', '@renmx-aiflow/ai-engine'],
  },
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    sourcemap: true,
    bundle: true,
    dts: true,
    clean: true,
    minify: true,
    outDir: 'build/cjs',
    external: ['@renmx-aiflow/plugin-core', '@renmx-aiflow/ai-engine'],
  },
])
