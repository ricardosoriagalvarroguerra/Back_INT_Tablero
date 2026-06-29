// ECB Data Portal (SDMX-JSON, keyless, muy estable) → fact_market.
//   EXR  → EUR/USD de referencia (clase 'fx')
//   IRS  → rendimiento soberano 10A de la zona euro (clase 'yield', por país)
// Cubre fiablemente los yields del área euro (Bund como benchmark de spreads),
// complementando a OECD (que es inestable) para el resto.

import { fetchJson } from '../lib/http.ts';
import { countryMaps, sourceId, upsertMarket, type MarketRow } from '../lib/ingest.ts';

interface SdmxJson {
  dataSets?: { series?: Record<string, { observations?: Record<string, (number | null)[]> }> }[];
  structure?: { dimensions?: { observation?: { id: string; values: { id: string }[] }[] } };
}

/** Extrae [{fecha,valor}] de una respuesta SDMX-JSON de una sola serie. */
function parseObs(json: SdmxJson): { fecha: string; valor: number }[] {
  const obsDim = json.structure?.dimensions?.observation?.find((d) => d.id === 'TIME_PERIOD');
  const fechas = (obsDim?.values ?? []).map((v) => v.id);
  const series = json.dataSets?.[0]?.series ?? {};
  const first = Object.keys(series)[0];
  const obs = first ? (series[first].observations ?? {}) : {};
  const out: { fecha: string; valor: number }[] = [];
  for (const [idx, arr] of Object.entries(obs)) {
    let fecha = fechas[Number(idx)];
    const valor = arr?.[0];
    if (!fecha || valor == null) continue;
    if (/^\d{4}-\d{2}$/.test(fecha)) fecha = `${fecha}-01`; // mensual → fin de mes(01)
    out.push({ fecha, valor: Number(valor) });
  }
  return out;
}

// Zona euro de nuestro catálogo: rendimiento de convergencia 10A (clave IRS).
const EURO_YIELDS: { iso3: string; cc: string }[] = [
  { iso3: 'DEU', cc: 'DE' },
  { iso3: 'FRA', cc: 'FR' },
  { iso3: 'ITA', cc: 'IT' },
  { iso3: 'ESP', cc: 'ES' },
  { iso3: 'NLD', cc: 'NL' },
];

export async function ingestEcb(): Promise<number> {
  const { byIso3 } = await countryMaps();
  const src = await sourceId('ecb');
  const rows: MarketRow[] = [];

  // 1) EUR/USD de referencia
  const fx = await fetchJson<SdmxJson>(
    'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?format=jsondata&lastNObservations=60',
  );
  for (const o of parseObs(fx)) rows.push({ symbol: 'EURUSD', clase: 'fx', fecha: o.fecha, valor: o.valor, sourceId: src });

  // 2) Rendimientos soberanos 10A de la zona euro
  for (const y of EURO_YIELDS) {
    const cid = byIso3.get(y.iso3);
    if (cid == null) continue;
    try {
      const j = await fetchJson<SdmxJson>(
        `https://data-api.ecb.europa.eu/service/data/IRS/M.${y.cc}.L.L40.CI.0000.EUR.N.Z?format=jsondata&lastNObservations=12`,
        { retries: 2 },
      );
      for (const o of parseObs(j))
        rows.push({ symbol: `${y.iso3}_GB10Y`, clase: 'yield', fecha: o.fecha, valor: o.valor, countryId: cid, sourceId: src });
    } catch {
      // un país falla → se omite; el resto sigue.
    }
  }

  if (!rows.length) throw new Error('ECB sin observaciones (EXR/IRS)');
  return upsertMarket(rows);
}
