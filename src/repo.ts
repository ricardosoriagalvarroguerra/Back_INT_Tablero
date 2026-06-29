// Capa de acceso a datos: consultas sobre las vistas/tablas, ya con la forma
// que consumen los componentes del frontend. pg devuelve numeric como string →
// se fuerza Number(). Provenance (fuente+asof+estado) en cada payload.

import { query, one } from './db.ts';
import { fetchText } from './lib/http.ts';

const n = (x: unknown): number | null => (x == null ? null : Number(x));

// ── Catálogo ─────────────────────────────────────────────────────────────
export async function paises() {
  const rows = await query(
    `SELECT iso3, iso2, m49, nombre_es, nombre_en, region, grupos FROM dim_country ORDER BY nombre_es`,
  );
  return rows.map((r) => ({
    iso3: r.iso3,
    iso2: r.iso2,
    m49: Number(r.m49),
    nombreEs: r.nombre_es,
    nombreEn: r.nombre_en,
    region: r.region,
    grupos: r.grupos,
  }));
}

export async function fuentes() {
  const rows = await query(`SELECT * FROM v_source_health`);
  return rows.map((r) => ({
    id: r.codigo,
    nombre: r.proveedor,
    url: r.url,
    estado: r.estado,
    latenciaMs: n(r.latencia_ms),
    ultimaVerificacion: r.ultima_verificacion ? new Date(r.ultima_verificacion).toISOString() : null,
    licencia: r.licencia ?? '',
  }));
}

// ── Heatmap macro (países × indicadores, z-score) ─────────────────────────
const HEAT_INDS = ['gdp_growth', 'cpi_yoy', 'unemployment', 'policy_rate', 'debt_gdp', 'fiscal_balance', 'current_account'];

export async function heatmap() {
  const indicadores = (
    await query(
      `SELECT codigo, nombre_es, nombre_en, unidad, frecuencia, fuente, polaridad, descripcion
       FROM dim_indicator WHERE codigo = ANY($1) ORDER BY array_position($1, codigo)`,
      [HEAT_INDS],
    )
  ).map((r) => ({
    codigo: r.codigo,
    nombreEs: r.nombre_es,
    nombreEn: r.nombre_en,
    unidad: r.unidad,
    frecuencia: r.frecuencia,
    fuente: r.fuente,
    polaridad: r.polaridad,
    descripcion: r.descripcion ?? '',
  }));

  const celdas = (
    await query(
      `SELECT iso3, indicador, valor::float8 AS valor, z::float8 AS z, asof
       FROM v_heatmap_macro WHERE indicador = ANY($1)`,
      [HEAT_INDS],
    )
  ).map((r) => ({
    iso3: r.iso3,
    indicador: r.indicador,
    valor: n(r.valor),
    z: n(r.z),
    asof: r.asof ? new Date(r.asof).toISOString().slice(0, 10) : null,
  }));

  const ps = await paises();
  const maxAsof = celdas.reduce<string | null>((m, c) => (c.asof && (!m || c.asof > m) ? c.asof : m), null);
  return {
    indicadores,
    paises: ps,
    celdas,
    prov: { fuente: 'World Bank / IMF', asof: maxAsof, estado: 'ok' as const },
  };
}

// ── Inflación y tasas reales ──────────────────────────────────────────────
export async function tasasReales() {
  const rows = await query(`SELECT * FROM v_real_rate ORDER BY tasa_real ASC NULLS LAST`);
  return rows.map((r) => ({
    iso3: r.iso3,
    pais: r.pais,
    inflacion: n(r.inflacion),
    tasaPolitica: n(r.tasa_politica),
    tasaReal: n(r.tasa_real),
    prov: { fuente: 'World Bank / IMF / ECB', asof: r.asof ? new Date(r.asof).toISOString().slice(0, 10) : null, estado: 'ok' as const },
  }));
}

// ── FX & commodities ──────────────────────────────────────────────────────
interface MktPunto { fecha: string; valor: number }

