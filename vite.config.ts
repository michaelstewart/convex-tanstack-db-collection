import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    dts({
      outDir: 'dist/esm',
      include: ['src'],
      rollupTypes: true,
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es', 'cjs'],
      fileName: (format) => {
        if (format === 'es') return 'esm/index.js'
        return 'cjs/index.cjs'
      },
    },
    rollupOptions: {
      external: ['convex', 'convex/browser', 'convex/server', '@tanstack/db', '@standard-schema/spec'],
      output: {
        preserveModules: false,
      },
    },
    outDir: 'dist',
    sourcemap: true,
    minify: false,
  },
})
