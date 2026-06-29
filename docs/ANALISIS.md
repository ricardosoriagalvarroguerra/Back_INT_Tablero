# Análisis · diseño, guardrails y estado de datos · Tablero INT

Documento vivo que explica las decisiones de arquitectura, cómo se materializan
los guardrails (§8) y el estado real de los datos por vista (qué está en vivo,
qué degrada a `s/d` y por qué). Complementa [`SOURCES.md`](SOURCES.md).

## Arquitectura (full-stack)

```
React 18 + Vite + TS + Tailwind  ──/api──▶  Fastify 5 + pg  ──▶  PostgreSQL "internacional"
  · D3 tematizado (heatmap, líneas,           · rutas por vista        · dimensional:
    correlaciones, barras, sparkline)         · repo.ts (SQL→payload)    dim_country/indicator/source
  · filtros globales (región/grupo/ventana)   · resolveLive (YouTube)    fact_timeseries/market/trade/geo
  · provenance + frescura por panel           ▲                          vistas v_* (z-score, tasa real…)
                                              │
                          conectores idempotentes (server/src/connectors) ──▶ etl_run_log
                          WB · IMF · Yahoo · ECB · Comtrade · GDELT · (FRED opc.)
```

## Decisiones de diseño

- **Backend Node/Fastify + `pg`** (no Python/FastAPI del brief §2): homogeneidad con
  Tablero ARG/BOL (§7) — mismo patrón `server/routes` + `repo.ts`, reutilizable. *(decisión del usuario)*
- **D3 como motor único** (no Recharts/ECharts): cubre choropleth, heatmap, curvas y
  correlaciones; encaja con el ADN SVG-a-mano de ARG/BOL (su `Donut` ya usa d3). *(decisión del usuario)*
- **Esquema dimensional** `dim_country × dim_indicator × fact_*`: correcto para multipaís
  (los gemelos son monopaís y no lo necesitaban). Claves naturales → upsert idempotente.
- **Ingesta desacoplada**: cada fuente es un módulo en `connectors/`, orquestado por
  `ingest.ts` (runner simple, migrable a cron/APScheduler sin tocar los conectores).

## Guardrails (§8) — cómo se materializan

| Guardrail | Implementación |
|---|---|
| **Cero datos inventados** | `valor` nullable en BD; el front muestra `s/d`/"fuente caída" (`EstadoVacio`, `SD`); ningún mock disfrazado. |
| **Provenance + fecha de corte** | Cada payload lleva `prov {fuente, asof, estado}`; `FreshnessBadge` lo muestra por panel. |
| **Fallos de API robustos** | `http.ts`: timeout + reintentos + backoff + throttle por host. Conector que no obtiene nada lanza → `dim_source.estado='down'`. |
| **Fallback visible** | `useView` marca `offline`; el panel degrada con estado explícito, nunca pantalla rota. |
| **Idempotencia** | Upserts por clave natural vía `unnest` + `ON CONFLICT`; re-ejecutar la ingesta no duplica. |
| **Observabilidad** | `etl_run_log` (job, filas, estado, error, latencia) por corrida. |
| **Secretos solo en `.env`** | `env.ts`; `.env` en `.gitignore`; keys opcionales con degradado. |

## Estado de datos por vista (verificado 2026-06-20)

