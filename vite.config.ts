import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const emptyModule = fileURLToPath(new URL('./src/lib/emptyModule.ts', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // jsPDF statically references these for its .html() API, which this app
      // never calls. Aliasing them to an empty module keeps ~240 KB gzipped of
      // rasteriser and sanitiser out of the analytics chunk.
      html2canvas: emptyModule,
      dompurify: emptyModule,
      canvg: emptyModule,
    },
  },
})
