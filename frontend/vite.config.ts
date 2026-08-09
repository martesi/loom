import fs from 'node:fs'
import path from 'node:path'
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import wails from '@wailsio/runtime/plugins/vite'
import { defineConfig, type ProxyOptions } from 'vite'

const vitePort = Number(process.env.WAILS_VITE_PORT) || 9245
const viteHost = process.env.WAILS_VITE_HOST || '127.0.0.1'
const serverDevelopment = ['1', 'true'].includes(
  process.env.LOOM_SERVER_DEV ?? ''
)
const backendURL =
  process.env.LOOM_SERVER_URL ||
  `http://127.0.0.1:${Number(process.env.WAILS_SERVER_PORT) || 8080}`
const developmentToken =
  process.env.LOOM_DEV_TOKEN || process.env.LOOM_TOKEN || ''
const distDirectory = path.resolve(import.meta.dirname, './dist')

// The native Wails asset server can proxy HTTP, but beta.4 deliberately
// rejects WebSocket requests. Tell Vite's client to connect to the real Vite
// server so native development keeps HMR without requiring a Wails fork.
const hmr = {
  protocol: 'ws' as const,
  host: viteHost,
  port: vitePort,
  clientPort: vitePort,
}

function withDevelopmentCookie(cookieHeader: string | undefined) {
  if (!developmentToken) return cookieHeader

  const cookies = (cookieHeader ?? '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .filter((cookie) => cookie.split('=', 1)[0].trim() !== 'loom_token')

  cookies.push(`loom_token=${developmentToken}`)
  return cookies.join('; ')
}

const configureBackendProxy: NonNullable<ProxyOptions['configure']> = (
  proxy
) => {
  const authenticate = (
    proxyRequest: { setHeader: (name: string, value: string) => void },
    request: { headers: { cookie?: string } }
  ) => {
    const cookie = withDevelopmentCookie(request.headers.cookie)
    if (cookie) proxyRequest.setHeader('cookie', cookie)
  }

  proxy.on('proxyReq', (proxyRequest, request) =>
    authenticate(proxyRequest, request)
  )
  proxy.on('proxyReqWs', (proxyRequest, request) =>
    authenticate(proxyRequest, request)
  )
}

function backendProxy(ws: boolean): ProxyOptions {
  return {
    target: backendURL,
    ws,
    // Keep the browser's Host and Origin intact. The server auth gate uses
    // them to verify that /wails/events is a same-origin WebSocket, while
    // http-proxy preserves the original path, query, cookies, and upgrades.
    changeOrigin: false,
    configure: configureBackendProxy,
  }
}

// Go's //go:embed needs frontend/dist to exist in a fresh checkout, while
// Vite normally removes the output directory before every build. Preserve a
// harmless placeholder so development server builds can compile before the
// first frontend build, without allowing stale assets to survive a rebuild.
function preserveEmbedPlaceholder() {
  return {
    name: 'loom-embed-placeholder',
    apply: 'build' as const,
    buildStart() {
      fs.mkdirSync(distDirectory, { recursive: true })
      for (const entry of fs.readdirSync(distDirectory)) {
        if (entry !== '.gitkeep') {
          fs.rmSync(path.join(distDirectory, entry), {
            recursive: true,
            force: true,
          })
        }
      }
      fs.closeSync(fs.openSync(path.join(distDirectory, '.gitkeep'), 'a'))
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    emptyOutDir: false,
  },
  server: {
    host: viteHost,
    port: vitePort,
    strictPort: true,
    hmr,
    ...(serverDevelopment
      ? {
          proxy: {
            '/wails': backendProxy(true),
            '/loom-asset': backendProxy(false),
          },
        }
      : {}),
  },
  plugins: [
    preserveEmbedPlaceholder(),
    react(),
    tailwindcss(),
    lingui(),
    // plugin-react v6 (oxc) has no `babel` option, so the macro transform runs
    // as its own rolldown babel pass.
    babel({ presets: [linguiTransformerBabelPreset()] }),
    wails('./bindings'),
  ],
})
