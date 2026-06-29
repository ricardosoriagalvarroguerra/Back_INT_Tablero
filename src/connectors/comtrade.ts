// UN Comtrade (preview, keyless) → fact_trade. Por reporter: total exportado e
// importado (partner=mundo) + principales socios de exportación. Códigos M49;
// campo de valor = primaryValue. Throttle suave para respetar el preview.

import { fetchJson, throttle } from '../lib/http.ts';
import { countryMaps, sourceId, upsertTrade, type TradeRow } from '../lib/ingest.ts';

const PERIODO = '2022'; // último año verificado con buena cobertura en preview
const FOCUS = new Set([
  'USA','CHN','DEU','JPN','GBR','FRA','ITA','CAN','ESP','KOR','IND','AUS',
  'BRA','MEX','ARG','CHL','COL','PER','ZAF','TUR',
]);
const TOP_SOCIOS = 8;

interface CtRow {
  partnerCode: number;
  primaryValue: number | null;
}
interface CtResp {
  data?: CtRow[];
}

async function fetchFlow(m49: number, flujo: 'X' | 'M', partnerCode?: number): Promise<CtRow[]> {
  await throttle('comtradeapi.un.org', 400);
  const pc = partnerCode == null ? '' : `&partnerCode=${partnerCode}`;
  const url = `https://comtradeapi.un.org/public/v1/preview/C/A/HS?reporterCode=${m49}&period=${PERIODO}&flowCode=${flujo}&cmdCode=TOTAL${pc}`;
  const json = await fetchJson<CtResp>(url, { retries: 1 });
  return json.data ?? [];
}

export async function ingestComtrade(): Promise<number> {
  const { all } = await countryMaps();
  const src = await sourceId('comtrade');
  const reporters = all.filter((c) => c.m49 != null && FOCUS.has(c.iso3));
  const rows: TradeRow[] = [];
  let cubiertos = 0;

  // El preview devuelve varias filas por socio (sub-desgloses); colapsamos a un
  // valor por partnerCode (el máximo = nivel agregado) para no duplicar la clave.
  const colapsar = (xs: CtRow[]): Map<number, number> => {
    const m = new Map<number, number>();
    for (const d of xs) {
      if (d.primaryValue == null) continue;
      const prev = m.get(d.partnerCode);
      if (prev == null || d.primaryValue > prev) m.set(d.partnerCode, d.primaryValue);
    }
    return m;
  };

  for (const r of reporters) {
    try {
      // Exportaciones: todos los socios (incluye mundo=0).
      const xMap = colapsar(await fetchFlow(r.m49!, 'X'));
      if (xMap.size === 0) continue;
      cubiertos++;
      const mundoX = xMap.get(0);
      if (mundoX != null) {
        rows.push({ reporterId: r.id, partnerM49: 0, partnerNombre: null, periodo: PERIODO, flujo: 'X', valorUsd: mundoX, sourceId: src });
      }
      const socios = [...xMap.entries()]
        .filter(([pc]) => pc !== 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_SOCIOS);
      for (const [pc, val] of socios) {
        rows.push({ reporterId: r.id, partnerM49: pc, partnerNombre: null, periodo: PERIODO, flujo: 'X', valorUsd: val, sourceId: src });
      }
      // Importaciones: total mundo.
      const mMap = colapsar(await fetchFlow(r.m49!, 'M', 0));
      const mundoM = mMap.get(0) ?? [...mMap.values()][0];
      if (mundoM != null) {
        rows.push({ reporterId: r.id, partnerM49: 0, partnerNombre: null, periodo: PERIODO, flujo: 'M', valorUsd: mundoM, sourceId: src });
      }
    } catch {
      // reporter individual falla → se omite; el resto continúa.
    }
  }
  console.log(`    comtrade: ${cubiertos}/${reporters.length} reporters cubiertos (periodo ${PERIODO})`);
  if (cubiertos === 0) throw new Error('UN Comtrade sin datos para ningún reporter');
  return upsertTrade(rows);
}