| Vista | Estado | Notas |
|---|---|---|
| ⊞ Resumen (inicial) | ✅ vivo | Cockpit que aglomera pulso, mercados, riesgo, conflicto, tasas reales y Bloomberg live; cada sección enlaza a su pestaña de detalle. |
| 1 Pulso global | ✅ vivo | Top movers de mercado + outliers macro (\|z\|) + conflicto. |
| 2 Heatmap macro | ✅ vivo | 7 indicadores × 42 países (WB+IMF); `policy_rate` poblado para 26 países (OECD). |
| 3 Riesgo soberano | ✅ vivo | Score macro+mercado+conflicto. Yields 10A: **EE.UU. vía FRED** (UST 10A/2A + pendiente de curva), **zona euro vía ECB** (spread vs Bund); resto del mundo vía OECD (oportunista). Spread con benchmark de la misma moneda. |
| 4 FX & commodities | ✅ vivo | 16 series (Yahoo+ECB), 36 correlaciones, régimen risk-on/off por VIX. |
| 5 Inflación y tasas reales | ✅ vivo | Inflación (WB/IMF) + tasa de política (OECD IRSTCI, 26 países) → tasa real ex-post. |
| 6 Comercio y flujos | ✅ vivo | 17 reporters (Comtrade 2022), totales + top-8 socios. |
| 7 Conflictos | ⚠️ parcial | GDELT con throttle 1/5s; en esta IP sólo resolvió 4 países (cooldown). |
| 8 Foco LatAm | ✅ vivo | Heatmap + tasas reales acotados a LatAm. |
| 9 Calendario | ✅ vivo | Próximos releases macro de EE.UU. (FRED release dates): CPI, empleo, PIB, PCE, PPI, ventas minoristas, producción industrial — fechas oficiales programadas (no inventadas). |
| 📺 Muro de medios | ✅ vivo | Bloomberg TV + grid configurable (`public/channels.json`), embed keyless. |

## Limitaciones conocidas y mejoras futuras

1. **Sesgo de volumen en GDELT**: la intensidad = volumen de cobertura, que sobre-representa a
   EE.UU./medios en inglés (de ahí su conflicto=100). Mejora: normalizar por volumen base o usar ACLED
   (fatalities geolocalizadas) con `ACLED_API_KEY`.
2. **Tasa de política y yields**: `policy_rate` vía **OECD IRSTCI** (26 países); yields 10A de
   **EE.UU. vía FRED** (UST 10A/2A + pendiente de curva) y de la **zona euro vía ECB IRS** (spread vs
   Bund). Para yields del resto del mundo, **OECD IRLT** los amplía pero su SDMX es inestable (500/429
   esporádicos): el conector trocea por lotes e idempotentemente completa en corridas sucesivas.
3. **Calendario**: poblado con releases macro de EE.UU. (FRED). Las **reuniones FOMC/BCE** no se pueden
   tomar limpias de FRED (el release "FOMC Press Release" con `no_data=false` no devuelve fechas futuras,
   y con `no_data=true` se rellena día a día) → requerirían el calendario oficial de la Fed/BCE (sin API
   keyless limpia); no se inventan. Ampliable también a releases de otras economías (Eurostat).
4. **Yields fuera de zona euro**: dependen de **OECD IRLT**, cuyo SDMX tuvo una caída amplia (500 en
   todos los lotes) durante esta sesión. El conector (lotes + throttle + idempotente) los completa en una
   corrida posterior cuando OECD se recupera; entretanto, EE.UU. (FRED) + zona euro (ECB) quedan firmes.
5. **Conectores opcionales pendientes**: Eurostat (releases UE) y Frankfurter (FX majors, hoy redundante con Yahoo).
6. **IMF sobre-escribe a WB** en celdas macro solapadas (orden de ingesta intencional: WEO es la fuente
   curada cross-country). El `source_id` por fila mantiene la trazabilidad.

> **Choropleth mundial** ✅ implementado: `npm run gen:map` (world-110m TopoJSON → d3-geo Equal Earth →
> `src/data/worldGeo.ts`) + `WorldMap.tsx`, usado en el tracker de conflictos y en el cockpit Resumen.

## Cómo extender

- **Nuevo indicador macro**: alta en `dim_indicator` (seed) + mapeo en el connector (`MAP`).
- **Nueva fuente**: alta en `dim_source` (seed) + módulo en `connectors/` + línea en `ingest.ts`.
- **Nuevo canal de medios**: editar `public/channels.json` (sin recompilar).
- **Nueva vista**: tipo en `types.ts` → consulta en `repo.ts` → ruta en `routes.ts` → panel + pestaña.
