import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * HTTPS for the dev server, when a certificate has been made for this machine.
 *
 * Needed to test on a real phone. Browsers only hand navigator.geolocation to a secure
 * context, with localhost as the single exemption — so over http://192.168.x.x the map
 * draws but never gets a position, and the journey tracking cannot be tried at all.
 *
 * The certificate is machine-specific and gitignored, so this stays undefined on a fresh
 * checkout and the server falls back to http. Remake it with mkcert after a change of
 * Wi-Fi address, since an IP cannot be wildcarded:
 *
 *   mkcert -key-file certs/dev-key.pem -cert-file certs/dev-cert.pem \
 *     localhost 127.0.0.1 ::1 <this machine's LAN IP> <hostname>
 */
const KEY = 'certs/dev-key.pem';
const CERT = 'certs/dev-cert.pem';
const https = existsSync(KEY) && existsSync(CERT)
  ? { key: readFileSync(KEY), cert: readFileSync(CERT) }
  : undefined;

export default defineConfig({
  base: '/songa/',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    https,
    // Keeps the frontend on one origin: /api goes to the Express server, so there is no
    // CORS setup and no API host to configure per environment.
    proxy: { '/api': { target: 'http://localhost:5175', changeOrigin: true } },
  },
});
