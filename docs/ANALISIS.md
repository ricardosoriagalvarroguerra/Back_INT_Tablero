# Análisis · metodología, guardrails y estado de datos · Tablero INT v0.9

Documento vivo. Explica **cómo el tablero convierte datos en lectura económica**
(capa analítica), los umbrales de cada regla, la arquitectura, los guardrails y el
estado real de cada fuente. Complementa [`SOURCES.md`](SOURCES.md).

> **Regla de oro: cero datos inventados.** Las lecturas son *plantillas* que se
> rellenan con datos de la BDR. Ningún texto describe el estado del mundo escrito
> a mano: si cambia el dato, cambia la lectura. Sin dato → `s/d`.

## Arquitectura

```
React 18 + Vite + TS + Tailwind ──/api──▶ Fastify 5 + pg ──▶ PostgreSQL "internacional"
  · pestañas Resumen, Análisis, Histórico…   · bootstrap.ts: aprovisiona la BDR      · dim_country / indicator / source / aggregate
  · respaldo embebido (snapshot.json)         · pipeline.ts: ingesta al arrancar      · fact_timeseries / market / aggregate / trade / geo
  · nota ejecutiva imprimible (N)             │   y cada INGEST_INTERVAL_HOURS (6 h)  · etl_run_log · seed_meta · vistas v_*
  · frescura por fuente (pie)                 · analisis.ts: capa analítica (caché 10 min, se invalida tras cada ingesta)
                                              ▲
            conectores idempotentes: World Bank · FMI (WEO) · BIS · FRED · Yahoo · OCDE · BCE · Comtrade · GDELT
```

- **Auto-aprovisionamiento** (`src/bootstrap.ts`): al arrancar compara el hash de `db/schema.sql`
  y `db/seed.sql` con `seed_meta.version`. Base vacía o esquema cambiado → aplica ambos
  (el esquema reinicia `public`; los hechos se recargan con la ingesta que sigue). Sólo cambió
  el seed → re-aplica el seed (idempotente) sin borrar hechos. Transacción + advisory lock.
  `DB_AUTO_SEED=false` lo desactiva.
- **Ingesta programada** (`src/pipeline.ts`): al arrancar (todas las fuentes) y cada
  `INGEST_INTERVAL_HOURS` (Comtrade, lento y anual, cada 4 corridas). Candado en memoria +
  `pg_try_advisory_lock` para no superponer corridas entre réplicas. `INGEST_ON_START=false`
  la desactiva. Disparo manual: `POST /api/ingesta` con `Authorization: Bearer $INGEST_TOKEN`
  (cuerpo opcional `{"fuentes":["bis","fred"]}`); estado: `GET /api/ingesta`.
- **Respaldo embebido** (frontend): `npm run snapshot` congela las respuestas del API
  (incluido el histórico de los 42 países) en `src/data/snapshot.json`. Se descarga sólo si el
  API no responde (chunk aparte) y el encabezado avisa «Respaldo al …» con su fecha.

## Endpoints nuevos (v0.9)

| Ruta | Contenido |
|---|---|
| `GET /api/analisis` | Tesis, semáforo, alertas, riesgos y las secciones de abajo |
| `GET /api/alertas` | Sólo las alertas activas |
| `GET /api/historico/:iso3` | Indicadores anuales 2015→horizonte WEO (tipo `obs`/`est`/`proy`), tasa de política mensual y 10A mensual |
| `GET /api/agregados` | Agregados oficiales del FMI (mundo, avanzadas, emergentes, LatAm…) |
| `GET /api/ingesta` · `POST /api/ingesta` | Última corrida por job · disparo manual con token |
| `GET /api/fuentes` | + `ultimoDato` y `periodicidad` por fuente (frescura) |

## Capa analítica (`src/analisis.ts`)

Convenciones: `Y` = año en curso. En series anuales del FMI, `Y` es **estimación** (`e`) y
`Y+1…` **proyección** (`p`, punteada en los gráficos). El «último dato» de un indicador anual
nunca es una proyección futura (`v_indicator_latest` corta en el año en curso).

