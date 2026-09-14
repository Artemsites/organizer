import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createApiProxy } from '../vite.proxy';

// Минимальные заглушки вместо реального http-proxy: тесту нужен только факт
// установки заголовка, поднимать Vite ради этого незачем.
function runProxyReq(env: Record<string, string | undefined>) {
  const options = createApiProxy(env)['/api'];
  const proxy = new EventEmitter();
  (options.configure as (p: EventEmitter) => void)(proxy);

  const setHeader = vi.fn();
  proxy.emit('proxyReq', { setHeader });
  return setHeader;
}

describe('Vite proxy: транспорт и авторизация браузера', () => {
  it('цель берётся из ORGANIZER_URL', () => {
    const proxy = createApiProxy({ ORGANIZER_URL: 'http://10.0.0.5:4000' });
    expect(proxy['/api'].target).toBe('http://10.0.0.5:4000');
  });

  it('по умолчанию цель — локальное ядро на 127.0.0.1:3000', () => {
    expect(createApiProxy({})['/api'].target).toBe('http://127.0.0.1:3000');
    // Пустая строка в env — тоже "не задано", а не пустой target.
    expect(createApiProxy({ ORGANIZER_URL: '' })['/api'].target).toBe('http://127.0.0.1:3000');
  });

  it('подставляет x-client-token из ORGANIZER_TOKEN', () => {
    const setHeader = runProxyReq({ ORGANIZER_TOKEN: 'secret-from-env' });
    expect(setHeader).toHaveBeenCalledWith('x-client-token', 'secret-from-env');
  });

  it('при пустом ORGANIZER_TOKEN заголовок не ставится вовсе', () => {
    expect(runProxyReq({}).mock.calls).toHaveLength(0);
    expect(runProxyReq({ ORGANIZER_TOKEN: '' }).mock.calls).toHaveLength(0);
  });
});
