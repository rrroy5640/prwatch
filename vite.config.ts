import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

// the node server (src/main.ts) serves dist/ in production and mounts Vite as middleware under `npm run dev`
export default defineConfig({
  root: 'web',
  plugins: [preact()],
  build: { outDir: '../dist', emptyOutDir: true },
})
