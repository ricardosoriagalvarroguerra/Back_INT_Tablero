// ════════════════════════════════════════════════════════════════════════
// Capa analítica del Tablero INT. Convierte los hechos de la BDR en lectura
// económica: ciclo global, inflación, ciclo monetario, condiciones financieras,
// dinámica de deuda, posición externa, FX emergente, commodities y geopolítica;
// un semáforo por dimensión, una tesis, riesgos y alertas.
//
// Reglas de oro:
//   · Todo sale de la BDR (fuentes oficiales). Los textos son PLANTILLAS que se
//     rellenan con datos: si cambia el dato, cambia la lectura. Nada se escribe
//     a mano sobre el estado del mundo.
//   · Umbrales explícitos y documentados (docs/ANALISIS.md). Sin dato → 'sd'.
//   · Proyecciones del FMI siempre marcadas (tipo 'est' = año en curso, 'proy').
// ════════════════════════════════════════════════════════════════════════

import { query } from './db.ts';

type Nivel = 'verde' | 'ambar' | 'rojo' | 'sd';
type Sev = 'alta' | 'media' | 'info';

interface Pt { fecha: string; valor: number }

// ── utilidades numéricas y de formato ────────────────────────────────────
const fmt = (x: number | null | undefined, d = 1) =>
  x == null || !Number.isFinite(x) ? 's/d' : x.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
const sg = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? 's/d' : `${x > 0 ? '+' : ''}${fmt(x, d)}`);
const r1 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** Percentil (0-100) del último valor dentro de la historia disponible. */
const percentil = (pts: Pt[], v: number | null) =>
  v == null || pts.length < 20 ? null : Math.round((pts.filter((p) => p.valor <= v).length / pts.length) * 100);
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** '2026-10-02' → '2 oct 2026' · '2026-10' → 'oct 2026'. */
const fTxt = (iso: string | null | undefined) => {
  if (!iso) return 's/d';
  const [y, m, d] = iso.split('-');
  return `${d ? `${Number(d)} ` : ''}${MESES[Number(m) - 1]} ${y}`;
};
const fechaISO = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const restarDias = (iso: string, dias: number) => fechaISO(new Date(Date.parse(iso) - dias * 86_400_000));
/** Valor en (o inmediatamente antes de) una fecha. */
function valorEn(pts: Pt[], iso: string): number | null {
  let v: number | null = null;
  for (const p of pts) {
    if (p.fecha <= iso) v = p.valor;
    else break;
  }
  return v;
}
const ultimo = (pts: Pt[]) => pts[pts.length - 1] ?? null;
function varPct(pts: Pt[], dias: number): number | null {
  const u = ultimo(pts);
  if (!u) return null;
  const a = valorEn(pts, restarDias(u.fecha, dias));
  return a == null || a === 0 ? null : (u.valor / a - 1) * 100;
}
function varAbs(pts: Pt[], dias: number): number | null {
  const u = ultimo(pts);
  if (!u) return null;
  const a = valorEn(pts, restarDias(u.fecha, dias));
  return a == null ? null : u.valor - a;
}
/** Volatilidad anualizada (%) de retornos log diarios en los últimos `dias`. */
function volAnual(pts: Pt[], dias: number): number | null {
  const u = ultimo(pts);
  if (!u) return null;
  const desde = restarDias(u.fecha, dias);
  const xs = pts.filter((p) => p.fecha >= desde);
  if (xs.length < 15) return null;
  const rets: number[] = [];
  for (let i = 1; i < xs.length; i++) if (xs[i - 1].valor > 0 && xs[i].valor > 0) rets.push(Math.log(xs[i].valor / xs[i - 1].valor));
  const m = mean(rets)!;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - m) ** 2, 0) / Math.max(1, rets.length - 1));
  return sd * Math.sqrt(252) * 100;
}
/** Submuestreo semanal (último dato de cada semana) para gráficos livianos. */
function semanal(pts: Pt[], desdeISO: string): Pt[] {
  const out: Pt[] = [];
  let semana = '';
  for (const p of pts) {
    if (p.fecha < desdeISO) continue;
    const d = new Date(p.fecha);
    const lunes = fechaISO(new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000));
    if (lunes !== semana) {
      out.push({ ...p });
      semana = lunes;
    } else out[out.length - 1] = { ...p };
  }
  return out;
}

/** "percentil N desde 2015" o "máximos desde 2015" / "no se veía desde AAAA-MM". */
function maxTxt(c: { pctl10: number | null; max10Desde: string | null; serieDesde?: string | null }) {
  if ((c.pctl10 ?? 0) >= 98) return `máximo desde 2015, percentil ${c.pctl10}`;
  const viejo = c.max10Desde && c.max10Desde < restarDias(new Date().toISOString(), 183);
  return `percentil ${c.pctl10} desde 2015${viejo ? `; nivel no visto desde ${fTxt(c.max10Desde!.slice(0, 7))}` : ''}`;
}

// ── carga de datos ───────────────────────────────────────────────────────
interface Pais { iso3: string; nombre: string; region: string; grupos: string[] }

async function cargar() {
  const paises = (await query(`SELECT iso3, nombre_es, region, grupos FROM dim_country ORDER BY nombre_es`)).map(
    (r) => ({ iso3: r.iso3 as string, nombre: r.nombre_es as string, region: r.region as string, grupos: r.grupos as string[] }),
  );
  const mk = await query(
    `SELECT symbol, to_char(fecha,'YYYY-MM-DD') f, valor::float8 v FROM fact_market WHERE valor IS NOT NULL ORDER BY symbol, fecha`,
  );
  const mercado = new Map<string, Pt[]>();
  for (const r of mk) {
    if (!mercado.has(r.symbol)) mercado.set(r.symbol, []);
    mercado.get(r.symbol)!.push({ fecha: r.f, valor: Number(r.v) });
  }
  const an = await query(
    `SELECT c.iso3, i.codigo, extract(year FROM t.fecha)::int anio, t.valor::float8 v
     FROM fact_timeseries t JOIN dim_country c ON c.id = t.country_id JOIN dim_indicator i ON i.id = t.indicator_id
     WHERE i.frecuencia = 'anual' AND t.valor IS NOT NULL`,
  );
  // anual[codigo][iso3][anio]
  const anual = new Map<string, Map<string, Map<number, number>>>();
  for (const r of an) {
    if (!anual.has(r.codigo)) anual.set(r.codigo, new Map());
    const m = anual.get(r.codigo)!;
    if (!m.has(r.iso3)) m.set(r.iso3, new Map());
    m.get(r.iso3)!.set(r.anio, Number(r.v));
  }
  const pr = await query(
    `SELECT c.iso3, to_char(t.fecha,'YYYY-MM-DD') f, t.valor::float8 v FROM fact_timeseries t
     JOIN dim_country c ON c.id = t.country_id JOIN dim_indicator i ON i.id = t.indicator_id
     WHERE i.codigo = 'policy_rate' AND t.valor IS NOT NULL ORDER BY c.iso3, t.fecha`,
  );
  const tasas = new Map<string, Pt[]>();
  for (const r of pr) {
    if (!tasas.has(r.iso3)) tasas.set(r.iso3, []);
    tasas.get(r.iso3)!.push({ fecha: r.f, valor: Number(r.v) });
  }
  const ag = await query(
    `SELECT a.agregado, d.nombre_es, d.orden, i.codigo, a.anio, a.valor::float8 v FROM fact_aggregate a
     JOIN dim_aggregate d ON d.codigo = a.agregado JOIN dim_indicator i ON i.id = a.indicator_id
     WHERE a.valor IS NOT NULL ORDER BY d.orden, a.anio`,
  );
  const agregados = new Map<string, { nombre: string; orden: number; ind: Map<string, Map<number, number>> }>();
  for (const r of ag) {
    if (!agregados.has(r.agregado)) agregados.set(r.agregado, { nombre: r.nombre_es, orden: r.orden, ind: new Map() });
    const a = agregados.get(r.agregado)!;
    if (!a.ind.has(r.codigo)) a.ind.set(r.codigo, new Map());
    a.ind.get(r.codigo)!.set(Number(r.anio), Number(r.v));
  }
  const geo = await query(
    `SELECT c.iso3, c.nombre_es, to_char(g.fecha,'YYYY-MM-DD') f, g.intensidad::float8 i, g.tono::float8 t
     FROM fact_geo_events g JOIN dim_country c ON c.id = g.country_id ORDER BY c.iso3, g.fecha`,
  );
  const fuentes = await query(`SELECT codigo, proveedor, estado FROM dim_source`);
  return { paises, mercado, anual, tasas, agregados, geo, fuentes };
}

