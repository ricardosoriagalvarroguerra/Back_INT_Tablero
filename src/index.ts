// Bootstrap del API Fastify. Sirve las rutas del tablero desde la BDR.
//   dev:  npm run dev   ·   prod:  npm start

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './env.ts';
import { ping } from './db.ts';
import { routes } from './routes.ts';

const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, { origin: true });
await app.register(routes);

app.get('/api/healthz', async () => ({ ok: await ping(), ts: new Date().toISOString() }));

try {
  await app.listen({ port: env.apiPort, host: '0.0.0.0' });
  app.log.info(`API Tablero INT escuchando en :${env.apiPort}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
