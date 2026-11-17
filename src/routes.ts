// Rutas del API. Cada una sirve el payload tipado de una vista. Ante fallo de
// BD/consulta responde 503 (el frontend lo trata como 'offline' → muestra s/d).

import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import * as repo from './repo.ts';
import { analisis, alertas } from './analisis.ts';
import { runPipeline, ingestaEnCurso } from './pipeline.ts';
import { env } from './env.ts';

/** Comparación en tiempo constante del Bearer token de ingesta. */
function tokenValido(header: string | undefined): boolean {
  if (!env.ingestToken || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(env.ingestToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

  // Capa analítica (tesis, semáforo, ciclo, monetario, condiciones, deuda, FX…)
  app.get('/api/analisis', wrap(analisis));
  app.get('/api/alertas', wrap(alertas));
  app.get('/api/agregados', wrap(repo.agregados));
  app.get('/api/historico/:iso3', async (req, reply) => {
    const { iso3 } = req.params as { iso3: string };
    try {
      const h = await repo.historico(iso3.toUpperCase());
      if (!h) return reply.code(404).send({ error: 'país desconocido' });
      return h;
    } catch (err) {
      app.log.error(err);
      return reply.code(503).send({ error: 'fuente/BD no disponible' });
    }
  });

  // Ingesta: estado (público) y disparo manual (Bearer $INGEST_TOKEN).
  app.get('/api/ingesta', wrap(async () => ({ enCurso: ingestaEnCurso(), jobs: await repo.ingestaEstado() })));
  app.post('/api/ingesta', async (req, reply) => {
    if (!tokenValido(req.headers.authorization)) return reply.code(401).send({ error: 'no autorizado' });
    const body = (req.body ?? {}) as { fuentes?: string[] };
    const corridas = await runPipeline({ disparador: 'api', fuentes: body.fuentes, incluirLentos: true });
    return { corridas };
  });

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
