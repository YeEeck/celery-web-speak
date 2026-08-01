import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        ws: true,
      },
    },
  },
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    // AudioWorklet rejects data: module URLs in Electron. Keep the worklet
    // as a same-origin asset so the packaged desktop client can load it.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: 'index.html',
        overlay: 'overlay.html',
      },
    },
  },
})
