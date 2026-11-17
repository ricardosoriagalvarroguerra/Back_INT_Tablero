// Pipeline de ingesta reutilizable: lo usan el CLI (npm run ingest), el
// programador interno del API (al arrancar y cada INGEST_INTERVAL_HOURS) y
// POST /api/ingesta. Cada job es idempotente y queda en etl_run_log.
// Un candado en memoria evita corridas superpuestas dentro del proceso, y un
// advisory lock de PostgreSQL las evita entre réplicas.

import { pool } from './db.ts';
import { invalidarAnalisis } from './analisis.ts';
import { runJob, type JobResult } from './lib/ingest.ts';
import { has } from './env.ts';
import { ingestWorldBank } from './connectors/worldbank.ts';
import { ingestImf } from './connectors/imf.ts';
import { ingestYahoo } from './connectors/yahoo.ts';
import { ingestEcb } from './connectors/ecb.ts';
import { ingestOecd } from './connectors/oecd.ts';
import { ingestBis } from './connectors/bis.ts';
import { ingestComtrade } from './connectors/comtrade.ts';
import { ingestGdelt } from './connectors/gdelt.ts';
import { ingestFred } from './connectors/fred.ts';
import { ingestCalendar } from './connectors/calendar.ts';

interface JobDef {
  fuente: string;
  job: string;
  fn: () => Promise<number>;
  /** Jobs lentos/limitados: no se corren en cada refresco programado. */
  lento?: boolean;
  requiere?: () => boolean;
}

// Orden: WB → IMF (el WEO prevalece en celdas solapadas); FRED (historia larga)
// → Yahoo (pisa los últimos 2 años); OECD → ECB (el BCE prevalece en la zona euro).
export const JOBS: JobDef[] = [
  { fuente: 'worldbank', job: 'wb:macro', fn: ingestWorldBank },
  { fuente: 'imf', job: 'imf:weo', fn: ingestImf },
  { fuente: 'bis', job: 'bis:policy', fn: ingestBis },
  { fuente: 'fred', job: 'fred:mercados', fn: ingestFred },
  { fuente: 'yahoo', job: 'yahoo:markets', fn: ingestYahoo },
  { fuente: 'oecd', job: 'oecd:yields', fn: ingestOecd },
  { fuente: 'ecb', job: 'ecb:fx+yields', fn: ingestEcb },
  { fuente: 'comtrade', job: 'comtrade:trade', fn: ingestComtrade, lento: true },
  { fuente: 'gdelt', job: 'gdelt:geo', fn: ingestGdelt },
  { fuente: 'fred', job: 'fred:calendario', fn: ingestCalendar, requiere: has.fred },
];

let enCurso: Promise<JobResult[]> | null = null;
export const ingestaEnCurso = () => enCurso != null;

export interface OpcionesIngesta {
  disparador: string;
  /** Subconjunto de fuentes (dim_source.codigo) o de jobs; vacío = todas. */
  fuentes?: string[];
  incluirLentos?: boolean;
}

export function runPipeline(op: OpcionesIngesta): Promise<JobResult[]> {
  if (enCurso) return enCurso;
  enCurso = (async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', ['tablero-int-ingesta']);
      if (!rows[0]?.ok) {
        console.log('  ⤳ ingesta omitida: otra instancia ya está ingiriendo');
        return [];
      }
      const out: JobResult[] = [];
      try {
        for (const j of JOBS) {
          const pedido = op.fuentes?.length ? op.fuentes.includes(j.fuente) || op.fuentes.includes(j.job) : true;
          if (!pedido) continue;
          if (j.lento && !op.incluirLentos && !op.fuentes?.length) continue;
          if (j.requiere && !j.requiere()) {
            console.log(`  ⤳ ${j.job} omitido (falta credencial opcional)`);
            continue;
          }
          out.push(await runJob(j.fuente, j.job, j.fn, op.disparador));
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['tablero-int-ingesta']);
      }
      return out;
    } finally {
      client.release();
    }
  })().finally(() => {
    enCurso = null;
    invalidarAnalisis();
  });
  return enCurso;
}
