// Yahoo Finance (chart) → fact_market. Caballo de batalla keyless para
// commodities, índices, volatilidad (VIX), DXY y pares FX. Serie diaria 1 mes.

import { fetchJson } from '../lib/http.ts';
import { sourceId, upsertMarket, type MarketRow } from '../lib/ingest.ts';

const SYMBOLS: { symbol: string; clase: MarketRow['clase']; yh: string }[] = [
  { symbol: 'WTI', clase: 'commodity', yh: 'CL=F' },
  { symbol: 'BRENT', clase: 'commodity', yh: 'BZ=F' },
  { symbol: 'GOLD', clase: 'commodity', yh: 'GC=F' },
  { symbol: 'COPPER', clase: 'commodity', yh: 'HG=F' },
  { symbol: 'VIX', clase: 'volatilidad', yh: '^VIX' },
  { symbol: 'SP500', clase: 'indice', yh: '^GSPC' },
  { symbol: 'DXY', clase: 'indice', yh: 'DX-Y.NYB' },
  { symbol: 'USDBRL', clase: 'fx', yh: 'BRL=X' },
  { symbol: 'USDMXN', clase: 'fx', yh: 'MXN=X' },
  { symbol: 'USDARS', clase: 'fx', yh: 'ARS=X' },
  { symbol: 'USDCLP', clase: 'fx', yh: 'CLP=X' },
  { symbol: 'USDCOP', clase: 'fx', yh: 'COP=X' },
  { symbol: 'USDTRY', clase: 'fx', yh: 'TRY=X' },
  { symbol: 'USDZAR', clase: 'fx', yh: 'ZAR=X' },
  { symbol: 'USDCNY', clase: 'fx', yh: 'CNY=X' },
];

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
  let okSymbols = 0;

  for (const s of SYMBOLS) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      s.yh,
    )}?interval=1d&range=1mo`;
    try {
      const json = await fetchJson<YahooChart>(url);
      const res = json.chart?.result?.[0];
      const ts = res?.timestamp ?? [];
      const close = res?.indicators?.quote?.[0]?.close ?? [];
      if (!ts.length) continue;
      okSymbols++;
      for (let i = 0; i < ts.length; i++) {
        const v = close[i];
        if (v == null || Number.isNaN(v)) continue;
        rows.push({
          symbol: s.symbol,
          clase: s.clase,
          fecha: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          valor: v,
          sourceId: src,
        });
      }
    } catch {
      // símbolo individual falla → se omite (degradado suave); otros siguen.
    }
  }
  if (okSymbols === 0) throw new Error('Yahoo Finance sin respuesta para ningún símbolo');
  return upsertMarket(rows);
}
