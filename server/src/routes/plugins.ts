import type { FastifyInstance } from 'fastify';
import type { PluginManifest } from '@organizer/shared';

// Реестр установленных на сервере плагинов (позже расширяется чтением директории plugins/)
const registeredPlugins: Map<string, { manifest: PluginManifest; clientBundle?: string }> = new Map();

export function registerServerPlugin(manifest: PluginManifest, clientBundle?: string) {
  registeredPlugins.set(manifest.id, { manifest, clientBundle });
}

export async function pluginRoutes(fastify: FastifyInstance) {
  // Список доступных плагинов
  fastify.get('/api/v1/plugins', async () => {
    const list = Array.from(registeredPlugins.values()).map((p) => p.manifest);
    return {
      success: true,
      data: list,
      timestamp: Date.now(),
    };
  });

  // Манифест конкретного плагина
  fastify.get('/api/v1/plugins/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const plugin = registeredPlugins.get(id);
    if (!plugin) {
      reply.status(404);
      return { success: false, error: 'Plugin not found', timestamp: Date.now() };
    }
    return { success: true, data: plugin.manifest, timestamp: Date.now() };
  });

  // Раздача клиентского бандла/скрипта плагина
  fastify.get('/api/v1/plugins/:id/client', async (request, reply) => {
    const { id } = request.params as { id: string };
    const plugin = registeredPlugins.get(id);
    if (!plugin) {
      reply.status(404);
      return { success: false, error: 'Plugin not found', timestamp: Date.now() };
    }

    reply.type('application/javascript');
    return plugin.clientBundle || `// No client bundle for plugin ${id}\nexport default {};`;
  });
}
