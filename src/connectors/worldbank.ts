// World Bank Open Data → fact_timeseries (macro anual). Multi-país via
// country/all; se filtra a nuestro catálogo. Clave natural (país, indicador, año).

import { fetchJson } from '../lib/http.ts';
import {
  countryMaps,
  indicatorId,
  sourceId,
  upsertTimeseries,
  anioAFecha,
  type TsRow,
} from '../lib/ingest.ts';

const MAP: { codigo: string; wb: string }[] = [
  { codigo: 'gdp_growth', wb: 'NY.GDP.MKTP.KD.ZG' },
  { codigo: 'cpi_yoy', wb: 'FP.CPI.TOTL.ZG' },
  { codigo: 'unemployment', wb: 'SL.UEM.TOTL.ZS' },
  { codigo: 'debt_gdp', wb: 'GC.DOD.TOTL.GD.ZS' },
  { codigo: 'fiscal_balance', wb: 'GC.NLD.TOTL.GD.ZS' },
  { codigo: 'current_account', wb: 'BN.CAB.XOKA.GD.ZS' },
];

interface WbRow {
  countryiso3code: string;
  date: string;
  value: number | null;
}

export async function ingestWorldBank(): Promise<number> {
  const { byIso3 } = await countryMaps();
  const src = await sourceId('worldbank');
  const rows: TsRow[] = [];

  for (const m of MAP) {
    const indId = await indicatorId(m.codigo);
    const url = `https://api.worldbank.org/v2/country/all/indicator/${m.wb}?format=json&mrv=6&per_page=20000`;
    const json = await fetchJson<[unknown, WbRow[] | null]>(url);
    const data = json[1] ?? [];
    for (const r of data) {
      const cid = byIso3.get(r.countryiso3code);
      if (cid == null || r.value == null) continue;
      rows.push({
        countryId: cid,
        indicatorId: indId,
        fecha: anioAFecha(r.date),
        valor: r.value,
        sourceId: src,
      });
    }
  }
  return upsertTimeseries(rows);
}
