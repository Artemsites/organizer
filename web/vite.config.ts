import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { createApiProxy } from './vite.proxy';

export default defineConfig(({ mode }) => {
  // Третий аргумент '' — все переменные, а не только VITE_*. Один .env на весь монорепо.
  const env = loadEnv(mode, resolve(import.meta.dirname, '..'), '');

  return {
    server: {
      port: 5173,
      open: false,
      proxy: createApiProxy(env),
    },
  };
});
