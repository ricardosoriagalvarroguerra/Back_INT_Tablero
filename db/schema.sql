-- ════════════════════════════════════════════════════════════════════════
-- Tablero Inteligente INT · Esquema dimensional (PostgreSQL)
-- Base de datos: internacional
--
-- Modelo dimensional / time-series explícito (no tablas ad-hoc):
--   dim_country     · catálogo de países (ISO-3, región, grupo)
--   dim_indicator   · catálogo de indicadores (código, unidad, frecuencia, polaridad)
--   dim_source      · catálogo de fuentes (proveedor, URL, licencia, última verificación)
--   fact_timeseries · hechos macro país×indicador×fecha (WB/IMF/OECD/Eurostat/FRED)
--   fact_market     · series de mercado (FX, commodities, índices, vol, yields, spreads)
--   fact_geo_events · eventos geopolíticos/conflicto (GDELT/ACLED)
--   etl_run_log     · observabilidad de la ingesta
--
-- Convenciones:
--   · Claves NATURALES únicas → ingesta idempotente (upsert, sin duplicar).
--   · Provenance por fila: source_id + ingested_at en cada hecho.
--   · Toda FK lleva índice. Vistas v_* entregan los cálculos derivados.
--   · Idempotente: reinicia el schema public (la base es dedicada al tablero).
-- ════════════════════════════════════════════════════════════════════════

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public AUTHORIZATION CURRENT_USER;
SET search_path = public;

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ────────────────────────────────────────────────────────────────────────
-- Tipos enumerados
-- ────────────────────────────────────────────────────────────────────────
CREATE TYPE region_geo    AS ENUM ('LatAm','Norteamérica','Europa','Asia','África','Oceanía','Medio Oriente');
CREATE TYPE grupo_pais    AS ENUM ('G7','G20','EM','avanzada','LatAm');
CREATE TYPE frecuencia    AS ENUM ('diaria','mensual','trimestral','anual');
CREATE TYPE polaridad     AS ENUM ('up','down','none');
CREATE TYPE estado_fuente AS ENUM ('ok','lag','live','cold','down');
CREATE TYPE auth_fuente   AS ENUM ('none','api_key','registration');
CREATE TYPE clase_mercado AS ENUM ('fx','commodity','indice','volatilidad','yield','spread');
CREATE TYPE flujo_comercio AS ENUM ('X','M');
CREATE TYPE estado_etl    AS ENUM ('ok','parcial','error');