async function marketSeries(): Promise<Map<string, { clase: string; pts: MktPunto[] }>> {
  const rows = await query(
    `SELECT symbol, clase, fecha, valor::float8 AS valor FROM fact_market
     WHERE clase IN ('fx','commodity','indice','volatilidad') ORDER BY symbol, fecha`,
  );
  const map = new Map<string, { clase: string; pts: MktPunto[] }>();
  for (const r of rows) {
    if (!map.has(r.symbol)) map.set(r.symbol, { clase: r.clase, pts: [] });
    map.get(r.symbol)!.pts.push({ fecha: r.fecha.toISOString?.().slice(0, 10) ?? String(r.fecha), valor: Number(r.valor) });
  }
  return map;
}

const NOMBRES: Record<string, string> = {
  WTI: 'Petróleo WTI', BRENT: 'Petróleo Brent', GOLD: 'Oro', COPPER: 'Cobre',
  VIX: 'VIX (volatilidad)', SP500: 'S&P 500', DXY: 'Índice dólar (DXY)', EURUSD: 'EUR/USD',
  USDBRL: 'USD/BRL', USDMXN: 'USD/MXN', USDARS: 'USD/ARS', USDCLP: 'USD/CLP',
  USDCOP: 'USD/COP', USDTRY: 'USD/TRY', USDZAR: 'USD/ZAR', USDCNY: 'USD/CNY',
};

function pearson(a: number[], b: number[]): number | null {
  const m = Math.min(a.length, b.length);
  if (m < 4) return null;
  const xs = a.slice(-m), ys = b.slice(-m);
  const mx = xs.reduce((s, v) => s + v, 0) / m, my = ys.reduce((s, v) => s + v, 0) / m;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < m; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const den = Math.sqrt(sxx * syy);
  return den === 0 ? null : sxy / den;
}

const retornos = (pts: MktPunto[]): number[] => {
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) out.push(pts[i].valor / pts[i - 1].valor - 1);
  return out;
};

export async function fxCommodities() {
  const map = await marketSeries();
  const series = [...map.entries()].map(([symbol, { clase, pts }]) => {
    const last = pts[pts.length - 1]?.valor ?? null;
    const prev = pts[pts.length - 2]?.valor ?? null;
    return {
      id: symbol,
      nombre: NOMBRES[symbol] ?? symbol,
      clase,
      valor: last,
      varDiaria: last != null && prev != null && prev !== 0 ? (last / prev - 1) * 100 : null,
      spark: pts.slice(-30).map((p) => p.valor),
      prov: { fuente: symbol === 'EURUSD' ? 'ECB' : 'Yahoo Finance', asof: pts[pts.length - 1]?.fecha ?? null, estado: 'ok' as const },
    };
  });

  // Correlaciones sobre retornos diarios del set principal.
  const CORR = ['WTI', 'BRENT', 'GOLD', 'COPPER', 'VIX', 'DXY', 'SP500', 'USDBRL'];
  const rets = new Map(CORR.filter((s) => map.has(s)).map((s) => [s, retornos(map.get(s)!.pts)]));
  const correlaciones: { a: string; b: string; rho: number | null }[] = [];
  const keys = [...rets.keys()];
  for (let i = 0; i < keys.length; i++)
    for (let j = i; j < keys.length; j++)
      correlaciones.push({ a: keys[i], b: keys[j], rho: i === j ? 1 : pearson(rets.get(keys[i])!, rets.get(keys[j])!) });

  // Régimen risk-on/off por VIX + dirección DXY.
  const vix = map.get('VIX')?.pts ?? [];
  const vixLast = vix[vix.length - 1]?.valor ?? null;
  let regimen: 'risk-on' | 'risk-off' | 'neutral' = 'neutral';
  if (vixLast != null) regimen = vixLast >= 22 ? 'risk-off' : vixLast <= 15 ? 'risk-on' : 'neutral';

  const maxAsof = series.reduce<string | null>((m, s) => (s.prov.asof && (!m || s.prov.asof > m) ? s.prov.asof : m), null);
  return { series, correlaciones, regimen, prov: { fuente: 'Yahoo / ECB', asof: maxAsof, estado: 'ok' as const } };
}

