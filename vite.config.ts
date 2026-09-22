import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/ui',
  base: './',
  build: {
    outDir: '../../public',
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/signalk': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true
      },
      '/plugins/signalk-airmar-dst-config': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true
      }
    }
  }
})
