import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

// base './' keeps asset URLs relative to <base href>, which the Go server
// rewrites for --base-path, so one build serves any sub-path.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  // One bundle on purpose: the binary serves it gzipped and long-cached, CodeMirror included.
  build: { chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
