import type { ProxyOptions } from 'vite';

/**
 * Прокси /api -> ядро. Токен подставляет прокси в Node-процессе Vite, а не бандл.
 * Никогда не читать токен через import.meta.env / VITE_*: Vite встраивает их в клиентский код.
 */
export function createApiProxy(env: Record<string, string | undefined>): Record<string, ProxyOptions> {
  const token = env.ORGANIZER_TOKEN;

  return {
    '/api': {
      target: env.ORGANIZER_URL || 'http://127.0.0.1:3000',
      changeOrigin: true,
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq) => {
          // Пустой токен не отправляем вовсе: сервер обязан ответить 401,
          // а не принять запрос с пустым заголовком.
          if (token) {
            proxyReq.setHeader('x-client-token', token);
          }
        });
      },
    },
  };
}