type Datos = Awaited<ReturnType<typeof cargar>>;

// ── constantes del análisis (documentadas en docs/ANALISIS.md) ────────────
/** Pares FX vs USD → país emisor (USDxxx: alza = depreciación de la moneda local). */
const PARES: Record<string, string> = {
  USDBRL: 'BRA', USDMXN: 'MEX', USDARS: 'ARG', USDCLP: 'CHL', USDCOP: 'COL', USDPEN: 'PER',
  USDTRY: 'TUR', USDZAR: 'ZAF', USDCNY: 'CHN', USDINR: 'IND', USDKRW: 'KOR', USDIDR: 'IDN',
  USDPLN: 'POL', USDJPY: 'JPN',
};
const EURO = new Set(['DEU', 'FRA', 'ITA', 'ESP', 'NLD']);
/** Commodity → principales exportadores netos del catálogo (exposición estructural). */
const EXPOSICION: Record<string, { nombre: string; paises: string[] }> = {
  BRENT: { nombre: 'Petróleo Brent', paises: ['SAU', 'ARE', 'NOR', 'NGA', 'RUS', 'COL', 'ECU', 'CAN'] },
  WTI: { nombre: 'Petróleo WTI', paises: [] },
  NATGAS: { nombre: 'Gas natural (Henry Hub)', paises: ['NOR', 'RUS', 'BOL', 'USA'] },
  COPPER: { nombre: 'Cobre', paises: ['CHL', 'PER'] },
  GOLD: { nombre: 'Oro', paises: ['ZAF', 'PER', 'AUS'] },
  SOY: { nombre: 'Soja', paises: ['BRA', 'ARG', 'PRY', 'URY'] },
  WHEAT: { nombre: 'Trigo', paises: ['RUS', 'AUS', 'CAN', 'ARG'] },
};

// ── secciones ────────────────────────────────────────────────────────────
function seccionCiclo(D: Datos, Y: number) {
  const tipo = (a: number) => (a < Y ? 'obs' : a === Y ? 'est' : 'proy');
  const agregados = [...D.agregados.entries()].map(([codigo, a]) => {
    const anios = [...new Set([...(a.ind.get('gdp_growth')?.keys() ?? [])])].sort((x, y) => x - y);
    return {
      codigo,
      nombre: a.nombre,
      serie: anios.map((anio) => ({
        anio,
        tipo: tipo(anio),
        crecimiento: r2(a.ind.get('gdp_growth')?.get(anio) ?? null),
        inflacion: r2(a.ind.get('cpi_yoy')?.get(anio) ?? null),
        deuda: r1(a.ind.get('debt_gdp')?.get(anio) ?? null),
      })),
    };
  });
  const w = D.agregados.get('WEOWORLD')?.ind.get('gdp_growth');
  const g = (an: number) => w?.get(an) ?? null;
  const prom1519 = mean([2015, 2016, 2017, 2018, 2019].map(g).filter((x): x is number => x != null));
  const regiones = agregados
    .filter((a) => !['WEOWORLD', 'ADVEC', 'OEMDC', 'MAE'].includes(a.codigo))
    .map((a) => ({ codigo: a.codigo, nombre: a.nombre, g: a.serie.find((p) => p.anio === Y)?.crecimiento ?? null, g1: a.serie.find((p) => p.anio === Y + 1)?.crecimiento ?? null }))
    .filter((r) => r.g != null);
  const enContraccion = regiones.filter((r) => (r.g ?? 0) < 0);
  const masDinamica = [...regiones].sort((a, b) => (b.g ?? 0) - (a.g ?? 0))[0];
  const adv = D.agregados.get('ADVEC')?.ind.get('gdp_growth')?.get(Y) ?? null;
  const em = D.agregados.get('OEMDC')?.ind.get('gdp_growth')?.get(Y) ?? null;
  const latam = D.agregados.get('WE')?.ind.get('gdp_growth')?.get(Y) ?? null;

  const lecturas: string[] = [];
  if (g(Y) != null) {
    lecturas.push(
      `El FMI estima que el mundo crece ${fmt(g(Y))}% en ${Y}, ${g(Y)! < (g(Y - 1) ?? g(Y)!) ? 'menos' : g(Y)! > (g(Y - 1) ?? g(Y)!) ? 'más' : 'lo mismo'} que en ${Y - 1} (${fmt(g(Y - 1))}%)` +
        (prom1519 != null ? ` y ${g(Y)! < prom1519 - 0.15 ? 'por debajo' : g(Y)! > prom1519 + 0.15 ? 'por encima' : 'en línea'} del promedio 2015–19 (${fmt(prom1519)}%).` : '.'),
    );
  }
  if (adv != null && em != null)
    lecturas.push(`Avanzadas ${fmt(adv)}% · emergentes ${fmt(em)}% · América Latina ${fmt(latam)}%: el diferencial a favor de los emergentes es de ${fmt(em - adv)} pp.`);
  if (enContraccion.length)
    lecturas.push(`En contracción en ${Y}: ${enContraccion.map((r) => `${r.nombre} (${fmt(r.g)}%)`).join(', ')}${enContraccion.some((r) => (r.g1 ?? 0) > 0) ? `; el FMI proyecta rebote en ${Y + 1}` : ''}.`);
  if (g(Y + 1) != null) lecturas.push(`Para ${Y + 1} el FMI proyecta ${fmt(g(Y + 1))}% global; región más dinámica en ${Y}: ${masDinamica?.nombre} (${fmt(masDinamica?.g)}%).`);

  return {
    anioBase: Y,
    agregados,
    mundo: { crecimiento: r2(g(Y)), anterior: r2(g(Y - 1)), siguiente: r2(g(Y + 1)), promedio1519: r2(prom1519) },
    enContraccion: enContraccion.map((r) => ({ codigo: r.codigo, nombre: r.nombre, crecimiento: r.g, siguiente: r.g1 })),
    lecturas,
  };
}

function seccionInflacion(D: Datos, Y: number) {
  const cpi = D.anual.get('cpi_yoy') ?? new Map();
  const filas = D.paises
    .map((p) => {
      const s = cpi.get(p.iso3);
      const v = s?.get(Y) ?? null;
      const a = s?.get(Y - 1) ?? null;
      const n = s?.get(Y + 1) ?? null;
      return { iso3: p.iso3, pais: p.nombre, inflacion: r1(v), anterior: r1(a), siguiente: r1(n), cambio: v != null && a != null ? r1(v - a) : null };
    })
    .filter((f) => f.inflacion != null);
  const vals = filas.map((f) => f.inflacion!);
  const med = median(vals);
  const sobre5 = filas.filter((f) => f.inflacion! >= 5).length;
  const sobre10 = filas.filter((f) => f.inflacion! >= 10);
  const acelera = filas.filter((f) => (f.cambio ?? 0) > 0.3).length;
  const desacelera = filas.filter((f) => (f.cambio ?? 0) < -0.3).length;
  const w = D.agregados.get('WEOWORLD')?.ind.get('cpi_yoy');
  const adv = D.agregados.get('ADVEC')?.ind.get('cpi_yoy');
  const lecturas: string[] = [];
  if (w?.get(Y) != null)
    lecturas.push(
      `Inflación mundial ${fmt(w.get(Y))}% en ${Y} (FMI) frente a ${fmt(w.get(Y - 1))}% en ${Y - 1}: ${w.get(Y)! > w.get(Y - 1)! + 0.2 ? 'repunte' : w.get(Y)! < w.get(Y - 1)! - 0.2 ? 'desinflación en curso' : 'estancamiento'}; en avanzadas ${fmt(adv?.get(Y))}%.`,
    );
  if (filas.length)
    lecturas.push(
      `En las ${filas.length} economías del tablero la mediana es ${fmt(med)}%; ${acelera} aceleran y ${desacelera} desaceleran frente a ${Y - 1}; ${sobre5} superan el 5%.`,
    );
  if (sobre10.length)
    lecturas.push(`Inflación de dos dígitos: ${sobre10.sort((a, b) => b.inflacion! - a.inflacion!).map((f) => `${f.pais} ${fmt(f.inflacion)}%`).join(', ')}.`);
  return {
    anioBase: Y,
    mundo: r2(w?.get(Y) ?? null),
    mundoAnterior: r2(w?.get(Y - 1) ?? null),
    mediana: r1(med),
    acelera,
    desacelera,
    sobre5,
    filas: filas.sort((a, b) => b.inflacion! - a.inflacion!),
    lecturas,
  };
}

