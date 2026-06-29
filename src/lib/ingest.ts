// Helpers de ingesta: catálogos (dim_*) cacheados, upserts idempotentes por
// clave natural (vía unnest, sin explotar parámetros) y runJob() que envuelve
// cada conector con etl_run_log + actualiza el estado/latencia de la fuente.

import { query, one } from '../db.ts';

export interface CountryRow {
  id: number;
  iso3: string;
  iso2: string;
  m49: number | null;
}

let _countries: CountryRow[] | null = null;
const _indicatorIds = new Map<string, number>();
const _sourceIds = new Map<string, number>();

export async function countries(): Promise<CountryRow[]> {
  if (!_countries) {
    _countries = await query<CountryRow>('SELECT id, iso3, iso2, m49 FROM dim_country');
  }
  return _countries;
}

export async function countryMaps() {
  const all = await countries();
  const byIso3 = new Map<string, number>();
  const byM49 = new Map<number, number>();
  for (const c of all) {
    byIso3.set(c.iso3, c.id);
    if (c.m49 != null) byM49.set(c.m49, c.id);
  }
  return { byIso3, byM49, all };
}

export async function indicatorId(codigo: string): Promise<number> {
  if (_indicatorIds.has(codigo)) return _indicatorIds.get(codigo)!;
  const row = await one<{ id: number }>('SELECT id FROM dim_indicator WHERE codigo = $1', [codigo]);
  if (!row) throw new Error(`dim_indicator desconocido: ${codigo}`);
  _indicatorIds.set(codigo, row.id);
  return row.id;
}

export async function sourceId(codigo: string): Promise<number> {
  if (_sourceIds.has(codigo)) return _sourceIds.get(codigo)!;
  const row = await one<{ id: number }>('SELECT id FROM dim_source WHERE codigo = $1', [codigo]);
  if (!row) throw new Error(`dim_source desconocido: ${codigo}`);
  _sourceIds.set(codigo, row.id);
  return row.id;
}

// ── Upserts idempotentes ────────────────────────────────────────────────
export interface TsRow {
  countryId: number;
  indicatorId: number;
  fecha: string; // YYYY-MM-DD
  valor: number | null;
  sourceId: number;
}

export async function upsertTimeseries(rows: TsRow[]): Promise<number> {
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    await query(
      `INSERT INTO fact_timeseries (country_id, indicator_id, fecha, valor, source_id)
       SELECT * FROM unnest($1::int[], $2::int[], $3::date[], $4::numeric[], $5::int[])
       ON CONFLICT (country_id, indicator_id, fecha)
       DO UPDATE SET valor = EXCLUDED.valor, source_id = EXCLUDED.source_id, ingested_at = now()`,
      [
        chunk.map((r) => r.countryId),
        chunk.map((r) => r.indicatorId),
        chunk.map((r) => r.fecha),
        chunk.map((r) => r.valor),
        chunk.map((r) => r.sourceId),
      ],
    );
  }
  return rows.length;
}

export interface MarketRow {
  symbol: string;
  clase: string;
  fecha: string;
  valor: number | null;
  countryId?: number | null;
  sourceId: number;
}

export async function upsertMarket(rows: MarketRow[]): Promise<number> {
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    await query(
      `INSERT INTO fact_market (symbol, clase, fecha, valor, country_id, source_id)
       SELECT * FROM unnest($1::text[], $2::clase_mercado[], $3::date[], $4::numeric[], $5::int[], $6::int[])
       ON CONFLICT (symbol, fecha)
       DO UPDATE SET valor = EXCLUDED.valor, source_id = EXCLUDED.source_id, ingested_at = now()`,
      [
        chunk.map((r) => r.symbol),
        chunk.map((r) => r.clase),
        chunk.map((r) => r.fecha),
        chunk.map((r) => r.valor),
        chunk.map((r) => r.countryId ?? null),
        chunk.map((r) => r.sourceId),
      ],
    );
  }
  return rows.length;
}

