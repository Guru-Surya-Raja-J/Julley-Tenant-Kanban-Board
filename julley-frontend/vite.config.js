import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Where the dev server forwards API and socket traffic. See julley-backend.
const apiTarget = process.env.API_TARGET ?? 'http://localhost:4000'

const proxy = {
  '/api': apiTarget,
  '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 5173, proxy },
})
