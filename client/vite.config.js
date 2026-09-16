import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// The dev server proxies to the API rather than the client calling it cross-origin, so the
// browser sees a single origin in development exactly as it will in production. That matters
// for more than tidiness: it means cookies, CORS and the Socket.IO handshake behave the same
// way locally as when the built client is served by Express.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Socket.IO needs its upgrade proxied too, or the live board silently falls back to
      // polling and looks like it works while being seconds behind.
      '/socket.io': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
