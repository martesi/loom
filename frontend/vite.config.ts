import path from 'node:path'
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import wails from '@wailsio/runtime/plugins/vite'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [
    react(),
    tailwindcss(),
    lingui(),
    // plugin-react v6 (oxc) has no `babel` option, so the macro transform runs
    // as its own rolldown babel pass.
    babel({ presets: [linguiTransformerBabelPreset()] }),
    wails('./bindings'),
  ],
})
