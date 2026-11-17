// BIS · Central bank policy rates (WS_CBPOL) → fact_timeseries.policy_rate.
// Fuente autorizada de tasas de política: ~40 bancos centrales, mensual (fin de
// período) desde 2015. SDMX REST v2 en CSV, keyless. La zona euro (XM) se
// asigna a los miembros del catálogo (una sola tasa del BCE).

import { fetchText } from '../lib/http.ts';
import { countryMaps, indicatorId, sourceId, upsertTimeseries, type TsRow } from '../lib/ingest.ts';
import { query } from '../db.ts';

const EURO = ['DEU', 'FRA', 'ITA', 'ESP', 'NLD'];

/** Parser CSV mínimo con soporte de comillas (los títulos BIS traen comas). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') out.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row); }
  return out;
}

export async function ingestBis(): Promise<number> {
  const { byIso3 } = await countryMaps();
  const iso2to3 = new Map(
    (await query<{ iso2: string; iso3: string }>('SELECT iso2, iso3 FROM dim_country')).map((r) => [r.iso2.trim(), r.iso3]),
  );
  const src = await sourceId('bis');
  const ind = await indicatorId('policy_rate');

  const csv = await fetchText(
    'https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/M.?startPeriod=2015-01&format=csv',
    { timeoutMs: 60_000, retries: 3 },
  );
  const [head, ...data] = parseCsv(csv);
  const iArea = head.indexOf('REF_AREA');
  const iT = head.indexOf('TIME_PERIOD');
  const iV = head.indexOf('OBS_VALUE');
  if (iArea < 0 || iT < 0 || iV < 0) throw new Error('BIS: formato CSV inesperado');

  const rows: TsRow[] = [];
  for (const r of data) {
    const v = Number(r[iV]);
    if (r[iV] === '' || Number.isNaN(v)) continue;
    const fecha = `${r[iT]}-01`;
    const area = r[iArea];
    const destinos = area === 'XM' ? EURO : iso2to3.has(area) ? [iso2to3.get(area)!] : [];
    for (const iso3 of destinos) {
      const cid = byIso3.get(iso3);
      if (cid != null) rows.push({ countryId: cid, indicatorId: ind, fecha, valor: v, sourceId: src });
    }
  }
  if (!rows.length) throw new Error('BIS sin observaciones');
  return upsertTimeseries(rows);
}
