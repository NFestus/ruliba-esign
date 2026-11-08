import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  resolve: {
    // Use the shared package's TypeScript source directly (validation rules shared with the API).
    alias: { '@ruliba/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts') },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Ruliba Clays eSign',
        short_name: 'eSign',
        description: 'Prepare, send and sign Ruliba Clays documents.',
        theme_color: '#2E323C',
        background_color: '#F4F4F3',
        id: '/',
        scope: '/',
        display: 'standalone',
        start_url: '/',
        orientation: 'any',
        lang: 'en',
        categories: ['business', 'productivity'],
        icons: [
          { src: '/logo-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/logo-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/logo-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cache the app shell only. API responses and documents are never cached on the device.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
  preview: { port: 4173, proxy: { '/api': 'http://localhost:3000' } },
  test: { globals: true, environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
});
