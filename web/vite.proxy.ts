import type { ProxyOptions } from 'vite';

/**
 * Прокси /api -> ядро.
 *
 * Зачем прокси, а не CORS: web и сервер живут на разных портах, а X-Client-Token —
 * общий секрет. Попади он в бандл, его увидит любой, кто открыл страницу (принцип 0
 * spec.md). Поэтому токен подставляет сам прокси — он выполняется в Node-процессе
 * Vite, а до браузера доходит уже проксированный ответ.
 *
 * Никогда не читать токен через import.meta.env / VITE_*: эти переменные Vite
 * встраивает в клиентский код.
 */
export function createApiProxy(env: Record<string, string | undefined>): Record<string, ProxyOptions> {
  const token = env.ORGANIZER_TOKEN ?? '';

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
