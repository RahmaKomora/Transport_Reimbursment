import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/songa/',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    // Keeps the frontend on one origin: /api goes to the Express server, so there is no
    // CORS setup and no API host to configure per environment.
    proxy: { '/api': { target: 'http://localhost:5175', changeOrigin: true } },
  },
});
