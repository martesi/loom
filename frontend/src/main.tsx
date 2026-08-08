import { I18nProvider } from '@lingui/react'
import { RouterProvider } from '@tanstack/react-router'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { i18n } from './i18n'
import { router } from './router'
import './index.css'

// main.go's DefaultContextMenuDisabled only does anything on Windows (it
// maps to WebView2's PutAreDefaultContextMenusEnabled) — Wails v3 beta.4
// never wires up WebKitGTK's native "context-menu" signal on Linux, so
// without this the OS-native menu (Reload/Inspect Element/...) fires
// alongside the app's own right-click menus and can mask them. Suppressing
// it here, once, ahead of every listener the app attaches, is the only
// lever that actually works on this platform.
window.addEventListener('contextmenu', (event) => event.preventDefault())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nProvider>
  </React.StrictMode>
)