export interface TradeRow {
  reporterId: number;
  partnerM49: number;
  partnerNombre: string | null;
  periodo: string;
  flujo: 'X' | 'M';
  valorUsd: number | null;
  sourceId: number;
}

export async function upsertTrade(rows: TradeRow[]): Promise<number> {
  if (!rows.length) return 0;
  await query(
    `INSERT INTO fact_trade (reporter_id, partner_m49, partner_nombre, periodo, flujo, valor_usd, source_id)
     SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::flujo_comercio[], $6::numeric[], $7::int[])
     ON CONFLICT (reporter_id, partner_m49, periodo, flujo)
     DO UPDATE SET partner_nombre = EXCLUDED.partner_nombre, valor_usd = EXCLUDED.valor_usd,
                   source_id = EXCLUDED.source_id, ingested_at = now()`,
    [
      rows.map((r) => r.reporterId),
      rows.map((r) => r.partnerM49),
      rows.map((r) => r.partnerNombre),
      rows.map((r) => r.periodo),
      rows.map((r) => r.flujo),
      rows.map((r) => r.valorUsd),
      rows.map((r) => r.sourceId),
    ],
  );
  return rows.length;
}

export interface GeoRow {
  countryId: number;
  fecha: string;
  tipo: string;
  intensidad: number | null;
  tono: number | null;
  fuente: string;
  sourceId: number;
}

export async function upsertGeo(rows: GeoRow[]): Promise<number> {
  if (!rows.length) return 0;
  await query(
    `INSERT INTO fact_geo_events (country_id, fecha, tipo, intensidad, tono, fuente, source_id)
     SELECT * FROM unnest($1::int[], $2::date[], $3::text[], $4::numeric[], $5::numeric[], $6::text[], $7::int[])
     ON CONFLICT (country_id, fecha, tipo, fuente)
     DO UPDATE SET intensidad = EXCLUDED.intensidad, tono = EXCLUDED.tono,
                   source_id = EXCLUDED.source_id, ingested_at = now()`,
    [
      rows.map((r) => r.countryId),
      rows.map((r) => r.fecha),
      rows.map((r) => r.tipo),
      rows.map((r) => r.intensidad),
      rows.map((r) => r.tono),
      rows.map((r) => r.fuente),
      rows.map((r) => r.sourceId),
    ],
  );
  return rows.length;
}

// ── Orquestación con observabilidad ─────────────────────────────────────
/** Envuelve un job: registra en etl_run_log y actualiza dim_source. */
export async function runJob(
  sourceCodigo: string,
  job: string,
  fn: () => Promise<number>,
): Promise<void> {
  const t0 = Date.now();
  const [{ id: runId }] = await query<{ id: number }>(
    'INSERT INTO etl_run_log (job, estado) VALUES ($1, $2) RETURNING id',
    [job, 'ok'],
  );
  try {
    const filas = await fn();
    const ms = Date.now() - t0;
    await query('UPDATE etl_run_log SET fin = now(), filas = $1, estado = $2 WHERE id = $3', [
      filas,
      'ok',
      runId,
    ]);
    await query(
      `UPDATE dim_source SET estado = 'ok', latencia_ms = $1, ultima_verificacion = now() WHERE codigo = $2`,
      [ms, sourceCodigo],
    );
    console.log(`  ✓ ${job}: ${filas} filas · ${ms} ms`);
  } catch (err) {
    const msg = (err as Error).message;
    await query('UPDATE etl_run_log SET fin = now(), estado = $1, error = $2 WHERE id = $3', [
      'error',
      msg,
      runId,
    ]);
    await query(`UPDATE dim_source SET estado = 'down' WHERE codigo = $1`, [sourceCodigo]);
    console.error(`  ✗ ${job}: ${msg}`);
  }
}

/** Día ISO de hoy (UTC) para fechar series diarias agregadas. */
export function hoyISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Año → fecha de cierre anual (31-dic). */
export function anioAFecha(anio: number | string): string {
  return `${anio}-12-31`;
}