// ── Comercio y flujos ─────────────────────────────────────────────────────
export async function comercio() {
  const totales = await query(
    `SELECT t.reporter_id, c.iso3, c.nombre_es AS pais, t.flujo, t.valor_usd::float8 AS valor, t.periodo
     FROM fact_trade t JOIN dim_country c ON c.id = t.reporter_id WHERE t.partner_m49 = 0`,
  );
  const socios = await query(
    `SELECT t.reporter_id, t.partner_m49, t.valor_usd::float8 AS valor,
            p.nombre_es AS partner_nombre, p.iso3 AS partner_iso3
     FROM fact_trade t LEFT JOIN dim_country p ON p.m49 = t.partner_m49
     WHERE t.partner_m49 <> 0 AND t.flujo = 'X' ORDER BY t.reporter_id, t.valor_usd DESC`,
  );
  const ca = await query(
    `SELECT iso3, valor::float8 AS valor FROM v_indicator_latest WHERE codigo = 'current_account'`,
  );
  const caByIso = new Map(ca.map((r) => [r.iso3, Number(r.valor)]));

  const byReporter = new Map<number, any>();
  for (const t of totales) {
    if (!byReporter.has(t.reporter_id))
      byReporter.set(t.reporter_id, { iso3: t.iso3, pais: t.pais, periodo: t.periodo, exportTotal: null, importTotal: null });
    const row = byReporter.get(t.reporter_id);
    if (t.flujo === 'X') row.exportTotal = Number(t.valor);
    else row.importTotal = Number(t.valor);
  }
  const out = [...byReporter.entries()].map(([rid, row]) => {
    const exp = row.exportTotal as number | null;
    const sociosTop = socios
      .filter((s) => s.reporter_id === rid)
      .slice(0, 8)
      .map((s) => ({
        iso3: s.partner_iso3 ?? null,
        nombre: s.partner_nombre ?? `M49 ${s.partner_m49}`,
        valor: Number(s.valor),
        share: exp && exp > 0 ? (Number(s.valor) / exp) * 100 : 0,
        flujo: 'X' as const,
      }));
    return {
      iso3: row.iso3,
      pais: row.pais,
      exportTotal: exp,
      importTotal: row.importTotal,
      balanza: exp != null && row.importTotal != null ? exp - row.importTotal : null,
      cuentaCorriente: caByIso.get(row.iso3) ?? null,
      sociosTop,
      periodo: row.periodo,
      prov: { fuente: 'UN Comtrade', asof: row.periodo, estado: 'ok' as const },
    };
  });
  out.sort((a, b) => (b.exportTotal ?? 0) - (a.exportTotal ?? 0));
  return out;
}

// ── Conflictos / geopolítica ──────────────────────────────────────────────
export async function conflictos() {
  const rows = await query(`SELECT * FROM v_conflict_latest ORDER BY intensidad DESC NULLS LAST`);
  const tend = await query(
    `SELECT c.iso3, g.fecha, g.intensidad::float8 AS intensidad FROM fact_geo_events g
     JOIN dim_country c ON c.id = g.country_id ORDER BY c.iso3, g.fecha`,
  );
  const tByIso = new Map<string, number[]>();
  for (const t of tend) {
    if (!tByIso.has(t.iso3)) tByIso.set(t.iso3, []);
    tByIso.get(t.iso3)!.push(Number(t.intensidad));
  }
  return rows.map((r) => ({
    iso3: r.iso3,
    pais: r.pais,
    intensidad: n(r.intensidad),
    tono: n(r.tono),
    tendencia: tByIso.get(r.iso3) ?? [],
    prov: { fuente: r.fuente, asof: r.asof ? new Date(r.asof).toISOString().slice(0, 10) : null, estado: 'ok' as const },
  }));
}

export async function eventos() {
  const rows = await query(
    `SELECT c.iso3, c.nombre_es AS pais, g.fecha, g.tipo, g.intensidad::float8 AS intensidad,
            g.tono::float8 AS tono, g.fuente
     FROM fact_geo_events g JOIN dim_country c ON c.id = g.country_id
     ORDER BY g.fecha DESC, g.intensidad DESC LIMIT 100`,
  );
  return rows.map((r) => ({
    fecha: new Date(r.fecha).toISOString().slice(0, 10),
    iso3: r.iso3,
    pais: r.pais,
    tipo: r.tipo,
    intensidad: n(r.intensidad),
    tono: n(r.tono),
    fuente: r.fuente,
  }));
}