-- ────────────────────────────────────────────────────────────────────────
-- Trigger genérico de actualizado_en
-- ────────────────────────────────────────────────────────────────────────
CREATE FUNCTION set_actualizado_en() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- DIMENSIONES
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE dim_country (
  id          serial PRIMARY KEY,
  iso3        char(3)  NOT NULL UNIQUE,           -- clave natural
  iso2        char(2)  NOT NULL,
  m49         integer,                            -- código numérico UN (Comtrade)
  nombre_es   text     NOT NULL,
  nombre_en   text     NOT NULL,
  region      region_geo NOT NULL,
  grupos      grupo_pais[] NOT NULL DEFAULT '{}',
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_country_region ON dim_country (region);
CREATE INDEX ix_country_m49    ON dim_country (m49);

CREATE TABLE dim_indicator (
  id          serial PRIMARY KEY,
  codigo      text NOT NULL UNIQUE,               -- clave natural ('gdp_growth', 'cpi_yoy'…)
  nombre_es   text NOT NULL,
  nombre_en   text NOT NULL,
  unidad      text NOT NULL,
  frecuencia  frecuencia NOT NULL,
  fuente      text NOT NULL,
  polaridad   polaridad NOT NULL DEFAULT 'none',
  descripcion text,
  -- objetivo opcional para colorear por desviación (p.ej. meta de inflación)
  objetivo    numeric(12,4),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dim_source (
  id          serial PRIMARY KEY,
  codigo      text NOT NULL UNIQUE,               -- 'worldbank','imf','gdelt'…
  proveedor   text NOT NULL,
  url         text NOT NULL,
  licencia    text,
  auth        auth_fuente NOT NULL DEFAULT 'none',
  rate_limit  text,
  estado      estado_fuente NOT NULL DEFAULT 'cold',
  latencia_ms integer,
  ultima_verificacion timestamptz,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- ════════════════════════════════════════════════════════════════════════
-- HECHOS (time-series) · claves naturales únicas → idempotencia
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE fact_timeseries (
  country_id   integer NOT NULL REFERENCES dim_country (id),
  indicator_id integer NOT NULL REFERENCES dim_indicator (id),
  fecha        date    NOT NULL,
  valor        numeric(20,6),                     -- nullable: s/d explícito
  source_id    integer NOT NULL REFERENCES dim_source (id),
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (country_id, indicator_id, fecha)   -- upsert natural
);
CREATE INDEX ix_ts_indicator_fecha ON fact_timeseries (indicator_id, fecha DESC);
CREATE INDEX ix_ts_country         ON fact_timeseries (country_id);

-- Series de mercado (no necesariamente por país): símbolo×fecha.
CREATE TABLE fact_market (
  symbol       text  NOT NULL,                    -- 'WTI','BRENT','GOLD','VIX','DXY','USDBRL','UST10Y'
  clase        clase_mercado NOT NULL,
  fecha        date  NOT NULL,
  valor        numeric(20,6),
  country_id   integer REFERENCES dim_country (id), -- opcional (yield/spread soberano)
  source_id    integer NOT NULL REFERENCES dim_source (id),
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, fecha)
);
CREATE INDEX ix_mkt_clase_fecha ON fact_market (clase, fecha DESC);
CREATE INDEX ix_mkt_country     ON fact_market (country_id);

-- Comercio bilateral (Comtrade): reporter×partner×periodo×flujo.
CREATE TABLE fact_trade (
  reporter_id  integer NOT NULL REFERENCES dim_country (id),
  partner_m49  integer NOT NULL,                  -- 0 = mundo
  partner_nombre text,
  periodo      text NOT NULL,                     -- '2022'
  flujo        flujo_comercio NOT NULL,
  valor_usd    numeric(22,2),
  source_id    integer NOT NULL REFERENCES dim_source (id),
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reporter_id, partner_m49, periodo, flujo)
);
CREATE INDEX ix_trade_reporter ON fact_trade (reporter_id, periodo);

-- Eventos geopolíticos / conflicto (GDELT diario agregado / ACLED).
CREATE TABLE fact_geo_events (
  country_id   integer NOT NULL REFERENCES dim_country (id),
  fecha        date    NOT NULL,
  tipo         text    NOT NULL DEFAULT 'agregado',
  intensidad   numeric(16,4),                     -- volumen cobertura / fatalities
  fatalities   integer,
  tono         numeric(10,4),                      -- tono medio GDELT
  fuente       text    NOT NULL,
  source_id    integer NOT NULL REFERENCES dim_source (id),
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (country_id, fecha, tipo, fuente)
);
CREATE INDEX ix_geo_fecha ON fact_geo_events (fecha DESC);

-- Calendario de releases / bancos centrales.
CREATE TABLE calendar_event (
  id          serial PRIMARY KEY,
  fecha       date NOT NULL,
  country_id  integer REFERENCES dim_country (id),
  tipo        text NOT NULL,                       -- 'banco-central','release','deuda','politico'
  titulo      text NOT NULL,
  tono        text NOT NULL DEFAULT 'neutral',
  fuente      text,
  UNIQUE (fecha, titulo)
);
CREATE INDEX ix_cal_fecha ON calendar_event (fecha);

-- ════════════════════════════════════════════════════════════════════════
-- OBSERVABILIDAD
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE etl_run_log (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  inicio      timestamptz NOT NULL DEFAULT now(),
  fin         timestamptz,
  filas       integer NOT NULL DEFAULT 0,
  estado      estado_etl NOT NULL DEFAULT 'ok',
  error       text
);
CREATE INDEX ix_etl_job ON etl_run_log (job, inicio DESC);

-- ════════════════════════════════════════════════════════════════════════
-- VISTAS DERIVADAS (v_*)
-- ════════════════════════════════════════════════════════════════════════

-- Último valor disponible por país×indicador (most-recent-value).
CREATE VIEW v_indicator_latest AS
SELECT DISTINCT ON (t.country_id, t.indicator_id)
       t.country_id, t.indicator_id, c.iso3, i.codigo,
       t.fecha AS asof, t.valor, s.codigo AS source
FROM fact_timeseries t
JOIN dim_country c   ON c.id = t.country_id
JOIN dim_indicator i ON i.id = t.indicator_id
JOIN dim_source s    ON s.id = t.source_id
WHERE t.valor IS NOT NULL
ORDER BY t.country_id, t.indicator_id, t.fecha DESC;

-- Heatmap macro: último valor + z-score por indicador (cross-sección de países).
CREATE VIEW v_heatmap_macro AS
WITH latest AS (SELECT * FROM v_indicator_latest),
stats AS (
  SELECT indicator_id, avg(valor) AS mu, stddev_samp(valor) AS sigma
  FROM latest GROUP BY indicator_id
)
SELECT l.iso3, l.codigo AS indicador, l.valor, l.asof,
       CASE WHEN st.sigma IS NULL OR st.sigma = 0 THEN 0
            ELSE (l.valor - st.mu) / st.sigma END AS z
FROM latest l
JOIN stats st ON st.indicator_id = l.indicator_id;

-- Tasa real ex-post: inflación (cpi_yoy) vs tasa de política (policy_rate).
CREATE VIEW v_real_rate AS
SELECT c.iso3, c.nombre_es AS pais,
       infl.valor AS inflacion, pol.valor AS tasa_politica,
       (pol.valor - infl.valor) AS tasa_real,
       GREATEST(infl.asof, pol.asof) AS asof
FROM dim_country c
LEFT JOIN v_indicator_latest infl ON infl.country_id = c.id AND infl.codigo = 'cpi_yoy'
LEFT JOIN v_indicator_latest pol  ON pol.country_id  = c.id AND pol.codigo  = 'policy_rate'
WHERE infl.valor IS NOT NULL OR pol.valor IS NOT NULL;

-- Ranking de conflicto: intensidad y tono más recientes por país.
CREATE VIEW v_conflict_latest AS
SELECT DISTINCT ON (g.country_id)
       c.iso3, c.nombre_es AS pais, g.fecha AS asof,
       g.intensidad, g.tono, g.fuente
FROM fact_geo_events g
JOIN dim_country c ON c.id = g.country_id
ORDER BY g.country_id, g.fecha DESC;

-- Salud de fuentes (health-check).
CREATE VIEW v_source_health AS
SELECT codigo, proveedor, url, licencia, auth, estado, latencia_ms,
       ultima_verificacion
FROM dim_source
ORDER BY proveedor;
