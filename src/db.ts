// Pool de PostgreSQL (pg) + helpers de consulta. Una sola pool compartida por
// el API y los jobs de ingesta.

import pg from 'pg';
import { env } from './env.ts';

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 8 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

/** Una sola fila o null. */
export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function ping(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
