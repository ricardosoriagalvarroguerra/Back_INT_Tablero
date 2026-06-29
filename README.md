# Tablero Inteligente INT · Backend (API + ingesta)

API **Fastify 5 + `pg`** (Node/TS) que sirve el [Tablero Inteligente INT](https://github.com/ricardosoriagalvarroguerra/Front_INT_Tablero)
desde la BDR **PostgreSQL `internacional`**, más los **jobs de ingesta idempotentes**
que cargan los hechos desde fuentes abiertas (World Bank, IMF, OECD, ECB, Yahoo
Finance, UN Comtrade, GDELT, FRED).

> **Regla de oro: cero datos inventados.** Cada cifra es trazable a su fuente y
> fecha de corte; si una fuente falla, la API degrada a `s/d`, nunca rellena.
> Fuentes y esquemas verificados: [`docs/SOURCES.md`](docs/SOURCES.md).

## Estructura

```
.
├── src/             · API Fastify + conectores de ingesta (TypeScript, se ejecuta con el strip-types nativo de Node ≥22.18)
│   ├── index.ts     · bootstrap del API (escucha en 0.0.0.0:$PORT)
│   ├── routes.ts    · rutas por vista · repo.ts (SQL→payload)
│   ├── ingest.ts    · runner de ingesta (orquesta connectors/)
│   └── connectors/  · WB · IMF · Yahoo · ECB · OECD · Comtrade · GDELT · FRED
├── db/              · schema.sql (dimensional) + seed.sql (dim_country/indicator/source)
└── docs/            · SOURCES.md (fuentes) · ANALISIS.md (guardrails y estado de datos)
```

## Arranque local

Requiere **PostgreSQL local** (p. ej. Postgres.app en `:5432`) y **Node ≥ 22.18**.

```bash
# 1) Base de datos
createdb internacional
psql -d internacional -f db/schema.sql
psql -d internacional -f db/seed.sql

# 2) Variables (opcionales) — copiar y editar
cp .env.example .env            # DATABASE_URL, API_PORT, FRED_API_KEY…

# 3) Dependencias + ingesta (idempotente; registra en etl_run_log)
npm install
npm run ingest

# 4) API
npm start                       # Fastify en :5176 (o $API_PORT)
```

Healthcheck: `GET /api/healthz` → `{ ok: <conexión a BDR>, ts }`.

## Despliegue en Railway

El repo se autodetecta como app **Node** (hay `package.json` en la raíz); Railpack
ejecuta `npm ci` y `npm start`. El API escucha en `0.0.0.0` y en el puerto que
Railway inyecta vía **`PORT`** (ver `src/env.ts`).

1. **Base de datos** — añade un servicio **PostgreSQL** al proyecto. Railway expone
   `DATABASE_URL`; referénciala en el servicio del API (Variables → `DATABASE_URL =
   ${{Postgres.DATABASE_URL}}`).
2. **Variables** — define `FRED_API_KEY` (y opcionales `YOUTUBE_API_KEY`,
   `ACLED_API_KEY`/`ACLED_EMAIL`). `PORT` lo provee Railway; no lo fijes a mano.
3. **Esquema + datos** — una sola vez, contra la BDR de Railway (añade
   `?sslmode=require` si conectas desde fuera de la red privada):
   ```bash
   psql "$DATABASE_URL" -f db/schema.sql
   psql "$DATABASE_URL" -f db/seed.sql
   npm run ingest          # poblar fact_* (idempotente, re-ejecutable)
   ```
   La ingesta puede programarse como **cron job** de Railway para refrescar a diario.

> Sin BDR poblada el API arranca igual: las rutas responden `s/d` hasta que corre la ingesta.

## Variables de entorno

| Var | Req. | Default | Uso |
|---|---|---|---|
| `DATABASE_URL` | sí (prod) | `postgres://localhost:5432/internacional` | Conexión PostgreSQL |
| `PORT` | — | — | Puerto inyectado por la plataforma (tiene prioridad) |
| `API_PORT` | — | `5176` | Puerto en local si no hay `PORT` |
| `FRED_API_KEY` | — | — | Yields UST + calendario (gratuita en FRED) |
| `YOUTUBE_API_KEY`, `ACLED_API_KEY`, `ACLED_EMAIL` | — | — | Opcionales; degradan a `s/d` si faltan |

Guardrails y estado de datos por vista: [`docs/ANALISIS.md`](docs/ANALISIS.md).
