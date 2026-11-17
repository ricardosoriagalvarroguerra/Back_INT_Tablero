// GDELT 2.0 DOC → fact_geo_events. Tono e intensidad (volumen) de cobertura de
// conflicto por país, en una sola llamada (mode=tonechart). Respeta el límite
// estricto de 1 req / 5 s; si la fuente está saturada (429), se marca caída y NO
// se inventan datos.

import { fetchJson, throttle } from '../lib/http.ts';
import { countryMaps, sourceId, upsertGeo, hoyISO, type GeoRow } from '../lib/ingest.ts';

// iso3 → FIPS 10-4 (lo que GDELT espera en sourcecountry:). Sólo países con
// código FIPS confirmado entran al tracker.
const FIPS: Record<string, string> = {
  USA: 'US', ARG: 'AR', BRA: 'BR', VEN: 'VE', COL: 'CO', MEX: 'MX',
  CHL: 'CI', PER: 'PE', BOL: 'BL', CHN: 'CH', RUS: 'RS', TUR: 'TU',
  ZAF: 'SF', ISR: 'IS',
};

interface ToneChart {
  tonechart?: { bin: number; count: number }[];
}

export async function ingestGdelt(): Promise<number> {
  const { all } = await countryMaps();
  const src = await sourceId('gdelt');
  const fecha = hoyISO();
  const targets = all.filter((c) => FIPS[c.iso3]);
  const rows: GeoRow[] = [];
  let ok = 0;
  let rateLimited = 0;

  for (const c of targets) {
    const q = encodeURIComponent(`(protest OR conflict OR crisis OR unrest) sourcecountry:${FIPS[c.iso3]}`);
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=tonechart&timespan=1w&format=json`;
    try {
      // 1 req / 5 s + margen; ante 429 se espera 15 s y se reintenta una vez.
      let json: ToneChart | null = null;
      for (let intento = 0; intento < 2 && !json; intento++) {
        await throttle('api.gdeltproject.org', intento === 0 ? 6000 : 15000);
        try {
          json = await fetchJson<ToneChart>(url, { retries: 0, timeoutMs: 20_000 });
        } catch (e) {
          if (intento === 1 || !/429/.test((e as Error).message)) throw e;
        }
      }
      if (!json) continue;
      const bins = json.tonechart ?? [];
      const total = bins.reduce((s, b) => s + b.count, 0);
      if (total === 0) continue;
      const tono = bins.reduce((s, b) => s + b.bin * b.count, 0) / total;
      rows.push({
        countryId: c.id,
        fecha,
        tipo: 'agregado',
        intensidad: total,
        tono,
        fuente: 'GDELT',
        sourceId: src,
      });
      ok++;
    } catch (err) {
      if (/429/.test((err as Error).message)) rateLimited++;
    }
  }
  console.log(`    gdelt: ${ok}/${targets.length} países · ${rateLimited} rate-limited`);
  if (ok === 0)
    throw new Error(
      rateLimited > 0 ? 'GDELT saturado (429) — throttle/backoff' : 'GDELT sin datos',
    );
  return upsertGeo(rows);
}