### 1. Ciclo global
- Fuente: agregados **oficiales** del FMI WEO (`WEOWORLD`, `ADVEC`, `OEMDC`, `WE`, `EURO`, `DA`,
  `MECA`, `SSA`, `MAE`, `SMQ`, `EDE`) — no se recalculan aquí.
- Lecturas: crecimiento mundial `Y` vs `Y−1` y vs promedio 2015–19 (tolerancia ±0,15 pp);
  diferencial emergentes − avanzadas; regiones en contracción en `Y` y su rebote proyectado.

### 2. Inflación
- Inflación promedio anual del FMI (`PCPIPCH`) en `Y` para las 42 economías.
- Mediana, cuántas aceleran / desaceleran (cambio > ±0,3 pp vs `Y−1`), cuántas ≥ 5% y ≥ 10%.
- **No** se usan metas de inflación (no hay fuente abierta homogénea): la comparación es contra
  la propia historia y la sección cruzada.

### 3. Ciclo monetario (BIS)
- Tasa de política fin de mes (BIS `WS_CBPOL`), un banco por jurisdicción (zona euro = BCE, una vez).
- Por banco: tasa, cambio 3 y 12 meses, última decisión con cambio, inflación `Y` (FMI) y
  **tasa real** = tasa − inflación. **Postura**: real > 2% restrictiva · 0–2% neutral · < 0 expansiva.
- **Difusión mensual** (24 meses): cuántos bancos suben / recortan / mantienen vs el mes previo.
- **Fase** (neto = subas − recortes en los últimos 3 meses vs los 3 previos): neto > 0 tras ≤ 0 →
  *giro restrictivo*; neto > 0 → *endurecimiento*; neto < 0 tras ≥ 0 → *giro expansivo*;
  neto < 0 → *relajamiento*; 0 → *pausa*. Bancos con dato BIS de > 100 días se marcan `*` y no
  cuentan en los totales de 12 meses.

### 4. Condiciones financieras y curva
- Indicadores (FRED): VIX, spreads ICE BofA (high yield, grado de inversión, corporativo EM, en pb),
  NFCI (Chicago Fed), dólar amplio (DTWEXBGS), Tesoro 3M/2A/10A, real 10A (TIPS), breakeven 10A.
- **Percentil** de cada último valor frente a su historia desde 2015.
- **Índice de estrés propio** = promedio de percentiles de VIX, HY, EM y NFCI (0–100).
  ≥ 65 tensas · ≤ 35 holgadas · resto neutrales.
- Curva: pendientes 10A−2A y 10A−3M (pb); «máximo desde 2015» si percentil ≥ 98.

### 5. Dinámica de deuda pública
- Deuda bruta (`GGXWDG_NGDP`) en `Y` y al horizonte WEO (hasta `Y+5`); trayectoria creciente /
  decreciente si el cambio supera ±5 pp.
- **Crecimiento nominal esperado** `g` = promedio `Y+1…Y+3` de `(1+g_real)(1+π) − 1` (FMI).
- **r − g** con `r` = rendimiento soberano 10A (FRED/BCE/OCDE; sólo donde existe).
- **Balance global estabilizador** `b* = −d·g/(1+g)` (deuda/PIB constante, aproximación estándar
  de la restricción presupuestaria). **Brecha** = balance `Y` − `b*` (negativa: la deuda sube).
- Preocupantes: deuda ≥ 90% y Δ al horizonte > +5 pp.

### 6. Posición fiscal y externa
- Balance fiscal vs cuenta corriente (% PIB, `Y`), cuadrantes: déficits gemelos, déficit externo,
  déficit fiscal, superávits gemelos. Tamaño = PIB en US$ (`NGDPD`).

### 7. Monedas frente al USD
- 14 pares USD/xxx (Yahoo; respaldo FRED H.10). Variación 1m/3m/1a (positivo = depreciación),
  volatilidad anualizada 3M (log-retornos diarios), **carry** = tasa de política local − Fed (BIS),
  **carry/vol** con piso de volatilidad de 4% (evita ratios absurdos en monedas administradas).

