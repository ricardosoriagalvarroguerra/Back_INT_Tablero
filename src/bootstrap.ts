// Auto-aprovisionamiento de la BDR al arrancar (Railway parte de una base vacía).
// Compara el hash de db/schema.sql y db/seed.sql con seed_meta.version:
//   · base vacía o esquema cambiado → aplica schema.sql + seed.sql (el esquema
//     reinicia `public`: los fact_* se recargan con la ingesta que sigue)
//   · sólo cambió el seed           → re-aplica seed.sql (idempotente, sin borrar hechos)
// Todo en una transacción con advisory lock (ROLLBACK si algo falla).
// DB_AUTO_SEED=false lo desactiva.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pool } from './db.ts';
import { resetCaches } from './lib/ingest.ts';

const ROOT = new URL('../db/', import.meta.url);
const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

export interface EstadoSeed {
  version: string | null;
  aplicadoEn: string | null;
  accion: 'ninguna' | 'esquema+seed' | 'seed' | 'desactivado' | 'error';
  error?: string;
}

let ultimo: EstadoSeed = { version: null, aplicadoEn: null, accion: 'ninguna' };
export const estadoSeed = () => ultimo;

export async function ensureDatabase(): Promise<EstadoSeed> {
  if (process.env.DB_AUTO_SEED === 'false') return (ultimo = { version: null, aplicadoEn: null, accion: 'desactivado' });
  const schema = await readFile(new URL('schema.sql', ROOT), 'utf8');
  const seed = await readFile(new URL('seed.sql', ROOT), 'utf8');
  const version = `${h(schema)}.${h(seed)}`;

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['tablero-int-bootstrap']);
    let actual: string | null = null;
    try {
      const r = await client.query<{ version: string }>('SELECT version FROM public.seed_meta LIMIT 1');
      actual = r.rows[0]?.version ?? null;
    } catch {
      actual = null; // base vacía o esquema anterior sin seed_meta
    }
    let accion: EstadoSeed['accion'] = 'ninguna';
    if (actual !== version) {
      const esquemaIgual = actual != null && actual.split('.')[0] === version.split('.')[0];
      await client.query('BEGIN');
      try {
        if (!esquemaIgual) await client.query(schema);
        await client.query(seed);
        await client.query(
          `INSERT INTO seed_meta (id, version, aplicado_en) VALUES (true, $1, now())
           ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, aplicado_en = now()`,
          [version],
        );
        await client.query('COMMIT');
        accion = esquemaIgual ? 'seed' : 'esquema+seed';
        resetCaches();
        console.log(`  ✓ BDR aprovisionada (${accion}) · versión ${version}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    const r = await client.query<{ version: string; aplicado_en: Date }>('SELECT version, aplicado_en FROM seed_meta LIMIT 1');
    ultimo = { version: r.rows[0]?.version ?? null, aplicadoEn: r.rows[0]?.aplicado_en?.toISOString() ?? null, accion };
    return ultimo;
  } catch (e) {
    ultimo = { version: null, aplicadoEn: null, accion: 'error', error: (e as Error).message };
    console.error('  ✗ auto-aprovisionamiento de la BDR:', (e as Error).message);
    return ultimo;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['tablero-int-bootstrap']).catch(() => {});
    client.release();
  }
}
