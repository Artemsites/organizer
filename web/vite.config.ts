import { defineConfig, loadEnv } from 'vite';
import { createApiProxy } from './vite.proxy';

export default defineConfig(({ mode }) => {
  // Третий аргумент '' — читать все переменные, а не только VITE_*.
  // Это Node-часть конфига: в клиентский бандл отсюда ничего не попадает.
  // Корень репозитория, а не web/: один .env на весь монорепо.
  const env = loadEnv(mode, new URL('..', import.meta.url).pathname, '');

  return {
    server: {
      port: 5173,
      open: false,
      proxy: createApiProxy(env),
    },
  };
});