### 8. Commodities y exposición
- Brent, WTI, gas Henry Hub, oro, cobre, soja, trigo (Yahoo; Brent/WTI con historia FRED).
- Variación 1m/1a, percentil de 2 años, máximo de 6 meses y distancia al máximo.
- **Reversión de shock**: si +15% a/a y ≥ 15% por debajo del máximo de 6 meses, la lectura y el
  semáforo lo tratan como shock en reversión (ámbar), no como shock vigente (rojo).
- Exposición: lista estática de exportadores netos principales del catálogo (conocimiento
  estructural, no un dato de mercado).

### 9. Ranking de vulnerabilidad macro-financiera
- z-score por componente sobre la sección cruzada del tablero, con signo de estrés, recortado a
  ±2,5. Pesos: deuda/PIB 20%, Δ deuda proyectada 15%, balance fiscal 15%, cuenta corriente 15%,
  inflación 15% (en log, para que la hiperinflación no domine), depreciación 1 año 10%,
  crecimiento 10%. Score = 50 + 25 × promedio ponderado → [0, 100]. Requiere ≥ 60% de cobertura.
- **No** es una calificación crediticia: ordena dónde mirar primero.

### Semáforo (9 dimensiones)

| Dimensión | Verde | Ámbar | Rojo |
|---|---|---|---|
| Actividad global | crecimiento mundial ≥ 3,3% | 2,5–3,3% | < 2,5% |
| Inflación | mundo ≤ 3,5% y no sube | resto | ≥ 5% o +0,3 pp vs año previo |
| Política monetaria | relajamiento / giro expansivo | pausa | endurecimiento / giro restrictivo |
| Condiciones financieras | índice < 40 | 40–64 | ≥ 65 |
| Tasas largas EE.UU. | percentil 10A < 70 | 70–89 | ≥ 90 o curva 10A−2A invertida |
| Dólar y monedas EM | mediana 3M < 1% y USD 3M < 2% | ≥ 1% o USD ≥ 2% | mediana ≥ 3% o USD ≥ 4% |
| Sostenibilidad fiscal | 0 preocupantes | 1–3 | ≥ 4 |
| Energía y commodities | Brent a/a < 10% | ≥ 10% a/a o +10% mes | ≥ 30% a/a o ≥ US$ 100 (sin reversión) |
| Geopolítica | — | región en contracción o GDELT disponible | región con PIB ≤ −2% |

### Alertas (reglas explícitas)

| Regla | Severidad |
|---|---|
| VIX ≥ 20 | media (alta ≥ 30) |
| Spread HY ≥ 450 pb o +75 pb en el mes | media (alta ≥ 600) |
| Spread corporativo EM +50 pb en el mes | media |
| Curva 10A−2A < 0 | media |
| Tesoro 10A en percentil ≥ 90 desde 2015 | media (alta si ≥ 5%) |
| Dólar amplio +3% en 3 meses | media |
| Moneda: depreciación ≥ 5% en el mes | media (alta ≥ 10%) |
| Brent +15% mes, +30% a/a o ≥ US$ 100 | media (alta ≥ 100) |
| Agregado FMI con PIB < 0 en `Y` | media (alta ≤ −2%) |
| Crecimiento mundial < promedio 2015–19 − 0,3 pp | info |
| Inflación ≥ 10% (agrupada) · repunte mundial ≥ +0,3 pp | media |
| Tasa real ≤ −2% (agrupada) | media |
| Fase monetaria restrictiva | media (giro) / info |
| Deuda ≥ 90% y Δ > +5 pp (agrupada) | media |
| Fuente caída en la última corrida | info |

