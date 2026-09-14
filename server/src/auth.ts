import type { FastifyRequest, FastifyReply } from 'fastify';

export const DEFAULT_TOKEN = 'organizer-secret-token';

export async function authHook(request: FastifyRequest, reply: FastifyReply) {
  // Пропускаем проверку для healthcheck
  if (request.url.startsWith('/health')) {
    return;
  }

  const expectedToken = process.env.ORGANIZER_TOKEN || DEFAULT_TOKEN;
  const clientToken = request.headers['x-client-token'];

  if (!clientToken || clientToken !== expectedToken) {
    reply.status(401).send({
      success: false,
      error: 'Unauthorized: invalid or missing x-client-token',
      timestamp: Date.now(),
    });
  }
}