function seccionMonetario(D: Datos, Y: number) {
  const cpi = D.anual.get('cpi_yoy') ?? new Map();
  // Un banco central por jurisdicción: la zona euro se cuenta una vez (BCE).
  const bancos = D.paises.filter((p) => D.tasas.has(p.iso3) && (!EURO.has(p.iso3) || p.iso3 === 'DEU'));
  const nombreBanco = (p: Pais) => (p.iso3 === 'DEU' ? 'Zona euro (BCE)' : p.nombre);
  const fin = bancos.map((p) => ultimo(D.tasas.get(p.iso3)!)?.fecha ?? '').sort().pop() ?? '';
  const filas = bancos.map((p) => {
    const s = D.tasas.get(p.iso3)!;
    const u = ultimo(s)!;
    const v3 = varAbs(s, 92);
    const v12 = varAbs(s, 366);
    // última decisión: último mes con cambio
    let ultimaDecision: { fecha: string; cambio: number } | null = null;
    for (let i = s.length - 1; i > 0; i--) {
      const d = s[i].valor - s[i - 1].valor;
      if (Math.abs(d) > 1e-6) {
        ultimaDecision = { fecha: s[i].fecha.slice(0, 7), cambio: r2(d)! };
        break;
      }
    }
    const infl = cpi.get(p.iso3)?.get(Y) ?? null;
    const real = infl != null ? u.valor - infl : null;
    const postura = real == null ? 'sd' : real > 2 ? 'restrictiva' : real < 0 ? 'expansiva' : 'neutral';
    return {
      iso3: p.iso3,
      pais: nombreBanco(p),
      tasa: r2(u.valor),
      fecha: u.fecha.slice(0, 7),
      desactualizada: u.fecha < restarDias(fin, 100),
      var3m: r2(v3),
      var12m: r2(v12),
      ultimaDecision,
      inflacion: r1(infl),
      real: r2(real),
      postura,
      serie: s.filter((x) => x.fecha >= `${Y - 3}-01-01`).map((x) => ({ fecha: x.fecha.slice(0, 7), valor: x.valor })),
    };
  });
  // Difusión mensual: cuántos bancos suben / recortan vs el mes previo (24 meses).
  const meses = new Set<string>();
  for (const p of bancos) for (const x of D.tasas.get(p.iso3)!) if (x.fecha >= restarDias(fin, 760)) meses.add(x.fecha.slice(0, 7));
  const difusion = [...meses]
    .sort()
    .map((mes) => {
      let subas = 0, recortes = 0, sinCambio = 0;
      for (const p of bancos) {
        const s = D.tasas.get(p.iso3)!;
        const i = s.findIndex((x) => x.fecha.startsWith(mes));
        if (i <= 0) continue;
        const d = s[i].valor - s[i - 1].valor;
        if (d > 1e-6) subas++;
        else if (d < -1e-6) recortes++;
        else sinCambio++;
      }
      return { mes, subas, recortes, sinCambio, neto: subas - recortes };
    })
    .filter((m) => m.subas + m.recortes + m.sinCambio > 0);
  const vigentes = filas.filter((f) => !f.desactualizada);
  const recortaron12 = vigentes.filter((f) => (f.var12m ?? 0) < -1e-6);
  const subieron12 = vigentes.filter((f) => (f.var12m ?? 0) > 1e-6);
  const ult3 = difusion.slice(-3);
  const prev3 = difusion.slice(-6, -3);
  const neto3 = ult3.reduce((s, m) => s + m.neto, 0);
  const netoPrev3 = prev3.reduce((s, m) => s + m.neto, 0);
  const subas3 = ult3.reduce((s, m) => s + m.subas, 0);
  const recortes3 = ult3.reduce((s, m) => s + m.recortes, 0);
  const fase =
    neto3 > 0 && netoPrev3 <= 0 ? 'giro restrictivo' : neto3 > 0 ? 'endurecimiento' : neto3 < 0 && netoPrev3 >= 0 ? 'giro expansivo' : neto3 < 0 ? 'relajamiento' : 'pausa';
  const fed = filas.find((f) => f.iso3 === 'USA');
  const bce = filas.find((f) => f.iso3 === 'DEU');
  const lecturas: string[] = [];
  if (vigentes.length) lecturas.push(
    `En 12 meses ${recortaron12.length} de ${vigentes.length} bancos centrales recortaron y ${subieron12.length} subieron. En los últimos 3 meses hubo ${subas3} subas y ${recortes3} recortes: fase de ${fase}.`,
  );
  if (fed) lecturas.push(`Fed: ${fmt(fed.tasa, 2)}% (${sg(fed.var12m, 2)} pp en 12 meses), tasa real ${sg(fed.real, 1)}% con inflación ${fmt(fed.inflacion)}% → postura ${fed.postura}.`);
  if (bce) lecturas.push(`BCE: ${fmt(bce.tasa, 2)}% (${sg(bce.var12m, 2)} pp en 12 meses), postura ${bce.postura}.`);
  const expansivas = filas.filter((f) => f.postura === 'expansiva');
  const restrictivas = filas.filter((f) => f.postura === 'restrictiva').sort((a, b) => (b.real ?? 0) - (a.real ?? 0));
  if (restrictivas.length)
    lecturas.push(`Tasas reales más altas: ${restrictivas.slice(0, 4).map((f) => `${f.pais} ${sg(f.real)}%`).join(', ')}.`);
  if (expansivas.length)
    lecturas.push(`Con tasa real negativa: ${expansivas.map((f) => `${f.pais} ${sg(f.real)}%`).join(', ')}.`);
  return {
    corte: fin.slice(0, 7),
    bancos: filas.length,
    recortaron12: recortaron12.length,
    subieron12: subieron12.length,
    subas3,
    recortes3,
    fase,
    filas: filas.sort((a, b) => (b.real ?? -99) - (a.real ?? -99)),
    difusion,
    lecturas,
  };
}

