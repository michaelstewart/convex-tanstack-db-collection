import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@michaelstewart/convex-tanstack-db-collection',
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
  },
})
