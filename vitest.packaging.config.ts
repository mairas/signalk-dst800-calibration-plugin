import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/packaging.test.ts'],
    // The suite builds into dist/ and public/; two files racing on that state
    // would be reading each other's output.
    fileParallelism: false
  }
})