// ── Riesgo soberano (scorecard macro + mercado + conflicto) ────────────────
export async function riesgoSoberano() {
  // z-scores macro de estrés + intensidad de conflicto → score 0-100.
  const heat = await query(
    `SELECT iso3, indicador, z::float8 AS z FROM v_heatmap_macro
     WHERE indicador IN ('cpi_yoy','debt_gdp','fiscal_balance','current_account')`,
  );
  const zByCountry = new Map<string, Record<string, number>>();
  for (const h of heat) {
    if (!zByCountry.has(h.iso3)) zByCountry.set(h.iso3, {});
    zByCountry.get(h.iso3)![h.indicador] = Number(h.z);
  }
  const conf = await query(`SELECT iso3, intensidad::float8 AS intensidad, tono::float8 AS tono FROM v_conflict_latest`);
  const confByIso = new Map(conf.map((r) => [r.iso3, { intensidad: Number(r.intensidad), tono: Number(r.tono) }]));
  const maxInt = Math.max(1, ...conf.map((r) => Number(r.intensidad) || 0));

  // Rendimiento 10A más reciente por país ({ISO3}_GB10Y de OECD; UST10Y de FRED).
  const yields = await query(
    `SELECT DISTINCT ON (m.country_id) c.iso3, m.valor::float8 AS y10
     FROM fact_market m JOIN dim_country c ON c.id = m.country_id
     WHERE m.clase = 'yield' AND (m.symbol = c.iso3 || '_GB10Y' OR (c.iso3 = 'USA' AND m.symbol = 'UST10Y'))
     ORDER BY m.country_id, m.fecha DESC`,
  );
  const y10ByIso = new Map<string, number>();
  for (const y of yields) y10ByIso.set(y.iso3, Number(y.y10));
  const usaY10 = y10ByIso.get('USA') ?? null;
  const bundY10 = y10ByIso.get('DEU') ?? null;
  // UST 2A (FRED) → pendiente de curva 10A−2A de EE.UU.
  const u2 = await one<{ v: number }>(`SELECT valor::float8 v FROM fact_market WHERE symbol='UST2Y' ORDER BY fecha DESC LIMIT 1`);
  const usaY2 = u2 ? Number(u2.v) : null;
  // Spread con benchmark de la misma moneda: zona euro vs Bund; resto vs UST.
  const EURO = new Set(['DEU', 'FRA', 'ITA', 'ESP', 'NLD']);

  const ps = await paises();
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const out = ps.map((p) => {
    const z = zByCountry.get(p.iso3) ?? {};
    // estrés macro: inflación alta, deuda alta, déficit (fiscal bajo), CC negativa.
    const stress =
      0.30 * (z.cpi_yoy ?? 0) + 0.30 * (z.debt_gdp ?? 0) - 0.20 * (z.fiscal_balance ?? 0) - 0.20 * (z.current_account ?? 0);
    const macroScore = clamp01((stress + 2) / 4); // z∈[-2,2] → [0,1]
    const c = confByIso.get(p.iso3);
    const conflScore = c ? clamp01((c.intensidad || 0) / maxInt) : null;
    const y10 = y10ByIso.get(p.iso3) ?? null;
    const bench = EURO.has(p.iso3) ? bundY10 : usaY10; // misma moneda
    const spread = y10 != null && bench != null ? (y10 - bench) * 100 : null;
    const mercadoScore = spread != null ? clamp01(spread / 600) : null; // 600 pb → tope
    const y2 = p.iso3 === 'USA' ? usaY2 : null;
    const pendiente = p.iso3 === 'USA' && y10 != null && usaY2 != null ? (y10 - usaY2) * 100 : null;
    const componentes = {
      macro: Math.round(macroScore * 100),
      mercado: mercadoScore != null ? Math.round(mercadoScore * 100) : null,
      conflicto: conflScore != null ? Math.round(conflScore * 100) : null,
    };
    const partes = [macroScore, mercadoScore, conflScore].filter((v): v is number => v != null);
    const score = partes.length ? Math.round((partes.reduce((s, v) => s + v, 0) / partes.length) * 100) : null;
    return {
      iso3: p.iso3,
      pais: p.nombreEs,
      yield10y: y10,
      yield2y: y2,
      pendiente,
      spread,
      spreadDelta: null,
      curva: p.iso3 === 'USA' ? [{ plazo: '2A', yield: y2 }, { plazo: '10A', yield: y10 }] : [{ plazo: '10A', yield: y10 }],
      score,
      scoreComponentes: componentes,
      prov: { fuente: 'FRED / ECB / OECD / GDELT', asof: null, estado: 'ok' as const },
    };
  });
  out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return out;
}

