// OECD Data Explorer (SDMX-JSON, keyless) → llena los huecos clave:
//   IRSTCI (tasa inmediata/política) → fact_timeseries.policy_rate
//   IRLT   (rendimiento bono 10A)    → fact_market (clase 'yield', por país)
// Parser SDMX-JSON 2.0 genérico (claves de serie = índices a las dimensiones).

import { fetchJson, throttle } from '../lib/http.ts';
import {
  countryMaps,
  indicatorId,
  sourceId,
  upsertTimeseries,
  upsertMarket,
  type TsRow,
  type MarketRow,
} from '../lib/ingest.ts';

const BASE = 'https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_KEI@DF_KEI,4.0';

// REF_AREA que OECD KEI cubre para IRSTCI/IRLT (verificado 2026-06-20). Acotar
// a estos evita 500 por códigos inválidos y acorta la URL.
const OECD_AREAS = [
  'AUS', 'BRA', 'CAN', 'CHE', 'CHL', 'CHN', 'COL', 'DEU', 'ESP', 'FRA', 'GBR',
  'IDN', 'IND', 'ISR', 'ITA', 'JPN', 'KOR', 'MEX', 'NLD', 'NOR', 'POL', 'RUS',
  'SWE', 'TUR', 'USA', 'ZAF',
];

interface SdmxJson {
  data: {
    structures: {
      dimensions: {
        series: { id: string; values: { id: string }[] }[];
        observation: { id: string; values: { id: string }[] }[];
      };
    }[];
    dataSets: { series: Record<string, { observations: Record<string, (number | null)[]> }> }[];
  };
}

interface SerieOecd {
  area: string;
  puntos: { periodo: string; valor: number }[];
}

function parse(json: SdmxJson): SerieOecd[] {
  const st = json.data.structures[0].dimensions;
  const posA = st.series.findIndex((d) => d.id === 'REF_AREA');
  const tiempos = st.observation[0]?.values ?? [];
  const out: SerieOecd[] = [];
  for (const [key, s] of Object.entries(json.data.dataSets[0]?.series ?? {})) {
    const idx = key.split(':').map(Number);
    const area = st.series[posA].values[idx[posA]]?.id;
    if (!area) continue;
    const puntos: { periodo: string; valor: number }[] = [];
    for (const [t, arr] of Object.entries(s.observations)) {
      const periodo = tiempos[Number(t)]?.id;
      const v = arr?.[0];
      if (!periodo || v == null) continue;
      puntos.push({ periodo, valor: Number(v) });
    }
    if (puntos.length) out.push({ area, puntos });
  }
  return out;
}

/** Periodo SDMX → fecha ISO. 'YYYY-MM'→fin de mes(01), 'YYYY'→31-dic, 'YYYY-Qn'. */
function periodoAFecha(p: string): string {
  if (/^\d{4}-\d{2}$/.test(p)) return `${p}-01`;
  if (/^\d{4}$/.test(p)) return `${p}-12-31`;
  const q = /^(\d{4})-Q([1-4])$/.exec(p);
  if (q) return `${q[1]}-${String(Number(q[2]) * 3).padStart(2, '0')}-01`;
  return p;
}

// El SDMX de OECD 500ea esporádicamente en consultas grandes. Se trocea por
// lotes pequeños de países; un lote caído sólo pierde esos países (se loguea),
// y re-ejecutar completa idempotentemente.
async function fetchMeasureBatched(areas: string[], measure: string, n: number): Promise<SerieOecd[]> {
  const CHUNK = 8;
  const out: SerieOecd[] = [];
  for (let i = 0; i < areas.length; i += CHUNK) {
    const chunk = areas.slice(i, i + CHUNK).join('+');
    const url = `${BASE}/${chunk}.M.${measure}......?lastNObservations=${n}&format=jsondata`;
    try {
      await throttle('sdmx.oecd.org', 1500); // buen ciudadano: evita auto-429
      out.push(...parse(await fetchJson<SdmxJson>(url, { timeoutMs: 35_000, retries: 3 })));
    } catch (e) {
      console.error(`    oecd ${measure} lote [${chunk}]: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function ingestOecd(): Promise<number> {
  const { byIso3 } = await countryMaps();
  const src = await sourceId('oecd');
  const areas = OECD_AREAS.filter((a) => byIso3.has(a));
  let total = 0;

  // 1) Tasa de política (inmediata/call) → fact_timeseries.policy_rate
  const polId = await indicatorId('policy_rate');
  const tsRows: TsRow[] = [];
  for (const s of await fetchMeasureBatched(areas, 'IRSTCI', 8)) {
    const cid = byIso3.get(s.area);
    if (cid == null) continue;
    for (const p of s.puntos)
      tsRows.push({ countryId: cid, indicatorId: polId, fecha: periodoAFecha(p.periodo), valor: p.valor, sourceId: src });
  }
  total += await upsertTimeseries(tsRows);

  // 2) Rendimiento soberano 10A → fact_market (clase 'yield', por país)
  const mkRows: MarketRow[] = [];
  for (const s of await fetchMeasureBatched(areas, 'IRLT', 6)) {
    const cid = byIso3.get(s.area);
    if (cid == null) continue;
    for (const p of s.puntos)
      mkRows.push({ symbol: `${s.area}_GB10Y`, clase: 'yield', fecha: periodoAFecha(p.periodo), valor: p.valor, countryId: cid, sourceId: src });
  }
  total += await upsertMarket(mkRows);

  if (total === 0) throw new Error('OECD sin datos (IRSTCI/IRLT)');
  return total;
}
