import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    // Same decorator model as the Vite build, which reads src/ui/tsconfig.json.
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false
      }
    }
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['test/ui/**/*.test.ts']
  }
})
