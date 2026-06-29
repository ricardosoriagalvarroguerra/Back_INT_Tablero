// Runner de ingesta. Orquesta los conectores (desacoplado, migrable a cron/
// APScheduler). Cada job es idempotente y queda registrado en etl_run_log.
//   uso:  npm run ingest   (desde server/)

import { pool, query } from './db.ts';
import { runJob } from './lib/ingest.ts';
import { has } from './env.ts';
import { ingestWorldBank } from './connectors/worldbank.ts';
import { ingestImf } from './connectors/imf.ts';
import { ingestYahoo } from './connectors/yahoo.ts';
import { ingestEcb } from './connectors/ecb.ts';
import { ingestOecd } from './connectors/oecd.ts';
import { ingestComtrade } from './connectors/comtrade.ts';
import { ingestGdelt } from './connectors/gdelt.ts';
import { ingestFred } from './connectors/fred.ts';
import { ingestCalendar } from './connectors/calendar.ts';

async function main() {
  console.log('▶ Ingesta Tablero INT —', new Date().toISOString());

  // Orden: WB primero, IMF después (WEO actualiza celdas macro solapadas).
  await runJob('worldbank', 'wb:macro', ingestWorldBank);
  await runJob('imf', 'imf:weo', ingestImf);
  await runJob('yahoo', 'yahoo:markets', ingestYahoo);
  await runJob('ecb', 'ecb:fx+yields', ingestEcb);
  await runJob('oecd', 'oecd:rates', ingestOecd);
  await runJob('comtrade', 'comtrade:trade', ingestComtrade);
  await runJob('gdelt', 'gdelt:geo', ingestGdelt);

  if (has.fred()) {
    await runJob('fred', 'fred:yields', ingestFred);
    await runJob('fred', 'fred:calendario', ingestCalendar);
  } else {
    console.log('  ⤳ fred:yields + calendario omitidos (sin FRED_API_KEY) — degradan a s/d');
  }

  // Resumen
  const [ts] = await query<{ n: string }>('SELECT count(*) n FROM fact_timeseries');
  const [mk] = await query<{ n: string }>('SELECT count(*) n FROM fact_market');
  const [tr] = await query<{ n: string }>('SELECT count(*) n FROM fact_trade');
  const [ge] = await query<{ n: string }>('SELECT count(*) n FROM fact_geo_events');
  console.log(
    `■ Resumen filas → fact_timeseries=${ts.n} · fact_market=${mk.n} · fact_trade=${tr.n} · fact_geo_events=${ge.n}`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error('Ingesta abortada:', err);
  await pool.end();
  process.exit(1);
});
