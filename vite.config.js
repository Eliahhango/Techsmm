import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

function spaFallback() {
  return {
    name: 'spa-fallback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://localhost')
        const pathname = decodeURIComponent(url.pathname)

        if (pathname.startsWith('/@') || pathname.startsWith('/src') || pathname.startsWith('/api')) return next()

        const publicPath = path.join(process.cwd(), 'public', pathname)
        if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) return next()

        const srcPath = path.join(process.cwd(), pathname)
        if (fs.existsSync(srcPath) && fs.statSync(srcPath).isFile()) return next()

        req.url = '/index.html'
        next()
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), spaFallback()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
})
