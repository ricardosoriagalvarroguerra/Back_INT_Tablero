// CLI de ingesta: corre todas las fuentes (incluidas las lentas) una vez.
//   uso:  npm run ingest            · todas
//         npm run ingest -- bis fred · sólo esas fuentes/jobs

import { pool, query } from './db.ts';
import { ensureDatabase } from './bootstrap.ts';
import { runPipeline } from './pipeline.ts';

async function main() {
  console.log('▶ Ingesta Tablero INT —', new Date().toISOString());
  await ensureDatabase();
  const fuentes = process.argv.slice(2);
  await runPipeline({ disparador: 'cli', fuentes, incluirLentos: true });

  const [r] = await query<{ ts: string; mk: string; tr: string; ge: string; ag: string }>(
    `SELECT (SELECT count(*) FROM fact_timeseries) ts, (SELECT count(*) FROM fact_market) mk,
            (SELECT count(*) FROM fact_trade) tr, (SELECT count(*) FROM fact_geo_events) ge,
            (SELECT count(*) FROM fact_aggregate) ag`,
  );
  console.log(
    `■ Filas → fact_timeseries=${r.ts} · fact_market=${r.mk} · fact_aggregate=${r.ag} · fact_trade=${r.tr} · fact_geo_events=${r.ge}`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error('Ingesta abortada:', err);
  await pool.end();
  process.exit(1);
});
