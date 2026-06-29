// IMF DataMapper (WEO) → fact_timeseries. La API ignora el país en la ruta y
// devuelve todos: values[IND][ISO3][año]. Tomamos años recientes + estimaciones
// WEO para nuestro catálogo. IMF complementa/actualiza a World Bank.

import { fetchJson } from '../lib/http.ts';
import {
  countryMaps,
  indicatorId,
  sourceId,
  upsertTimeseries,
  anioAFecha,
  type TsRow,
} from '../lib/ingest.ts';

const MAP: { codigo: string; imf: string }[] = [
  { codigo: 'gdp_growth', imf: 'NGDP_RPCH' },
  { codigo: 'cpi_yoy', imf: 'PCPIPCH' },
  { codigo: 'unemployment', imf: 'LUR' },
  { codigo: 'debt_gdp', imf: 'GGXWDG_NGDP' },
  { codigo: 'fiscal_balance', imf: 'GGXCNL_NGDP' },
  { codigo: 'current_account', imf: 'BCA_NGDPD' },
];

const ANIOS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

interface ImfResp {
  values?: Record<string, Record<string, Record<string, number>>>;
}

export async function ingestImf(): Promise<number> {
  const { byIso3 } = await countryMaps();
  const src = await sourceId('imf');
  const rows: TsRow[] = [];

  for (const m of MAP) {
    const indId = await indicatorId(m.codigo);
    const json = await fetchJson<ImfResp>(
      `https://www.imf.org/external/datamapper/api/v1/${m.imf}`,
    );
    const byCountry = json.values?.[m.imf] ?? {};
    for (const [iso3, serie] of Object.entries(byCountry)) {
      const cid = byIso3.get(iso3);
      if (cid == null) continue;
      for (const anio of ANIOS) {
        const v = serie[String(anio)];
        if (v == null || Number.isNaN(v)) continue;
        rows.push({
          countryId: cid,
          indicatorId: indId,
          fecha: anioAFecha(anio),
          valor: v,
          sourceId: src,
        });
      }
    }
  }
  return upsertTimeseries(rows);
}
