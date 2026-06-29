// Rutas del API. Cada una sirve el payload tipado de una vista. Ante fallo de
// BD/consulta responde 503 (el frontend lo trata como 'offline' → muestra s/d).

import type { FastifyInstance } from 'fastify';
import * as repo from './repo.ts';

export async function routes(app: FastifyInstance) {
  const wrap =
    <T>(fn: () => Promise<T>) =>
    async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      try {
        return await fn();
      } catch (err) {
        app.log.error(err);
        reply.code(503).send({ error: 'fuente/BD no disponible', detail: (err as Error).message });
      }
    };

  app.get('/api/paises', wrap(repo.paises));
  app.get('/api/pulso', wrap(repo.pulso));
  app.get('/api/heatmap-macro', wrap(repo.heatmap));
  app.get('/api/riesgo-soberano', wrap(repo.riesgoSoberano));
  app.get('/api/fx-commodities', wrap(repo.fxCommodities));
  app.get('/api/tasas-reales', wrap(repo.tasasReales));
  app.get('/api/comercio', wrap(repo.comercio));
  app.get('/api/conflictos', wrap(repo.conflictos));
  app.get('/api/conflictos/eventos', wrap(repo.eventos));
  app.get('/api/calendario', wrap(repo.calendario));
  app.get('/api/fuentes', wrap(repo.fuentes));

  app.get('/api/media/live/:channelId', async (req) => {
    const { channelId } = req.params as { channelId: string };
    return repo.resolveLive(channelId);
  });

  // Series históricas para el modal (clic en un valor).
  app.get('/api/serie/mercado/:symbol', async (req) => {
    const { symbol } = req.params as { symbol: string };
    return repo.serieMercado(symbol);
  });
  app.get('/api/serie/indicador/:iso3/:codigo', async (req) => {
    const { iso3, codigo } = req.params as { iso3: string; codigo: string };
    return repo.serieIndicador(iso3, codigo);
  });
}
