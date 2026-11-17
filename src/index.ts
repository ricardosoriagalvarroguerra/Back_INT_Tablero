// Bootstrap del API Fastify. Sirve las rutas del tablero desde la BDR.
//   dev:  npm run dev   ·   prod:  npm start
// Al arrancar: aprovisiona la BDR si hace falta, escucha en $PORT y lanza la
// ingesta (al arrancar y cada INGEST_INTERVAL_HOURS). INGEST_ON_START=false la
// desactiva (p.ej. para desarrollo del frontend contra una base ya poblada).

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './env.ts';
import { ping } from './db.ts';
import { routes } from './routes.ts';
import { ensureDatabase, estadoSeed } from './bootstrap.ts';
import { runPipeline, ultimaOmitida } from './pipeline.ts';

const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, { origin: true });
await app.register(routes);

app.get('/api/healthz', async () => ({ ok: await ping(), ts: new Date().toISOString(), seed: estadoSeed() }));

await ensureDatabase();

try {
  await app.listen({ port: env.apiPort, host: '0.0.0.0' });
  app.log.info(`API Tablero INT escuchando en :${env.apiPort}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Ingesta programada dentro del proceso (no requiere cron externo).
if (env.ingestOnStart) {
  const correr = (disparador: string, incluirLentos: boolean) =>
    runPipeline({ disparador, incluirLentos }).catch((e) => app.log.error(e, 'ingesta falló'));
  // En un redespliegue la instancia vieja puede seguir viva unos minutos con el
  // candado tomado: se reintenta la ingesta de arranque cada 2 min (hasta 5 veces).
  const arranque = async (intento: number) => {
    await correr(intento === 0 ? 'arranque' : 'arranque-reintento', true);
    if (ultimaOmitida() && intento < 5) setTimeout(() => void arranque(intento + 1), 120_000);
  };
  setTimeout(() => void arranque(0), 3_000);
  if (env.ingestIntervalHours > 0) {
    let n = 0;
    setInterval(
      // Comtrade (lento, anual) sólo cada 4 corridas; el resto en cada una.
      () => void correr('programada', ++n % 4 === 0),
      env.ingestIntervalHours * 3_600_000,
    );
  }
}