// ── Pulso global (qué cambió hoy) ─────────────────────────────────────────
export async function pulso() {
  const items: any[] = [];
  // 1) Mayores movimientos de mercado del día.
  const fx = await fxCommodities();
  const movers = fx.series
    .filter((s) => s.varDiaria != null)
    .sort((a, b) => Math.abs(b.varDiaria!) - Math.abs(a.varDiaria!))
    .slice(0, 4);
  for (const m of movers) {
    const up = (m.varDiaria ?? 0) > 0;
    items.push({
      id: `mkt_${m.id}`,
      titulo: `${m.nombre} ${up ? '▲' : '▼'} ${Math.abs(m.varDiaria!).toFixed(2)}%`,
      detalle: `Cotización ${m.valor?.toLocaleString('es')} · variación diaria`,
      categoria: m.clase === 'fx' ? 'fx' : m.clase === 'commodity' ? 'commodity' : 'mercado',
      valor: m.valor,
      delta: m.varDiaria,
      deltaLabel: `${m.varDiaria! > 0 ? '+' : ''}${m.varDiaria!.toFixed(2)}%`,
      sentiment: m.id === 'VIX' ? (up ? 'neg' : 'pos') : 'neutral',
      spark: m.spark,
      prov: m.prov,
    });
  }
  // 2) Mayores outliers macro (|z| extremo).
  const heat = await query(
    `SELECT h.iso3, c.nombre_es AS pais, h.indicador, i.nombre_es AS ind_nombre,
            h.valor::float8 AS valor, h.z::float8 AS z
     FROM v_heatmap_macro h JOIN dim_country c ON c.iso3 = h.iso3
     JOIN dim_indicator i ON i.codigo = h.indicador
     WHERE h.indicador IN ('cpi_yoy','gdp_growth','debt_gdp') AND abs(h.z) > 1.5
     ORDER BY abs(h.z) DESC LIMIT 3`,
  );
  for (const h of heat) {
    items.push({
      id: `macro_${h.iso3}_${h.indicador}`,
      titulo: `${h.pais} · ${h.ind_nombre} ${Number(h.z) > 0 ? 'muy alta' : 'muy baja'}`,
      detalle: `${Number(h.valor).toFixed(1)} (${Number(h.z) > 0 ? '+' : ''}${Number(h.z).toFixed(1)}σ vs pares)`,
      iso3: h.iso3,
      categoria: 'macro',
      valor: Number(h.valor),
      delta: Number(h.z),
      deltaLabel: `${Number(h.z) > 0 ? '+' : ''}${Number(h.z).toFixed(1)}σ`,
      sentiment: 'accent',
      prov: { fuente: 'World Bank / IMF', asof: null, estado: 'ok' },
    });
  }
  // 3) Conflicto de alta intensidad.
  const conf = await query(
    `SELECT c.nombre_es AS pais, cl.iso3, cl.intensidad::float8 AS intensidad, cl.tono::float8 AS tono
     FROM v_conflict_latest cl JOIN dim_country c ON c.iso3 = cl.iso3
     ORDER BY cl.intensidad DESC NULLS LAST LIMIT 2`,
  );
  for (const k of conf) {
    items.push({
      id: `geo_${k.iso3}`,
      titulo: `${k.pais} · tensión geopolítica`,
      detalle: `Intensidad ${Math.round(Number(k.intensidad))} · tono ${Number(k.tono).toFixed(1)}`,
      iso3: k.iso3,
      categoria: 'geopolitica',
      valor: Number(k.intensidad),
      delta: Number(k.tono),
      deltaLabel: `tono ${Number(k.tono).toFixed(1)}`,
      sentiment: Number(k.tono) < 0 ? 'neg' : 'neutral',
      prov: { fuente: 'GDELT', asof: null, estado: 'ok' },
    });
  }
  return items.slice(0, 8);
}

