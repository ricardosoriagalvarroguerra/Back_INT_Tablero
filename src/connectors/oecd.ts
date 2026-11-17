// OECD Data Explorer (SDMX, keyless) → rendimiento soberano 10A (IRLT) por país
// → fact_market (clase 'yield', símbolo {ISO3}_GB10Y), mensual desde 2015.
// La tasa de política ya no sale de aquí (IRSTCI es la tasa interbancaria, no la
// de política): la provee el BIS (bis.ts), fuente autorizada.
// Formato CSV: el JSON de SDMX 500ea en consultas multi-país; el CSV es estable.

import { fetchText, throttle } from '../lib/http.ts';
import { parseCsv } from './bis.ts';
import { countryMaps, sourceId, upsertMarket, type MarketRow } from '../lib/ingest.ts';

const BASE = 'https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_KEI@DF_KEI,4.0';

// REF_AREA con IRLT en KEI (fuera de la zona euro, que cubre el BCE).
const OECD_AREAS = [
  'AUS', 'BRA', 'CAN', 'CHE', 'CHL', 'CHN', 'COL', 'GBR', 'IDN', 'IND', 'ISR',
  'JPN', 'KOR', 'MEX', 'NOR', 'POL', 'RUS', 'SWE', 'TUR', 'USA', 'ZAF',
];

export async function ingestOecd(): Promise<number> {
  const { byIso3 } = await countryMaps();
  const src = await sourceId('oecd');
  const areas = OECD_AREAS.filter((a) => byIso3.has(a));
  const rows: MarketRow[] = [];
  // Un país por consulta: un lote con un país sin datos (p.ej. TUR → 404) hace
  // que el SDMX de OCDE responda 500 para todo el lote.
  const CHUNK = 1;

  for (let i = 0; i < areas.length; i += CHUNK) {
    const chunk = areas.slice(i, i + CHUNK).join('+');
    const url = `${BASE}/${chunk}.M.IRLT......?startPeriod=2015-01&format=csvfile`;
    try {
      // El SDMX de OCDE devuelve 500 intermitentes: hasta 3 rondas con pausa creciente.
      let txt = '';
      for (let intento = 0; intento < 3 && !txt; intento++) {
        await throttle('sdmx.oecd.org', 1500 + intento * 5000); // buen ciudadano: evita auto-429
        try {
          txt = await fetchText(url, { timeoutMs: 45_000, retries: 1 });
        } catch (e) {
          if (intento === 2 || /^404 /.test((e as Error).message)) throw e;
        }
      }
      const [head, ...data] = parseCsv(txt);
      const iA = head.indexOf('REF_AREA'), iT = head.indexOf('TIME_PERIOD'), iV = head.indexOf('OBS_VALUE');
      for (const r of data) {
        const v = Number(r[iV]);
        const cid = byIso3.get(r[iA]);
        if (cid == null || r[iV] === '' || Number.isNaN(v) || !/^\d{4}-\d{2}$/.test(r[iT])) continue;
        rows.push({ symbol: `${r[iA]}_GB10Y`, clase: 'yield', fecha: `${r[iT]}-01`, valor: v, countryId: cid, sourceId: src });
      }
    } catch (e) {
      console.error(`    oecd IRLT lote [${chunk}]: ${(e as Error).message}`);
    }
  }
  if (!rows.length) throw new Error('OECD sin datos (IRLT)');
  return upsertMarket(rows);
}