### Tesis y balance de riesgos
- **Titular**: crecimiento mundial, inflación (repunte/cede), Tesoro 10A y Brent.
- **Focos / apoyos**: dimensiones en rojo / verde del semáforo.
- **Riesgos** a la baja y al alza: se activan por reglas (p.ej. shock energético si Brent ≥ +15% a/a;
  normalización del petróleo si cae ≥ 15% desde el máximo; tasas altas si percentil 10A ≥ 85;
  complacencia si el índice de estrés ≤ 40 con el 10A en percentil ≥ 85; rebote regional si el FMI
  proyecta > 2% tras una contracción; relajamiento si recortan más bancos de los que suben).

## Guardrails

| Guardrail | Implementación |
|---|---|
| Cero datos inventados | `valor` nullable; lecturas por plantilla; `s/d` explícito; respaldo = copia literal del API |
| Provenance y fecha de corte | `prov` por payload; fechas de corte en la tesis; `ultimoDato` por fuente |
| Proyecciones marcadas | tipo `obs`/`est`/`proy`; punteado y banda en gráficos; `proyeccion` aparte en el modal |
| Fallos de fuente | timeout + reintentos + backoff + throttle por host; un indicador/país caído no tumba al resto |
| Idempotencia | upserts por clave natural (`unnest` + `ON CONFLICT`) |
| Observabilidad | `etl_run_log` (job, filas, estado, error, disparador) + `GET /api/ingesta` |
| Secretos | sólo variables de entorno (`INGEST_TOKEN` comparado en tiempo constante) |

## Estado de datos (verificado 2026-11-17, ingesta local)

| Fuente | Estado | Notas |
|---|---|---|
| FMI WEO | ✅ | 9 indicadores × 42 países + 11 agregados, 2015→2031 |
| BIS | ✅ | 28 bancos centrales (31 países del catálogo: la tasa del BCE se asigna a 5 miembros), mensual desde 2015; ARG con último dato jun-2025 |
| FRED | ✅ keyless | 21 series vía `fredgraph.csv` (ya no requiere `FRED_API_KEY`, salvo el calendario) |
| Yahoo | ✅ / ⚠️ | 25 símbolos, 2 años; limita por IP (429): alterna `query2`/`query1` y FRED cubre lo principal |
| BCE | ✅ | EUR/USD y 10A de DEU/FRA/ITA/ESP/NLD |
| OCDE | ✅ / ⚠️ | 10A de ~19 países; el SDMX da 500 si un lote incluye un país sin datos → un país por consulta |
| World Bank | ✅ / ⚠️ | 502 esporádicos por indicador (se omite ese indicador en la corrida) |
| Comtrade | ⚠️ parcial | último año disponible por reporter (≤ 2 años atrás); el preview limita filas |
| GDELT | ⚠️ parcial | límite estricto 1 req/5 s; con saturación resuelve pocos países por corrida |
| Calendario (FRED API) | 🔑 | requiere `FRED_API_KEY` |

## Limitaciones conocidas

1. **GDELT** mide volumen y tono de prensa, no violencia: sobre-representa países con mucha prensa
   en inglés. ACLED (con `ACLED_API_KEY`) sería la mejora.
2. **Metas de inflación** y **calificaciones** soberanas no tienen fuente abierta homogénea: no se usan.
3. **r − g** usa el 10A de mercado como costo marginal, no el costo medio efectivo de la deuda.
4. **Yahoo** es una API no oficial; con 429 persistente quedan las series FRED (VIX, petróleo,
   S&P 500, 8 monedas) y el resto pasa a `s/d` hasta la próxima corrida.
5. Las fechas de reuniones de bancos centrales siguen fuera (sin fuente keyless limpia).

## Cómo extender

- **Nueva regla de alerta / semáforo**: `construirAnalisis()` en `src/analisis.ts` + fila en las
  tablas de arriba.
- **Nuevo indicador macro**: `dim_indicator` (seed) + mapeo en el conector (`MAP`).
- **Nueva fuente**: `dim_source` (seed) + módulo en `connectors/` + entrada en `JOBS` (`pipeline.ts`).
- **Refrescar el respaldo embebido**: con el API local poblado, `npm run snapshot` en el frontend.