function seccionCondiciones(D: Datos) {
  const M = D.mercado;
  const ind = (symbol: string, nombre: string, unidad: string, opts: { dias?: number; altoEsEstres?: boolean; absoluto?: boolean } = {}) => {
    const pts = M.get(symbol) ?? [];
    const u = ultimo(pts);
    const v = u?.valor ?? null;
    return {
      id: symbol,
      nombre,
      unidad,
      valor: r2(v),
      fecha: u?.fecha ?? null,
      var1m: r2(opts.absoluto ? varAbs(pts, 31) : varPct(pts, 31)),
      var1mTipo: opts.absoluto ? 'abs' : 'pct',
      percentil: percentil(pts, v),
      desde: pts[0]?.fecha.slice(0, 4) ?? null,
      altoEsEstres: opts.altoEsEstres ?? true,
      spark: semanal(pts, restarDias(u?.fecha ?? '2000-01-01', 365)).map((p) => p.valor),
    };
  };
  const indicadores = [
    ind('VIX', 'VIX (volatilidad implícita S&P 500)', 'pts', { absoluto: true }),
    ind('HY_OAS', 'Spread high yield EE.UU.', 'pb', { absoluto: true }),
    ind('IG_OAS', 'Spread grado de inversión EE.UU.', 'pb', { absoluto: true }),
    ind('EM_OAS', 'Spread corporativo emergente', 'pb', { absoluto: true }),
    ind('NFCI', 'Índice de condiciones financieras (Chicago Fed)', 'índice', { absoluto: true }),
    ind('USD_BROAD', 'Dólar amplio (Fed, ponderado comercio)', 'índice'),
    ind('UST10Y', 'Bono del Tesoro 10 años', '%', { absoluto: true }),
    ind('UST10Y_REAL', 'Tasa real 10 años (TIPS)', '%', { absoluto: true }),
    ind('BE10Y', 'Inflación implícita 10 años', '%', { absoluto: true }),
  ].filter((i) => i.valor != null);
  const byId = new Map(indicadores.map((i) => [i.id, i]));
  const componentes = ['VIX', 'HY_OAS', 'EM_OAS', 'NFCI'].map((k) => byId.get(k)?.percentil).filter((x): x is number => x != null);
  const indice = componentes.length ? Math.round(mean(componentes)!) : null;
  const estado = indice == null ? 'sd' : indice >= 65 ? 'tensas' : indice <= 35 ? 'holgadas' : 'neutrales';

  // Curva del Tesoro
  const y10 = M.get('UST10Y') ?? [], y2 = M.get('UST2Y') ?? [], y3m = M.get('UST3M') ?? [];
  const u10 = ultimo(y10)?.valor ?? null, u2 = ultimo(y2)?.valor ?? null, u3 = ultimo(y3m)?.valor ?? null;
  const pend = (a: Pt[], b: Pt[]) => {
    const mb = new Map(b.map((p) => [p.fecha, p.valor]));
    return a.filter((p) => mb.has(p.fecha)).map((p) => ({ fecha: p.fecha, valor: (p.valor - mb.get(p.fecha)!) * 100 }));
  };
  const p102 = pend(y10, y2), p103m = pend(y10, y3m);
  const ultFecha = ultimo(y10)?.fecha ?? '2000-01-01';
  const desde = restarDias(ultFecha, 3 * 365);
  const curva = {
    y3m: r2(u3),
    y2: r2(u2),
    y10: r2(u10),
    pend10y2y: r1(ultimo(p102)?.valor ?? null),
    pend10y3m: r1(ultimo(p103m)?.valor ?? null),
    real10: r2(ultimo(M.get('UST10Y_REAL') ?? [])?.valor ?? null),
    breakeven: r2(ultimo(M.get('BE10Y') ?? [])?.valor ?? null),
    pctl10: percentil(y10, u10),
    max10Desde: (() => {
      // ¿desde cuándo no se veía un 10A tan alto?
      if (u10 == null) return null;
      for (let i = y10.length - 2; i >= 0; i--) if (y10[i].valor >= u10 && y10[i].fecha < restarDias(ultFecha, 30)) return y10[i].fecha;
      return y10[0]?.fecha ?? null;
    })(),
    serie: semanal(y10, desde).map((p) => ({ fecha: p.fecha, y10: r2(p.valor), y2: r2(valorEn(y2, p.fecha)), pend: r1(valorEn(p102, p.fecha)) })),
  };

  const vix = byId.get('VIX'), hy = byId.get('HY_OAS'), usd = M.get('USD_BROAD') ?? [];
  const lecturas: string[] = [];
  if (indice != null)
    lecturas.push(
      `Índice de estrés propio ${indice}/100 (promedio del percentil desde 2015 de VIX, spreads HY y EM y NFCI): condiciones ${estado}.`,
    );
  if (vix && hy)
    lecturas.push(`VIX ${fmt(vix.valor)} (percentil ${vix.percentil}) y spread HY ${fmt(hy.valor, 0)} pb (percentil ${hy.percentil}, ${sg(hy.var1m, 0)} pb en el mes).`);
  if (u10 != null)
    lecturas.push(
      `Tesoro 10A en ${fmt(u10, 2)}% (${maxTxt(curva)}); pendiente 10A–2A ${sg(curva.pend10y2y, 0)} pb y 10A–3M ${sg(curva.pend10y3m, 0)} pb; tasa real ${fmt(curva.real10, 2)}% e inflación implícita ${fmt(curva.breakeven, 2)}%.`,
    );
  const usd3 = varPct(usd, 92);
  if (usd3 != null) lecturas.push(`Dólar amplio ${sg(usd3)}% en 3 meses: ${usd3 > 2 ? 'fortalecimiento que endurece las condiciones para emergentes' : usd3 < -2 ? 'debilitamiento que alivia a emergentes' : 'estable'}.`);
  return { indice, estado, indicadores, curva, usd3m: r1(usd3), lecturas };
}

