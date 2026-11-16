import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createAppRuntime } from './server/index.js';

const runtime = createAppRuntime();

export default defineConfig({
  plugins: [react(), ...runtime.plugins],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
