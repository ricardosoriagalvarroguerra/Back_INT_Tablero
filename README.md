# Tablero Inteligente INT · Backend (API + ingesta)

API **Fastify 5 + `pg`** (Node/TS) que sirve el [Tablero Inteligente INT](https://github.com/ricardosoriagalvarroguerra/Front_INT_Tablero)
desde la BDR **PostgreSQL `internacional`**, más los **jobs de ingesta idempotentes**
que cargan los hechos desde fuentes abiertas (World Bank, IMF, OECD, ECB, Yahoo
Finance, UN Comtrade, GDELT, FRED, BIS) y la **capa analítica** (`/api/analisis`):
tesis, semáforo de 9 dimensiones, alertas por reglas, ciclo global y monetario,
condiciones financieras, dinámica de deuda, FX emergente y ranking de vulnerabilidad.

> **Regla de oro: cero datos inventados.** Cada cifra es trazable a su fuente y
> fecha de corte; si una fuente falla, la API degrada a `s/d`, nunca rellena.
> Fuentes y esquemas verificados: [`docs/SOURCES.md`](docs/SOURCES.md).

## Estructura

```
.
├── src/             · API Fastify + conectores de ingesta (TypeScript, se ejecuta con el strip-types nativo de Node ≥22.18)
│   ├── index.ts     · arranque: aprovisiona la BDR, escucha en 0.0.0.0:$PORT, programa la ingesta
│   ├── bootstrap.ts · auto-aprovisionamiento (hash de schema/seed → seed_meta)
│   ├── pipeline.ts  · ingesta (al arrancar, cada INGEST_INTERVAL_HOURS y POST /api/ingesta)
│   ├── analisis.ts  · capa analítica (reglas explícitas, ver docs/ANALISIS.md)
│   ├── routes.ts    · rutas por vista · repo.ts (SQL→payload)
│   ├── ingest.ts    · CLI de ingesta (npm run ingest [-- fuentes…])
│   └── connectors/  · WB · IMF · BIS · FRED · Yahoo · ECB · OECD · Comtrade · GDELT
├── db/              · schema.sql (dimensional) + seed.sql (dim_country/indicator/source)
└── docs/            · SOURCES.md (fuentes) · ANALISIS.md (guardrails y estado de datos)
```

## Arranque local

Requiere **PostgreSQL local** (p. ej. Postgres.app en `:5432`) y **Node ≥ 22.18**.

```bash
# 1) Base de datos (el esquema y el seed se aplican solos al arrancar)
createdb internacional

# 2) Variables (opcionales) — copiar y editar
cp .env.example .env            # DATABASE_URL, API_PORT, FRED_API_KEY…

# 3) Dependencias + ingesta (idempotente; registra en etl_run_log)
npm install
npm run ingest                  # o sólo algunas: npm run ingest -- bis fred

# 4) API
npm start                       # Fastify en :5176 (o $API_PORT)
```

Healthcheck: `GET /api/healthz` → `{ ok: <conexión a BDR>, ts, seed: {version, accion} }`.

Detrás de un proxy HTTP (p.ej. entornos corporativos o sandboxes) Node necesita
`NODE_USE_ENV_PROXY=1` para que la ingesta use `HTTPS_PROXY`.

## Despliegue en Railway

El repo se autodetecta como app **Node** (hay `package.json` en la raíz); Railpack
ejecuta `npm ci` y `npm start`. El API escucha en `0.0.0.0` y en el puerto que
Railway inyecta vía **`PORT`** (ver `src/env.ts`).

1. **Base de datos** — añade un servicio **PostgreSQL** al proyecto. Railway expone
   `DATABASE_URL`; referénciala en el servicio del API (Variables → `DATABASE_URL =
   ${{Postgres.DATABASE_URL}}`).
2. **Variables** — define `FRED_API_KEY` (y opcionales `YOUTUBE_API_KEY`,
   `ACLED_API_KEY`/`ACLED_EMAIL`). `PORT` lo provee Railway; no lo fijes a mano.
3. **Esquema + datos** — automático: al arrancar, el API aplica `db/schema.sql` + `db/seed.sql`
   si la base está vacía o cambiaron (ver `seed_meta`) y lanza la ingesta completa (~5–8 min la
   primera vez). Después refresca cada `INGEST_INTERVAL_HOURS` (6). No hace falta cron externo.
4. **Disparo manual** (opcional) — define `INGEST_TOKEN` (valor aleatorio largo) y:
   ```bash
   curl -X POST "$API/api/ingesta" -H "Authorization: Bearer $INGEST_TOKEN"
   ```

> Mientras la primera ingesta corre, las rutas responden con lo que haya (o `s/d`).

## Variables de entorno

| Var | Req. | Default | Uso |
|---|---|---|---|
| `DATABASE_URL` | sí (prod) | `postgres://localhost:5432/internacional` | Conexión PostgreSQL |
| `PORT` | — | — | Puerto inyectado por la plataforma (tiene prioridad) |
| `API_PORT` | — | `5176` | Puerto en local si no hay `PORT` |
| `INGEST_TOKEN` | — | — | Habilita `POST /api/ingesta` (Bearer) |
| `INGEST_INTERVAL_HOURS` | — | `6` | Frecuencia de la ingesta programada (0 = sólo al arrancar) |
| `INGEST_ON_START` | — | `true` | `false` desactiva la ingesta automática |
| `DB_AUTO_SEED` | — | `true` | `false` desactiva el auto-aprovisionamiento de la BDR |
| `FRED_API_KEY` | — | — | Sólo para el calendario de releases (los datos FRED se leen sin clave) |
| `YOUTUBE_API_KEY`, `ACLED_API_KEY`, `ACLED_EMAIL` | — | — | Opcionales; degradan a `s/d` si faltan |

Guardrails y estado de datos por vista: [`docs/ANALISIS.md`](docs/ANALISIS.md).