// ── Calendario (aún sin connector → vacío honesto) ─────────────────────────
export async function calendario() {
  const rows = await query(
    `SELECT e.fecha, c.iso3, c.nombre_es AS pais, e.tipo, e.titulo, e.tono
     FROM calendar_event e LEFT JOIN dim_country c ON c.id = e.country_id
     WHERE e.fecha >= current_date - 7 ORDER BY e.fecha LIMIT 60`,
  );
  return rows.map((r) => ({
    fecha: new Date(r.fecha).toISOString().slice(0, 10),
    pais: r.pais ?? 'Global',
    iso3: r.iso3 ?? undefined,
    tipo: r.tipo,
    titulo: r.titulo,
    tono: r.tono,
  }));
}

// ── Muro de medios: resolver el live actual de un canal de YouTube ─────────
export async function resolveLive(channelId: string) {
  try {
    const html = await fetchText(`https://www.youtube.com/channel/${channelId}/live`, {
      headers: { 'Accept-Language': 'es' },
      timeoutMs: 12_000,
      retries: 1,
    });
    const m = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
    if (m) return { channelId, videoId: m[1], estado: 'live' as const, resueltoVia: 'page' as const };
  } catch {
    /* degrada abajo */
  }
  return { channelId, videoId: null, estado: 'fallback' as const, resueltoVia: 'embed-channel' as const };
}

// ── Series históricas para el modal (clic en un valor) ────────────────────
const UNIDAD_MERCADO: Record<string, string> = {
  yield: '%', fx: '', commodity: 'US$', indice: 'pts', volatilidad: '', spread: 'pb',
};

/** Serie histórica de una serie de mercado (símbolo). */
export async function serieMercado(symbol: string) {
  const rows = await query(
    `SELECT to_char(fecha,'YYYY-MM-DD') AS fecha, valor::float8 AS valor, clase
     FROM fact_market WHERE symbol = $1 ORDER BY fecha`,
    [symbol],
  );
  const clase = rows[0]?.clase ?? null;
  const fuente = clase === 'yield' ? 'FRED / ECB / OECD' : symbol === 'EURUSD' ? 'ECB' : 'Yahoo Finance';
  return {
    id: symbol,
    nombre: NOMBRES[symbol] ?? symbol,
    unidad: clase ? (UNIDAD_MERCADO[clase] ?? '') : '',
    fuente,
    puntos: rows.map((r) => ({ fecha: r.fecha as string, valor: Number(r.valor) })),
  };
}

/** Serie histórica de un indicador macro para un país. */
export async function serieIndicador(iso3: string, codigo: string) {
  const meta = await one<{ nombre_es: string; unidad: string; fuente: string; pais: string }>(
    `SELECT i.nombre_es, i.unidad, i.fuente, c.nombre_es AS pais
     FROM dim_indicator i CROSS JOIN dim_country c WHERE i.codigo = $1 AND c.iso3 = $2`,
    [codigo, iso3],
  );
  const rows = await query(
    `SELECT to_char(t.fecha,'YYYY-MM-DD') AS fecha, t.valor::float8 AS valor
     FROM fact_timeseries t
     JOIN dim_country c ON c.id = t.country_id
     JOIN dim_indicator i ON i.id = t.indicator_id
     WHERE c.iso3 = $1 AND i.codigo = $2 AND t.valor IS NOT NULL
     ORDER BY t.fecha`,
    [iso3, codigo],
  );
  return {
    id: `${iso3}:${codigo}`,
    nombre: meta ? `${meta.pais} · ${meta.nombre_es}` : codigo,
    unidad: meta?.unidad ?? '',
    fuente: meta?.fuente ?? '',
    puntos: rows.map((r) => ({ fecha: r.fecha as string, valor: Number(r.valor) })),
  };
}
