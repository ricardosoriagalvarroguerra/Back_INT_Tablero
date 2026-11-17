// IMF DataMapper (WEO) → fact_timeseries (países) + fact_aggregate (agregados
// oficiales: mundo, avanzadas, emergentes, LatAm…). La API devuelve todos los
// países de una vez: values[IND][ISO3][año]. Se cargan 2015→último año WEO
// (incluye proyecciones; el API las marca como tales al servirlas).

import { fetchJson } from '../lib/http.ts';
import { query } from '../db.ts';
import {
  countryMaps,
  indicatorId,
  sourceId,
  upsertTimeseries,
  upsertAggregate,
  anioAFecha,
  type TsRow,
  type AggRow,
} from '../lib/ingest.ts';

const MAP: { codigo: string; imf: string; agregados: boolean }[] = [
  { codigo: 'gdp_growth', imf: 'NGDP_RPCH', agregados: true },
  { codigo: 'cpi_yoy', imf: 'PCPIPCH', agregados: true },
  { codigo: 'cpi_eop', imf: 'PCPIEPCH', agregados: true },
  { codigo: 'unemployment', imf: 'LUR', agregados: false },
  { codigo: 'debt_gdp', imf: 'GGXWDG_NGDP', agregados: true },
  { codigo: 'fiscal_balance', imf: 'GGXCNL_NGDP', agregados: true },
  { codigo: 'current_account', imf: 'BCA_NGDPD', agregados: true },
  { codigo: 'gdp_usd', imf: 'NGDPD', agregados: true },
  { codigo: 'gdp_ppp_share', imf: 'PPPSH', agregados: true },
];

const DESDE = 2015;
const HASTA = new Date().getUTCFullYear() + 5; // horizonte WEO

interface ImfResp {
  values?: Record<string, Record<string, Record<string, number>>>;
}

export async function ingestImf(): Promise<number> {
  const { byIso3 } = await countryMaps();
  const src = await sourceId('imf');
  const aggs = new Set((await query<{ codigo: string }>('SELECT codigo FROM dim_aggregate')).map((r) => r.codigo));
  const rows: TsRow[] = [];
  const aggRows: AggRow[] = [];
  let fallidos = 0;

  for (const m of MAP) {
    const indId = await indicatorId(m.codigo);
    let json: ImfResp;
    try {
      json = await fetchJson<ImfResp>(`https://www.imf.org/external/datamapper/api/v1/${m.imf}`, { timeoutMs: 40_000 });
    } catch (e) {
      fallidos++;
      console.error(`    imf ${m.imf}: ${(e as Error).message}`);
      continue;
    }
    const byCode = json.values?.[m.imf] ?? {};
    for (const [code, serie] of Object.entries(byCode)) {
      const cid = byIso3.get(code);
      const esAgg = m.agregados && aggs.has(code);
      if (cid == null && !esAgg) continue;
      for (let anio = DESDE; anio <= HASTA; anio++) {
        const v = serie[String(anio)];
        if (v == null || Number.isNaN(Number(v))) continue;
        if (cid != null) rows.push({ countryId: cid, indicatorId: indId, fecha: anioAFecha(anio), valor: Number(v), sourceId: src });
        else aggRows.push({ agregado: code, indicatorId: indId, anio, valor: Number(v), sourceId: src });
      }
    }
  }
  if (fallidos === MAP.length) throw new Error('IMF DataMapper sin respuesta');
  return (await upsertTimeseries(rows)) + (await upsertAggregate(aggRows));
}
