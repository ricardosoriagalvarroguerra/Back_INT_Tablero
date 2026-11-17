// FRED (St. Louis Fed) → fact_market. Keyless vía fredgraph.csv (mismas series
// que la API; FRED_API_KEY ya no es necesaria para esto). Aporta:
//   · curva del Tesoro (3M/2A/10A), tasa real 10A (TIPS) y breakeven 10A
//   · spreads de crédito (HY, IG, corporativos EM) en pb
//   · condiciones financieras (NFCI de Chicago Fed) y dólar amplio (DTWEXBGS)
//   · historia larga 2015→hoy de VIX, petróleo, S&P 500 y FX (base de
//     percentiles); Yahoo pisa los últimos 2 años con su cierre diario.

import { fetchText, throttle } from '../lib/http.ts';
import { countryMaps, sourceId, upsertMarket, type MarketRow } from '../lib/ingest.ts';

interface Def {
  symbol: string;
  clase: MarketRow['clase'];
  fred: string;
  /** factor de escala (p.ej. % → pb). */
  k?: number;
  pais?: string;
}

const SERIES: Def[] = [
  { symbol: 'UST10Y', clase: 'yield', fred: 'DGS10', pais: 'USA' },
  { symbol: 'UST2Y', clase: 'yield', fred: 'DGS2', pais: 'USA' },
  { symbol: 'UST3M', clase: 'yield', fred: 'DGS3MO', pais: 'USA' },
  { symbol: 'UST10Y_REAL', clase: 'yield', fred: 'DFII10', pais: 'USA' },
  { symbol: 'BE10Y', clase: 'yield', fred: 'T10YIE', pais: 'USA' },
  { symbol: 'HY_OAS', clase: 'spread', fred: 'BAMLH0A0HYM2', k: 100 },
  { symbol: 'IG_OAS', clase: 'spread', fred: 'BAMLC0A0CM', k: 100 },
  { symbol: 'EM_OAS', clase: 'spread', fred: 'BAMLEMCBPIOAS', k: 100 },
  { symbol: 'NFCI', clase: 'indice', fred: 'NFCI' },
  { symbol: 'USD_BROAD', clase: 'indice', fred: 'DTWEXBGS' },
  { symbol: 'VIX', clase: 'volatilidad', fred: 'VIXCLS' },
  { symbol: 'WTI', clase: 'commodity', fred: 'DCOILWTICO' },
  { symbol: 'BRENT', clase: 'commodity', fred: 'DCOILBRENTEU' },
  { symbol: 'SP500', clase: 'indice', fred: 'SP500' },
  { symbol: 'USDBRL', clase: 'fx', fred: 'DEXBZUS' },
  { symbol: 'USDMXN', clase: 'fx', fred: 'DEXMXUS' },
  { symbol: 'USDCNY', clase: 'fx', fred: 'DEXCHUS' },
  { symbol: 'USDZAR', clase: 'fx', fred: 'DEXSFUS' },
  { symbol: 'USDJPY', clase: 'fx', fred: 'DEXJPUS' },
  { symbol: 'USDINR', clase: 'fx', fred: 'DEXINUS' },
  { symbol: 'USDKRW', clase: 'fx', fred: 'DEXKOUS' },
];

export async function ingestFred(): Promise<number> {
  const { byIso3 } = await countryMaps();
  const src = await sourceId('fred');
  const rows: MarketRow[] = [];
  let ok = 0;

  for (const s of SERIES) {
    try {
      await throttle('fred.stlouisfed.org', 400);
      const csv = await fetchText(
        `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s.fred}&cosd=2015-01-01`,
        { timeoutMs: 40_000, retries: 2 },
      );
      const lines = csv.trim().split(/\r?\n/).slice(1);
      let n = 0;
      for (const l of lines) {
        const [fecha, raw] = l.split(',');
        const v = Number(raw);
        if (!fecha || raw === '' || raw === '.' || Number.isNaN(v)) continue;
        rows.push({
          symbol: s.symbol,
          clase: s.clase,
          fecha,
          valor: v * (s.k ?? 1),
          countryId: s.pais ? (byIso3.get(s.pais) ?? null) : null,
          sourceId: src,
        });
        n++;
      }
      if (n) ok++;
    } catch (e) {
      console.error(`    fred ${s.fred}: ${(e as Error).message}`);
    }
  }
  console.log(`    fred: ${ok}/${SERIES.length} series`);
  if (ok === 0) throw new Error('FRED sin respuesta');
  return upsertMarket(rows);
}
