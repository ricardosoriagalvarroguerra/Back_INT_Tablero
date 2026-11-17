// Yahoo Finance (chart) → fact_market. Keyless: commodities, índices, VIX, DXY
// y pares FX, cierre diario de los últimos 2 años. Si Yahoo limita (429) un
// símbolo, queda la historia de FRED para ese símbolo (ver fred.ts).

import { fetchJson, throttle } from '../lib/http.ts';
import { sourceId, upsertMarket, type MarketRow } from '../lib/ingest.ts';

const SYMBOLS: { symbol: string; clase: MarketRow['clase']; yh: string }[] = [
  { symbol: 'WTI', clase: 'commodity', yh: 'CL=F' },
  { symbol: 'BRENT', clase: 'commodity', yh: 'BZ=F' },
  { symbol: 'NATGAS', clase: 'commodity', yh: 'NG=F' },
  { symbol: 'GOLD', clase: 'commodity', yh: 'GC=F' },
  { symbol: 'COPPER', clase: 'commodity', yh: 'HG=F' },
  { symbol: 'SOY', clase: 'commodity', yh: 'ZS=F' },
  { symbol: 'WHEAT', clase: 'commodity', yh: 'ZW=F' },
  { symbol: 'VIX', clase: 'volatilidad', yh: '^VIX' },
  { symbol: 'SP500', clase: 'indice', yh: '^GSPC' },
  { symbol: 'EM_EQ', clase: 'indice', yh: 'EEM' },
  { symbol: 'DXY', clase: 'indice', yh: 'DX-Y.NYB' },
  { symbol: 'USDBRL', clase: 'fx', yh: 'BRL=X' },
  { symbol: 'USDMXN', clase: 'fx', yh: 'MXN=X' },
  { symbol: 'USDARS', clase: 'fx', yh: 'ARS=X' },
  { symbol: 'USDCLP', clase: 'fx', yh: 'CLP=X' },
  { symbol: 'USDCOP', clase: 'fx', yh: 'COP=X' },
  { symbol: 'USDPEN', clase: 'fx', yh: 'PEN=X' },
  { symbol: 'USDTRY', clase: 'fx', yh: 'TRY=X' },
  { symbol: 'USDZAR', clase: 'fx', yh: 'ZAR=X' },
  { symbol: 'USDCNY', clase: 'fx', yh: 'CNY=X' },
  { symbol: 'USDJPY', clase: 'fx', yh: 'JPY=X' },
  { symbol: 'USDINR', clase: 'fx', yh: 'INR=X' },
  { symbol: 'USDKRW', clase: 'fx', yh: 'KRW=X' },
  { symbol: 'USDIDR', clase: 'fx', yh: 'IDR=X' },
  { symbol: 'USDPLN', clase: 'fx', yh: 'PLN=X' },
];

const HOSTS = ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'];

interface YahooChart {
  chart?: {
    result?: {
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
  };
}

export async function ingestYahoo(): Promise<number> {
  const src = await sourceId('yahoo');
  const rows: MarketRow[] = [];
  const fallidos: string[] = [];

  for (const s of SYMBOLS) {
    try {
      // query1 y query2 son espejos; si uno limita (429) se prueba el otro.
      let json: YahooChart | null = null;
      for (const host of HOSTS) {
        try {
          await throttle(host, 350);
          json = await fetchJson<YahooChart>(`https://${host}/v8/finance/chart/${encodeURIComponent(s.yh)}?interval=1d&range=2y`, { retries: 1 });
          break;
        } catch {
          /* siguiente host */
        }
      }
      const res = json?.chart?.result?.[0];
      const ts = res?.timestamp ?? [];
      const close = res?.indicators?.quote?.[0]?.close ?? [];
      if (!ts.length) { fallidos.push(s.symbol); continue; }
      for (let i = 0; i < ts.length; i++) {
        const v = close[i];
        if (v == null || Number.isNaN(v)) continue;
        rows.push({ symbol: s.symbol, clase: s.clase, fecha: new Date(ts[i] * 1000).toISOString().slice(0, 10), valor: v, sourceId: src });
      }
    } catch {
      fallidos.push(s.symbol); // degradado suave: el resto sigue
    }
  }
  if (fallidos.length) console.log(`    yahoo: sin respuesta para ${fallidos.join(', ')}`);
  if (fallidos.length === SYMBOLS.length) throw new Error('Yahoo Finance sin respuesta para ningún símbolo');
  return upsertMarket(rows);
}
