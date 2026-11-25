import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const target = process.env.CHIORIM_API_TARGET ?? 'http://127.0.0.1:3000'
export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('highlight.js')) return 'vendor-hljs'
          if (id.includes('marked') || id.includes('dompurify')) return 'vendor-markdown'
          if (id.includes('lucide-svelte')) return 'vendor-icons'
        },
      },
    },
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target },
      '/uploads': { target },
      '/ws': { target, ws: true },
    },
  },
})
