import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // The server reads PORT from the repo-root .env, so proxy to the same port.
  // Only PORT is loaded from that file.
  const rootEnv = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), 'PORT');
  const port = process.env.PORT || rootEnv.PORT || 3001;
  return {
    plugins: [react()],
    server: {
      proxy: { '/api': `http://localhost:${port}` },
    },
  };
});
