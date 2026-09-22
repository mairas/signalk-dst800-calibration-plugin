import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Packaging runs separately: it builds, so it is neither hermetic nor fast.
    exclude: ['test/ui/**', 'test/packaging.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/ui/**', 'src/**/*.d.ts']
    }
  }
})
