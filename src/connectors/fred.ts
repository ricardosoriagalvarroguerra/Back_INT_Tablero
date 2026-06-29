// FRED (St. Louis Fed) → fact_market. Requiere FRED_API_KEY. Rendimientos
// soberanos EUA (10A/2A) que alimentan el panel de riesgo soberano. Si no hay
// key, el runner lo omite (degradado explícito, sin inventar datos).

import { fetchJson } from '../lib/http.ts';
import { env } from '../env.ts';
import { countryMaps, sourceId, upsertMarket, type MarketRow } from '../lib/ingest.ts';

const SERIES: { symbol: string; clase: MarketRow['clase']; fred: string }[] = [
  { symbol: 'UST10Y', clase: 'yield', fred: 'DGS10' },
  { symbol: 'UST2Y', clase: 'yield', fred: 'DGS2' },
];

interface FredResp {
  observations?: { date: string; value: string }[];
}

export async function ingestFred(): Promise<number> {
  const { byIso3 } = await countryMaps();
  const usa = byIso3.get('USA') ?? null;
  const src = await sourceId('fred');
  const rows: MarketRow[] = [];

  for (const s of SERIES) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${s.fred}&api_key=${env.fredApiKey}&file_type=json&observation_start=2026-01-01`;
    const json = await fetchJson<FredResp>(url);
    for (const o of json.observations ?? []) {
      const v = o.value === '.' ? null : Number(o.value);
      if (v == null || Number.isNaN(v)) continue;
      rows.push({ symbol: s.symbol, clase: s.clase, fecha: o.date, valor: v, countryId: usa, sourceId: src });
    }
  }
  return upsertMarket(rows);
}
