import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

export default defineConfig(({ mode }) => {
  const rootDir = path.resolve(import.meta.dirname, '..')
  const env = { ...loadEnv(mode, rootDir, ''), ...loadEnv(mode, process.cwd(), '') }

  const clerkKey =
    process.env.VITE_CLERK_PUBLISHABLE_KEY ||
    process.env.Vite_CLERK_PUBLISHABLE_KEY ||
    process.env.Vite_CLERK_PUBILSHABLE_KEY ||
    process.env.VITE_CLERK_PUBILSHABLE_KEY ||
    process.env.CLERK_PUBLISHABLE_KEY ||
    env.VITE_CLERK_PUBLISHABLE_KEY ||
    env.Vite_CLERK_PUBLISHABLE_KEY ||
    env.Vite_CLERK_PUBILSHABLE_KEY ||
    env.VITE_CLERK_PUBILSHABLE_KEY ||
    env.CLERK_PUBLISHABLE_KEY ||
    Object.entries({ ...process.env, ...env }).find(
      ([k, v]) =>
        typeof v === 'string' &&
        v.startsWith('pk_') &&
        k.toUpperCase().includes('CLERK')
    )?.[1] ||
    ''

  return {
    define: clerkKey
      ? {
          'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': JSON.stringify(clerkKey),
        }
      : {},
    envPrefix: ['VITE_', 'Vite_', 'NEXT_PUBLIC_'],
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        devOptions: { enabled: false },
        includeAssets: ['favicon.svg', 'icons.svg'],
        manifest: {
          name: env.VITE_APP_NAME || 'Nextdoor',
          short_name: env.VITE_APP_NAME || 'Nextdoor',
          description: 'Your neighborhood — local feed, businesses, maps, and community circles.',
          theme_color: '#4f46e5',
          background_color: '#f8fafc',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          icons: [
            {
              src: '/icons/icon-192x192.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: '/icons/icon-512x512.png',
              sizes: '512x512',
              type: 'image/png',
            },
            {
              src: '/icons/icon-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          navigateFallback: '/offline.html',
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              urlPattern: ({ request }) => {
                const url = new URL(request.url)
                return url.pathname.startsWith('/api/') && request.method === 'GET'
              },
              handler: 'NetworkFirst',
              options: {
                cacheName: 'api-cache',
                networkTimeoutSeconds: 4,
                expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 3 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/.*\.tile\.openstreetmap\.org\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'osm-tiles-cache',
                expiration: { maxEntries: 1000, maxAgeSeconds: 60 * 60 * 24 * 30 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:4000',
          changeOrigin: true,
        },
      },
    },
  }
})