function seccionDeuda(D: Datos, Y: number) {
  const A = D.anual;
  const get = (c: string, iso: string, an: number) => A.get(c)?.get(iso)?.get(an) ?? null;
  const ultimoAnio = (c: string, iso: string) => Math.max(...[...(A.get(c)?.get(iso)?.keys() ?? [])], -Infinity);
  const filas = D.paises
    .map((p) => {
      const d = get('debt_gdp', p.iso3, Y);
      if (d == null) return null;
      const hor = Math.min(ultimoAnio('debt_gdp', p.iso3), Y + 5);
      const dF = Number.isFinite(hor) && hor > Y ? get('debt_gdp', p.iso3, hor) : null;
      const b = get('fiscal_balance', p.iso3, Y);
      // crecimiento nominal esperado: promedio Y+1..Y+3 de (1+g)(1+π)−1 (proyecciones FMI)
      const gns: number[] = [];
      for (let an = Y + 1; an <= Y + 3; an++) {
        const g = get('gdp_growth', p.iso3, an), pi = get('cpi_yoy', p.iso3, an);
        if (g != null && pi != null) gns.push(((1 + g / 100) * (1 + pi / 100) - 1) * 100);
      }
      const gn = gns.length ? mean(gns)! : null;
      const y10 = ultimo(D.mercado.get(p.iso3 === 'USA' ? 'UST10Y' : `${p.iso3}_GB10Y`) ?? [])?.valor ?? null;
      const rg = y10 != null && gn != null ? y10 - gn : null;
      // balance global que estabiliza la deuda/PIB: b* = −d·gn/(1+gn)
      const bEst = gn != null ? (-d * (gn / 100)) / (1 + gn / 100) : null;
      const brecha = b != null && bEst != null ? b - bEst : null;
      return {
        iso3: p.iso3,
        pais: p.nombre,
        deuda: r1(d),
        deudaHorizonte: r1(dF),
        horizonte: dF != null ? hor : null,
        cambio: dF != null ? r1(dF - d) : null,
        balance: r1(b),
        crecNominal: r1(gn),
        yield10: r2(y10),
        rg: r1(rg),
        balanceEstabilizador: r1(bEst),
        brecha: r1(brecha),
        trayectoria: dF == null ? 'sd' : dF - d > 5 ? 'creciente' : dF - d < -5 ? 'decreciente' : 'estable',
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => (b.deuda ?? 0) - (a.deuda ?? 0));
  const preocupantes = filas.filter((f) => (f.deuda ?? 0) >= 90 && (f.cambio ?? 0) > 5);
  const rgPositivo = filas.filter((f) => (f.rg ?? -1) > 0);
  const w = D.agregados.get('WEOWORLD')?.ind.get('debt_gdp');
  const lecturas: string[] = [];
  if (w?.get(Y) != null) {
    const hor = Math.max(...w.keys());
    lecturas.push(`Deuda pública mundial ${fmt(w.get(Y))}% del PIB en ${Y}; el FMI la proyecta en ${fmt(w.get(hor))}% hacia ${hor}${w.get(hor)! >= 100 ? ', por encima del 100%' : ''}.`);
  }
  if (preocupantes.length)
    lecturas.push(`Deuda alta (≥90% PIB) y en ascenso (>5 pp al horizonte): ${preocupantes.map((f) => `${f.pais} ${fmt(f.deuda, 0)}→${fmt(f.deudaHorizonte, 0)}%`).join(', ')}.`);
  if (rgPositivo.length)
    lecturas.push(
      `Con r − g positivo (el rendimiento a 10A supera al crecimiento nominal esperado, la deuda crece sola si no hay superávit): ${rgPositivo.sort((a, b) => b.rg! - a.rg!).map((f) => `${f.pais} ${sg(f.rg)} pp`).join(', ')}.`,
    );
  const brechaNeg = filas.filter((f) => (f.brecha ?? 0) < -2).sort((a, b) => a.brecha! - b.brecha!);
  if (brechaNeg.length)
    lecturas.push(`Mayor distancia al balance que estabiliza la deuda: ${brechaNeg.slice(0, 5).map((f) => `${f.pais} ${sg(f.brecha)} pp`).join(', ')}.`);
  return { anioBase: Y, filas, preocupantes: preocupantes.map((f) => f.iso3), lecturas };
}

function seccionExterno(D: Datos, Y: number) {
  const A = D.anual;
  const filas = D.paises
    .map((p) => {
      const f = A.get('fiscal_balance')?.get(p.iso3)?.get(Y) ?? null;
      const ca = A.get('current_account')?.get(p.iso3)?.get(Y) ?? null;
      if (f == null || ca == null) return null;
      const cuadrante = f < 0 && ca < 0 ? 'deficits-gemelos' : f >= 0 && ca >= 0 ? 'superavits-gemelos' : ca < 0 ? 'deficit-externo' : 'deficit-fiscal';
      return { iso3: p.iso3, pais: p.nombre, region: p.region, fiscal: r1(f), cuentaCorriente: r1(ca), cuadrante, peso: r2(A.get('gdp_usd')?.get(p.iso3)?.get(Y) ?? null) };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
  const gemelos = filas.filter((f) => f.cuadrante === 'deficits-gemelos');
  const graves = gemelos.filter((f) => f.fiscal! < -3 && f.cuentaCorriente! < -3);
  const lecturas: string[] = [];
  if (filas.length) lecturas.push(`${gemelos.length} de ${filas.length} economías tienen déficits gemelos (fiscal y de cuenta corriente) en ${Y}.`);
  if (graves.length) lecturas.push(`Ambos déficits por encima del 3% del PIB: ${graves.map((f) => `${f.pais} (${fmt(f.fiscal)} / ${fmt(f.cuentaCorriente)})`).join(', ')}.`);
  const ext = filas.filter((f) => f.cuentaCorriente! < -4).sort((a, b) => a.cuentaCorriente! - b.cuentaCorriente!);
  if (ext.length) lecturas.push(`Mayor necesidad de financiamiento externo (cuenta corriente < −4% PIB): ${ext.map((f) => `${f.pais} ${fmt(f.cuentaCorriente)}%`).join(', ')}.`);
  return { anioBase: Y, filas, lecturas };
}

function seccionFx(D: Datos, monet: ReturnType<typeof seccionMonetario>) {
  const tasa = new Map(monet.filas.map((f) => [f.iso3, f.tasa]));
  for (const iso of EURO) if (tasa.has('DEU')) tasa.set(iso, tasa.get('DEU')!);
  const usTasa = tasa.get('USA') ?? null;
  const nombres = new Map(D.paises.map((p) => [p.iso3, p.nombre]));
  const filas = Object.entries(PARES)
    .map(([par, iso3]) => {
      const pts = D.mercado.get(par) ?? [];
      const u = ultimo(pts);
      if (!u) return { par, iso3, pais: nombres.get(iso3) ?? iso3, valor: null, fecha: null, var1m: null, var3m: null, var1a: null, vol3m: null, carry: null, carryVol: null };
      const vol = volAnual(pts, 92);
      const t = tasa.get(iso3) ?? null;
      const carry = t != null && usTasa != null ? t - usTasa : null;
      return {
        par,
        iso3,
        pais: nombres.get(iso3) ?? iso3,
        valor: r2(u.valor),
        fecha: u.fecha,
        var1m: r1(varPct(pts, 31)),
        var3m: r1(varPct(pts, 92)),
        var1a: r1(varPct(pts, 365)),
        vol3m: r1(vol),
        carry: r2(carry),
        // piso de volatilidad 4%: monedas administradas (crawling peg) darían ratios absurdos
        carryVol: carry != null && vol != null ? r2(carry / Math.max(vol, 4)) : null,
      };
    })
    .sort((a, b) => (b.var3m ?? -999) - (a.var3m ?? -999));
  const con = filas.filter((f) => f.var3m != null);
  const med3 = median(con.map((f) => f.var3m!));
  const lecturas: string[] = [];
  if (con.length) {
    const peor = con[0], mejor = con[con.length - 1];
    lecturas.push(
      `Mediana de ${con.length} monedas frente al USD en 3 meses: ${sg(med3)}% (positivo = depreciación). Más débil: ${peor.pais} ${sg(peor.var3m)}%; más firme: ${mejor.pais} ${sg(mejor.var3m)}%.`,
    );
  }
  const carry = filas.filter((f) => f.carryVol != null).sort((a, b) => b.carryVol! - a.carryVol!);
  if (carry.length)
    lecturas.push(`Mejor carry ajustado por volatilidad (diferencial de tasa vs Fed / vol. 3M, con piso de 4%): ${carry.slice(0, 3).map((f) => `${f.pais} ${fmt(f.carryVol, 2)}`).join(', ')}.`);
  return { filas, mediana3m: r1(med3), lecturas };
}

function seccionCommodities(D: Datos) {
  const nombres = new Map(D.paises.map((p) => [p.iso3, p.nombre]));
  const filas = Object.entries(EXPOSICION)
    .map(([id, e]) => {
      const pts = D.mercado.get(id) ?? [];
      const u = ultimo(pts);
      const hist = pts.filter((p) => p.fecha >= restarDias(u?.fecha ?? '2000-01-01', 730));
      return {
        id,
        nombre: e.nombre,
        valor: r2(u?.valor ?? null),
        fecha: u?.fecha ?? null,
        var1m: r1(varPct(pts, 31)),
        var1a: r1(varPct(pts, 365)),
        percentil2a: percentil(hist, u?.valor ?? null),
        ...(() => {
          const ult6 = pts.filter((p) => p.fecha >= restarDias(u?.fecha ?? '2000-01-01', 183));
          const mx = ult6.reduce<Pt | null>((m, p) => (!m || p.valor > m.valor ? p : m), null);
          return { max6m: r2(mx?.valor ?? null), max6mFecha: mx?.fecha ?? null, desdeMax: mx && u ? r1((u.valor / mx.valor - 1) * 100) : null };
        })(),
        exportadores: e.paises.map((iso) => nombres.get(iso) ?? iso),
        spark: semanal(pts, restarDias(u?.fecha ?? '2000-01-01', 365)).map((p) => p.valor),
      };
    })
    .filter((f) => f.valor != null);
  const lecturas: string[] = [];
  const brent = filas.find((f) => f.id === 'BRENT');
  if (brent) {
    const revierte = (brent.var1a ?? 0) > 15 && (brent.desdeMax ?? 0) <= -15;
    lecturas.push(
      `Brent US$ ${fmt(brent.valor)} (${sg(brent.var1m)}% en el mes, ${sg(brent.var1a)}% interanual): ` +
        (revierte
          ? `el shock de precio se está revirtiendo (${sg(brent.desdeMax, 0)}% desde el máximo de US$ ${fmt(brent.max6m)} del ${fTxt(brent.max6mFecha)}), pero sigue muy por encima de hace un año: alivio parcial para importadores de energía, la inflación importada tarda en ceder.`
          : (brent.var1a ?? 0) > 15
            ? 'shock de precio que favorece a exportadores de energía y presiona la inflación de importadores.'
            : (brent.var1a ?? 0) < -15
              ? 'alivio para importadores de energía y presión fiscal para exportadores.'
              : 'sin shock relevante.'),
    );
  }
  const fuertes = filas.filter((f) => Math.abs(f.var1a ?? 0) >= 20 && f.id !== 'BRENT' && f.id !== 'WTI');
  for (const f of fuertes)
    lecturas.push(`${f.nombre} ${sg(f.var1a)}% interanual → ${f.var1a! > 0 ? 'viento a favor' : 'viento en contra'} para ${f.exportadores.join(', ') || 'sus exportadores'}.`);
  return { filas, lecturas };
}

function seccionGeo(D: Datos) {
  const porPais = new Map<string, { nombre: string; pts: { f: string; i: number; t: number }[] }>();
  for (const g of D.geo) {
    if (!porPais.has(g.iso3)) porPais.set(g.iso3, { nombre: g.nombre_es, pts: [] });
    porPais.get(g.iso3)!.pts.push({ f: g.f, i: Number(g.i), t: Number(g.t) });
  }
  const filas = [...porPais.entries()]
    .map(([iso3, x]) => {
      const u = x.pts[x.pts.length - 1];
      const prev = x.pts.length > 1 ? x.pts[x.pts.length - 2] : null;
      return { iso3, pais: x.nombre, fecha: u.f, intensidad: Math.round(u.i), tono: r2(u.t), cambio: prev && prev.i > 0 ? r1((u.i / prev.i - 1) * 100) : null };
    })
    .sort((a, b) => (a.tono ?? 0) - (b.tono ?? 0));
  const lecturas: string[] = [];
  if (filas.length) {
    lecturas.push(
      `Tono de cobertura más negativo (GDELT, última semana): ${filas.slice(0, 3).map((f) => `${f.pais} ${fmt(f.tono, 1)}`).join(', ')}. La intensidad mide volumen de noticias y sobre-representa a países con mucha prensa en inglés.`,
    );
  }
  const mecaG = D.agregados.get('MECA')?.ind.get('gdp_growth');
  return { filas, lecturas, disponible: filas.length > 0, mecaCrecimiento: mecaG ? r1(mecaG.get(new Date().getUTCFullYear()) ?? null) : null };
}

/** Ranking de vulnerabilidad macro-financiera (z-scores con signo de estrés). */
function seccionVulnerabilidad(D: Datos, Y: number, deuda: ReturnType<typeof seccionDeuda>, fx: ReturnType<typeof seccionFx>, monet: ReturnType<typeof seccionMonetario>) {
  const A = D.anual;
  const dmap = new Map(deuda.filas.map((f) => [f.iso3, f]));
  const fxmap = new Map(fx.filas.map((f) => [f.iso3, f]));
  const mmap = new Map(monet.filas.map((f) => [f.iso3, f]));
  for (const iso of EURO) if (mmap.has('DEU')) mmap.set(iso, mmap.get('DEU')!);
  // Componentes: [clave, nombre, peso, valor(p), signo (+1 = más alto es más riesgo)]
  const comp: { k: string; nombre: string; peso: number; v: (iso: string) => number | null; s: 1 | -1 }[] = [
    { k: 'deuda', nombre: 'Deuda/PIB', peso: 0.2, v: (i) => dmap.get(i)?.deuda ?? null, s: 1 },
    { k: 'trayectoria', nombre: 'Δ deuda proyectada', peso: 0.15, v: (i) => dmap.get(i)?.cambio ?? null, s: 1 },
    { k: 'fiscal', nombre: 'Balance fiscal', peso: 0.15, v: (i) => A.get('fiscal_balance')?.get(i)?.get(Y) ?? null, s: -1 },
    { k: 'externo', nombre: 'Cuenta corriente', peso: 0.15, v: (i) => A.get('current_account')?.get(i)?.get(Y) ?? null, s: -1 },
    { k: 'inflacion', nombre: 'Inflación', peso: 0.15, v: (i) => { const x = A.get('cpi_yoy')?.get(i)?.get(Y); return x == null ? null : Math.log1p(Math.max(0, x)); }, s: 1 },
    { k: 'fx', nombre: 'Depreciación 1 año', peso: 0.1, v: (i) => fxmap.get(i)?.var1a ?? null, s: 1 },
    { k: 'crecimiento', nombre: 'Crecimiento', peso: 0.1, v: (i) => A.get('gdp_growth')?.get(i)?.get(Y) ?? null, s: -1 },
  ];
  const stats = comp.map((c) => {
    const xs = D.paises.map((p) => c.v(p.iso3)).filter((x): x is number => x != null && Number.isFinite(x));
    const m = mean(xs) ?? 0;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)) || 1;
    return { m, sd };
  });
  const filas = D.paises
    .map((p) => {
      let suma = 0, pesos = 0;
      const zs: Record<string, number | null> = {};
      comp.forEach((c, i) => {
        const v = c.v(p.iso3);
        if (v == null || !Number.isFinite(v)) { zs[c.k] = null; return; }
        const z = Math.max(-2.5, Math.min(2.5, ((v - stats[i].m) / stats[i].sd) * c.s));
        zs[c.k] = r2(z);
        suma += z * c.peso;
        pesos += c.peso;
      });
      if (pesos < 0.6) return null; // muy poca información → no se rankea
      const zTot = suma / pesos;
      const score = Math.round(Math.max(0, Math.min(100, 50 + zTot * 25)));
      const principales = comp
        .map((c) => ({ nombre: c.nombre, z: zs[c.k] }))
        .filter((x) => x.z != null && x.z > 0.75)
        .sort((a, b) => b.z! - a.z!)
        .slice(0, 3)
        .map((x) => x.nombre);
      return { iso3: p.iso3, pais: p.nombre, region: p.region, score, componentes: zs, cobertura: Math.round(pesos * 100), principales, tasaReal: mmap.get(p.iso3)?.real ?? null };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => b.score - a.score);
  const top = filas.slice(0, 5);
  return {
    pesos: comp.map((c) => ({ clave: c.k, nombre: c.nombre, peso: c.peso })),
    filas,
    lecturas: top.length
      ? [`Más vulnerables según el ranking compuesto: ${top.map((f) => `${f.pais} ${f.score}${f.principales.length ? ` (${f.principales.map((x) => (/^[A-ZÁÉÍÓÚ]/.test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x)).join(', ')})` : ''}`).join('; ')}.`]
      : [],
  };
}

// ── semáforo, alertas, riesgos y tesis ────────────────────────────────────
interface Alerta {
  id: string;
  nivel: Sev;
  categoria: string;
  titulo: string;
  detalle: string;
  tab: string;
}

export async function construirAnalisis() {
  const D = await cargar();
  const Y = new Date().getUTCFullYear();
  const ciclo = seccionCiclo(D, Y);
  const inflacion = seccionInflacion(D, Y);
  const monetario = seccionMonetario(D, Y);
  const condiciones = seccionCondiciones(D);
  const deuda = seccionDeuda(D, Y);
  const externo = seccionExterno(D, Y);
  const fx = seccionFx(D, monetario);
  const commodities = seccionCommodities(D);
  const geopolitica = seccionGeo(D);
  const vulnerabilidad = seccionVulnerabilidad(D, Y, deuda, fx, monetario);

  // ── Alertas (reglas explícitas) ──
  const alertas: Alerta[] = [];
  const A = (a: Alerta) => alertas.push(a);
  const c = new Map(condiciones.indicadores.map((i) => [i.id, i]));
  const vix = c.get('VIX');
  if (vix?.valor != null && vix.valor >= 20)
    A({ id: 'vix', nivel: vix.valor >= 30 ? 'alta' : 'media', categoria: 'mercados', titulo: `VIX en ${fmt(vix.valor)}`, detalle: `Volatilidad implícita por encima de 20 (percentil ${vix.percentil} desde ${vix.desde}).`, tab: 'fx' });
  const hy = c.get('HY_OAS');
  if (hy?.valor != null && (hy.valor >= 450 || (hy.var1m ?? 0) >= 75))
    A({ id: 'hy', nivel: hy.valor >= 600 ? 'alta' : 'media', categoria: 'crédito', titulo: `Spread high yield ${fmt(hy.valor, 0)} pb`, detalle: `${sg(hy.var1m, 0)} pb en el mes; umbrales 450 pb (nivel) o +75 pb (mes).`, tab: 'analisis' });
  const em = c.get('EM_OAS');
  if (em?.valor != null && (em.var1m ?? 0) >= 50)
    A({ id: 'em', nivel: 'media', categoria: 'crédito', titulo: `Spread corporativo EM ${sg(em.var1m, 0)} pb en el mes`, detalle: `Nivel ${fmt(em.valor, 0)} pb.`, tab: 'analisis' });
  const cu = condiciones.curva;
  if (cu.pend10y2y != null && cu.pend10y2y < 0)
    A({ id: 'curva', nivel: 'media', categoria: 'tasas', titulo: `Curva del Tesoro invertida (${sg(cu.pend10y2y, 0)} pb)`, detalle: '10A − 2A negativo: históricamente antecede recesiones en EE.UU.', tab: 'riesgo' });
  if (cu.y10 != null && (cu.pctl10 ?? 0) >= 90)
    A({ id: 'ust10', nivel: cu.y10 >= 5 ? 'alta' : 'media', categoria: 'tasas', titulo: `Tesoro 10A en ${fmt(cu.y10, 2)}%`, detalle: `${maxTxt(cu)}. Encarece el financiamiento global y presiona a emergentes.`, tab: 'riesgo' });
  if (condiciones.usd3m != null && condiciones.usd3m >= 3)
    A({ id: 'usd', nivel: 'media', categoria: 'fx', titulo: `Dólar amplio ${sg(condiciones.usd3m)}% en 3 meses`, detalle: 'Fortaleza del USD: endurece condiciones para emergentes con deuda en dólares.', tab: 'fx' });
  for (const f of fx.filas)
    if (f.var1m != null && f.var1m >= 5)
      A({ id: `fx_${f.par}`, nivel: f.var1m >= 10 ? 'alta' : 'media', categoria: 'fx', titulo: `${f.pais}: la moneda se deprecia ${fmt(f.var1m)}% frente al USD en el mes`, detalle: `${f.par} ${fmt(f.valor, 2)} · ${sg(f.var3m)}% en 3 meses (umbral: 5% mensual).`, tab: 'fx' });
  const brent = commodities.filas.find((f) => f.id === 'BRENT');
  if (brent && ((brent.var1m ?? 0) >= 15 || (brent.valor ?? 0) >= 100 || (brent.var1a ?? 0) >= 30))
    A({ id: 'brent', nivel: (brent.valor ?? 0) >= 100 ? 'alta' : 'media', categoria: 'commodities', titulo: `Brent US$ ${fmt(brent.valor)} (${sg(brent.var1a)}% a/a)`, detalle: `Umbrales: +15% mensual, +30% interanual o US$ 100. Presión inflacionaria para importadores netos de energía.`, tab: 'fx' });
  for (const r of ciclo.enContraccion)
    A({ id: `rec_${r.codigo}`, nivel: (r.crecimiento ?? 0) <= -2 ? 'alta' : 'media', categoria: 'actividad', titulo: `${r.nombre}: PIB ${fmt(r.crecimiento)}% en ${Y} (FMI)`, detalle: r.siguiente != null ? `Proyección ${Y + 1}: ${sg(r.siguiente)}%.` : 'Contracción regional.', tab: 'analisis' });
  if (ciclo.mundo.crecimiento != null && ciclo.mundo.promedio1519 != null && ciclo.mundo.crecimiento < ciclo.mundo.promedio1519 - 0.3)
    A({ id: 'mundo', nivel: 'info', categoria: 'actividad', titulo: `Crecimiento mundial ${fmt(ciclo.mundo.crecimiento)}% < promedio 2015–19`, detalle: `Promedio 2015–19: ${fmt(ciclo.mundo.promedio1519)}%.`, tab: 'analisis' });
  const inf10 = inflacion.filas.filter((f) => (f.inflacion ?? 0) >= 10);
  if (inf10.length)
    A({ id: 'inf10', nivel: 'media', categoria: 'inflación', titulo: `${inf10.length} economías con inflación ≥10%`, detalle: inf10.map((f) => `${f.pais} ${fmt(f.inflacion)}%`).join(', '), tab: 'tasas' });
  if (inflacion.mundo != null && inflacion.mundoAnterior != null && inflacion.mundo - inflacion.mundoAnterior >= 0.3)
    A({ id: 'infmundo', nivel: 'media', categoria: 'inflación', titulo: `Repunte de la inflación mundial: ${fmt(inflacion.mundoAnterior)}% → ${fmt(inflacion.mundo)}%`, detalle: `FMI, ${Y - 1}→${Y}. ${inflacion.acelera} economías del tablero aceleran.`, tab: 'tasas' });
  const realNeg = monetario.filas.filter((f) => (f.real ?? 0) <= -2);
  if (realNeg.length)
    A({ id: 'realneg', nivel: 'media', categoria: 'política monetaria', titulo: `Tasa real ≤ −2% en ${realNeg.length} economía(s)`, detalle: realNeg.map((f) => `${f.pais} ${sg(f.real)}%`).join(', '), tab: 'tasas' });
  if (monetario.fase === 'giro restrictivo' || monetario.fase === 'endurecimiento')
    A({ id: 'monet', nivel: monetario.fase === 'giro restrictivo' ? 'media' : 'info', categoria: 'política monetaria', titulo: `Ciclo monetario: ${monetario.fase}`, detalle: `${monetario.subas3} subas y ${monetario.recortes3} recortes en los últimos 3 meses (${monetario.bancos} bancos centrales).`, tab: 'analisis' });
  if (deuda.preocupantes.length)
    A({ id: 'deuda', nivel: 'media', categoria: 'fiscal', titulo: `Deuda ≥90% del PIB y en ascenso: ${deuda.preocupantes.length} economías`, detalle: deuda.filas.filter((f) => deuda.preocupantes.includes(f.iso3)).map((f) => f.pais).join(', '), tab: 'analisis' });
  const caidas = D.fuentes.filter((f) => f.estado === 'down');
  if (caidas.length)
    A({ id: 'fuentes', nivel: 'info', categoria: 'datos', titulo: `Fuente(s) caída(s): ${caidas.map((f) => f.proveedor).join(', ')}`, detalle: 'Sus paneles muestran el último dato válido o s/d.', tab: 'resumen' });
  const ordenSev: Record<Sev, number> = { alta: 0, media: 1, info: 2 };
  alertas.sort((a, b) => ordenSev[a.nivel] - ordenSev[b.nivel]);

  // ── Semáforo por dimensión ──
  const g = ciclo.mundo.crecimiento;
  const semaforo: { id: string; dimension: string; nivel: Nivel; valor: string; lectura: string; tab: string }[] = [
    {
      id: 'actividad',
      dimension: 'Actividad global',
      nivel: g == null ? 'sd' : g >= 3.3 ? 'verde' : g >= 2.5 ? 'ambar' : 'rojo',
      valor: g == null ? 's/d' : `${fmt(g)}% ${Y}`,
      lectura: ciclo.lecturas[0] ?? 'Sin dato del FMI.',
      tab: 'analisis',
    },
    {
      id: 'inflacion',
      dimension: 'Inflación',
      nivel: inflacion.mundo == null ? 'sd' : inflacion.mundo <= 3.5 && inflacion.mundo <= (inflacion.mundoAnterior ?? 99) ? 'verde' : inflacion.mundo >= 5 || inflacion.mundo - (inflacion.mundoAnterior ?? inflacion.mundo) >= 0.3 ? 'rojo' : 'ambar',
      valor: inflacion.mundo == null ? 's/d' : `${fmt(inflacion.mundo)}% mundo`,
      lectura: inflacion.lecturas[0] ?? '',
      tab: 'tasas',
    },
    {
      id: 'monetaria',
      dimension: 'Política monetaria',
      nivel: monetario.fase === 'relajamiento' || monetario.fase === 'giro expansivo' ? 'verde' : monetario.fase === 'pausa' ? 'ambar' : 'rojo',
      valor: monetario.fase,
      lectura: monetario.lecturas[0] ?? '',
      tab: 'tasas',
    },
    {
      id: 'condiciones',
      dimension: 'Condiciones financieras',
      nivel: condiciones.indice == null ? 'sd' : condiciones.indice >= 65 ? 'rojo' : condiciones.indice >= 40 ? 'ambar' : 'verde',
      valor: condiciones.indice == null ? 's/d' : `${condiciones.indice}/100`,
      lectura: condiciones.lecturas[0] ?? '',
      tab: 'analisis',
    },
    {
      id: 'tasas',
      dimension: 'Tasas largas EE.UU.',
      nivel: cu.y10 == null ? 'sd' : (cu.pctl10 ?? 0) >= 90 || (cu.pend10y2y ?? 1) < 0 ? 'rojo' : (cu.pctl10 ?? 0) >= 70 ? 'ambar' : 'verde',
      valor: cu.y10 == null ? 's/d' : `${fmt(cu.y10, 2)}% 10A`,
      lectura: condiciones.lecturas.find((l) => l.startsWith('Tesoro')) ?? '',
      tab: 'riesgo',
    },
    {
      id: 'fx',
      dimension: 'Dólar y monedas emergentes',
      nivel: fx.mediana3m == null ? 'sd' : fx.mediana3m >= 3 || (condiciones.usd3m ?? 0) >= 4 ? 'rojo' : fx.mediana3m >= 1 || (condiciones.usd3m ?? 0) >= 2 ? 'ambar' : 'verde',
      valor: fx.mediana3m == null ? 's/d' : `${sg(fx.mediana3m)}% 3M`,
      lectura: [fx.lecturas[0], condiciones.lecturas.find((l) => l.startsWith('Dólar'))].filter(Boolean).join(' '),
      tab: 'fx',
    },
    {
      id: 'fiscal',
      dimension: 'Sostenibilidad fiscal',
      nivel: deuda.filas.length === 0 ? 'sd' : deuda.preocupantes.length >= 4 ? 'rojo' : deuda.preocupantes.length >= 1 ? 'ambar' : 'verde',
      valor: `${deuda.preocupantes.length} en riesgo`,
      lectura: deuda.lecturas[0] ?? '',
      tab: 'analisis',
    },
    {
      id: 'energia',
      dimension: 'Energía y commodities',
      nivel: !brent
        ? 'sd'
        : ((brent.var1a ?? 0) >= 30 || (brent.valor ?? 0) >= 100) && (brent.desdeMax ?? 0) > -15
          ? 'rojo'
          : (brent.var1a ?? 0) >= 10 || (brent.var1m ?? 0) >= 10
            ? 'ambar'
            : 'verde',
      valor: brent ? `Brent ${fmt(brent.valor, 0)}` : 's/d',
      lectura: commodities.lecturas[0] ?? '',
      tab: 'fx',
    },
    {
      id: 'geopolitica',
      dimension: 'Geopolítica',
      nivel: ciclo.enContraccion.some((r) => (r.crecimiento ?? 0) <= -2) ? 'rojo' : ciclo.enContraccion.length || geopolitica.disponible ? 'ambar' : 'sd',
      valor: ciclo.enContraccion.length ? `${ciclo.enContraccion.length} región(es) en contracción` : geopolitica.disponible ? 'GDELT' : 's/d',
      lectura: ciclo.enContraccion.length
        ? `El FMI proyecta contracción en ${ciclo.enContraccion.map((r) => `${r.nombre} (${fmt(r.crecimiento)}%)`).join(', ')}; ${geopolitica.lecturas[0] ?? 'sin lectura de cobertura de prensa (GDELT s/d).'}`
        : (geopolitica.lecturas[0] ?? 'GDELT sin datos en esta corrida.'),
      tab: 'conflictos',
    },
  ];

  // ── Riesgos (balance de riesgos derivado de las reglas) ──
  const riesgos: { id: string; titulo: string; sesgo: 'bajista' | 'alcista'; evidencia: string }[] = [];
  if (brent && (brent.var1a ?? 0) >= 15)
    riesgos.push({ id: 'energia', titulo: 'Shock energético persistente', sesgo: 'bajista', evidencia: `Brent ${sg(brent.var1a)}% interanual; inflación mundial ${fmt(inflacion.mundoAnterior)}→${fmt(inflacion.mundo)}%.` });
  if (brent && (brent.desdeMax ?? 0) <= -15)
    riesgos.push({ id: 'petroleo', titulo: 'Normalización más rápida del petróleo', sesgo: 'alcista', evidencia: `Brent ${sg(brent.desdeMax, 0)}% desde su máximo de US$ ${fmt(brent.max6m)} (${fTxt(brent.max6mFecha)}): aliviaría la inflación importada.` });
  if (cu.y10 != null && (cu.pctl10 ?? 0) >= 85)
    riesgos.push({ id: 'tasas', titulo: 'Tasas largas altas por más tiempo', sesgo: 'bajista', evidencia: `UST 10A ${fmt(cu.y10, 2)}% (percentil ${cu.pctl10}); ${deuda.filas.filter((f) => (f.rg ?? -1) > 0).length} economías con r − g > 0.` });
  if (condiciones.indice != null && condiciones.indice <= 40 && cu.y10 != null && (cu.pctl10 ?? 0) >= 85)
    riesgos.push({ id: 'complacencia', titulo: 'Complacencia en crédito frente a tasas altas', sesgo: 'bajista', evidencia: `Spreads en percentiles bajos (HY ${hy?.percentil ?? 's/d'}) mientras el 10A está en percentil ${cu.pctl10}: poco colchón ante un repricing.` });
  if (deuda.preocupantes.length)
    riesgos.push({ id: 'deuda', titulo: 'Dinámica de deuda en economías grandes', sesgo: 'bajista', evidencia: `Deuda ≥90% y creciente: ${deuda.filas.filter((f) => deuda.preocupantes.includes(f.iso3)).map((f) => f.pais).join(', ')}.` });
  if (ciclo.enContraccion.length)
    riesgos.push({ id: 'regional', titulo: 'Contagio de la contracción regional', sesgo: 'bajista', evidencia: ciclo.enContraccion.map((r) => `${r.nombre} ${fmt(r.crecimiento)}% en ${Y}`).join('; ') + '.' });
  if (ciclo.enContraccion.some((r) => (r.siguiente ?? 0) > 2))
    riesgos.push({ id: 'rebote', titulo: 'Rebote más rápido de lo previsto en la región afectada', sesgo: 'alcista', evidencia: ciclo.enContraccion.map((r) => `${r.nombre}: FMI proyecta ${sg(r.siguiente)}% en ${Y + 1}`).join('; ') + '.' });
  if (monetario.recortaron12 > monetario.subieron12)
    riesgos.push({ id: 'relajamiento', titulo: 'Relajamiento monetario acumulado', sesgo: 'alcista', evidencia: `${monetario.recortaron12} bancos centrales recortaron en 12 meses vs ${monetario.subieron12} que subieron.` });
  const em1 = fx.filas.filter((f) => (f.var3m ?? 0) < -2);
  if (em1.length >= 3) riesgos.push({ id: 'emfx', titulo: 'Apreciación de monedas emergentes', sesgo: 'alcista', evidencia: `${em1.length} monedas se apreciaron más de 2% en 3 meses.` });

  // ── Tesis (titular + puntos, todo derivado) ──
  const min = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
  const rojo = semaforo.filter((s) => s.nivel === 'rojo').map((s) => min(s.dimension));
  const verde = semaforo.filter((s) => s.nivel === 'verde').map((s) => min(s.dimension));
  const titular =
    g != null
      ? `Mundo creciendo ${fmt(g)}% en ${Y} con inflación ${inflacion.mundo != null && inflacion.mundoAnterior != null && inflacion.mundo > inflacion.mundoAnterior ? 'en repunte' : 'cediendo'} (${fmt(inflacion.mundo)}%)${cu.y10 != null ? `, Tesoro 10A en ${fmt(cu.y10, 2)}%` : ''}${brent ? ` y Brent en US$ ${fmt(brent.valor, 0)}` : ''}.`
      : 'Datos insuficientes para la tesis (fuentes s/d).';
  const tesis = {
    titular,
    focos: rojo.length ? `En rojo: ${rojo.join(', ')}.` : 'Ninguna dimensión en rojo.',
    apoyos: verde.length ? `A favor: ${verde.join(', ')}.` : 'Sin dimensiones claramente favorables.',
    puntos: [ciclo.lecturas[0], inflacion.lecturas[0], monetario.lecturas[0], condiciones.lecturas[0], condiciones.lecturas.find((l) => l.startsWith('Tesoro')), deuda.lecturas[0], commodities.lecturas[0], fx.lecturas[0]].filter(
      (x): x is string => !!x,
    ),
  };

  const corteMercado = [...D.mercado.values()].map((p) => ultimo(p)?.fecha ?? '').sort().pop() ?? null;
  return {
    generado: new Date().toISOString(),
    /** false mientras la base está vacía o la primera ingesta va a medias */
    completo: ciclo.agregados.length > 0 && monetario.bancos > 0 && condiciones.indicadores.length > 0,
    corte: { mercados: corteMercado, monetario: monetario.corte, weo: `FMI WEO · año base ${Y}` },
    tesis,
    semaforo,
    alertas,
    riesgos,
    ciclo,
    inflacion,
    monetario,
    condiciones,
    deuda,
    externo,
    fx,
    commodities,
    geopolitica,
    vulnerabilidad,
  };
}

// Caché en memoria: el análisis cambia sólo cuando hay ingesta nueva.
let cache: { t: number; v: Awaited<ReturnType<typeof construirAnalisis>> } | null = null;
/** ¿El análisis tiene lo esencial? (base recién aprovisionada o ingesta a medias → no) */
export const analisisCompleto = (a: Awaited<ReturnType<typeof construirAnalisis>>) =>
  a.ciclo.agregados.length > 0 && a.monetario.bancos > 0 && a.condiciones.indicadores.length > 0;
export async function analisis() {
  const ttl = cache && analisisCompleto(cache.v) ? 10 * 60_000 : 30_000;
  if (cache && Date.now() - cache.t < ttl) return cache.v;
  const v = await construirAnalisis();
  cache = { t: Date.now(), v };
  return v;
}
export const invalidarAnalisis = () => {
  cache = null;
};
export async function alertas() {
  return (await analisis()).alertas;
}
