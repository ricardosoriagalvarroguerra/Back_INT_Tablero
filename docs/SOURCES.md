# Fuentes de datos · Tablero Inteligente INT

> **Regla de oro: cero datos inventados.** Cada cifra es trazable a la fuente y
> fecha de corte registradas aquí. Si una fuente falla o no hay dato, la UI lo
> muestra como `s/d` / "fuente caída"; nunca se rellena.

**Última verificación en vivo de endpoints:** `2026-06-20` (con `curl`, no de
memoria — las URLs y formatos cambian). El estado operativo en runtime se
registra por fila en `dim_source.ultima_verificacion` y en `etl_run_log`.

## Resumen de verificación (2026-06-20)

| Fuente | Endpoint base | Auth | Rate limit | Formato | Estado | Licencia / atribución |
|---|---|---|---|---|---|---|
| **World Bank Open Data** | `https://api.worldbank.org/v2/` | — | laxo | JSON | ✅ 200 | CC-BY 4.0 |
| **IMF DataMapper (WEO)** | `https://www.imf.org/external/datamapper/api/v1/` | — | laxo | JSON | ✅ 200 | IMF terms (atribución) |
| **OECD Data Explorer** | `https://sdmx.oecd.org/public/rest/data/` | — | laxo | SDMX-JSON 2.0 | ✅ 200 | OECD terms |
| **Eurostat** | `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/` | — | laxo | JSON-stat 2.0 | ✅ 200 | CC-BY 4.0 (ESTAT) |
| **ECB Data Portal** | `https://data-api.ecb.europa.eu/service/data/` | — | laxo | SDMX-JSON/CSV | ✅ 200 | ECB terms (atribución) |
| **Yahoo Finance (chart)** | `https://query1.finance.yahoo.com/v8/finance/chart/` | — | moderado | JSON | ✅ 200 | Uso no comercial; API no oficial |
| **Frankfurter** | `https://api.frankfurter.dev/v1/` | — | laxo | JSON | ✅ 200 | Datos ECB, dominio público |
| **UN Comtrade (preview)** | `https://comtradeapi.un.org/public/v1/preview/` | — (preview) | filas limitadas | JSON | ✅ 200 | UN terms (atribución) |
| **GDELT 2.0 DOC** | `https://api.gdeltproject.org/api/v2/doc/doc` | — | **1 req / 5 s** | JSON | ⚠️ alcanzable (429 bajo carga) | GDELT terms |
| **FRED** | `https://api.stlouisfed.org/fred/` | **API key** | 120/min | JSON | 🔑 requiere `FRED_API_KEY` | St. Louis Fed terms |
| **ACLED** | `https://api.acleddata.com/` | **registro** | — | JSON | 🔑 requiere `ACLED_API_KEY`+email | ACLED terms (no comercial) |
| **YouTube (embeds/live)** | `youtube.com/@{handle}/live`, IFrame API | — / opc. key | — | HTML/iframe | ✅ resoluble | YouTube ToS (solo iframe oficial) |

Leyenda: ✅ verificado con datos · ⚠️ alcanzable, throttling estricto · 🔑 requiere credencial.

## Notas de esquema por fuente (capturadas en vivo)

### World Bank — `api.worldbank.org/v2/`
- Respuesta = array `[meta, data[]]`. `meta`: `page/pages/per_page/total/lastupdated`.
  Cada fila: `indicator{id,value}`, `country{id,value}`, `countryiso3code`, `date`, `value` (**nullable**), `obs_status`.
- Multi-país: `country/USA;ARG;BRA/indicator/{IND}`. Todos: `country/all/...`.
- Último dato: `?mrv=1` (most recent value) o `?date=2018:2024`. Paginar con `per_page`/`page`.
- Indicadores: `NY.GDP.MKTP.CD` (PIB US$), `NY.GDP.MKTP.KD.ZG` (crecimiento %), `FP.CPI.TOTL.ZG` (inflación %),
  `SL.UEM.TOTL.ZS` (desempleo %), `GC.DOD.TOTL.GD.ZS` (deuda/PIB), `GC.NLD.TOTL.GD.ZS` (balance fiscal/PIB),
  `BN.CAB.XOKA.GD.ZS` (cuenta corriente/PIB).
- Clave natural upsert: `(countryiso3code, indicator.id, date)`.

### IMF DataMapper — `imf.org/external/datamapper/api/v1/`
- `GET /indicators` → catálogo `{indicators:{COD:{label,description,source,unit,dataset,last-modified}}}`.
- **Cuidado**: `GET /{IND}/{PAIS}` **ignora el país** y devuelve TODOS los países:
  `{values:{IND:{ISO3:{"1980":x,…,"2031":y}}}}`. El conector debe leer `values[IND][ISO3]`.
- WEO abr-2026. Indicadores: `NGDP_RPCH` (crec. real %), `PCPIPCH` (inflación %), `LUR` (desempleo %),
  `GGXWDG_NGDP` (deuda bruta/PIB), `GGXCNL_NGDP` (balance fiscal/PIB), `BCA_NGDPD` (cuenta corriente/PIB).

### OECD — `sdmx.oecd.org/public/rest/data/`
- SDMX-JSON 2.0. Patrón: `data/{agencyId},{dataflowId},{version}/{key}?format=jsondata&lastNObservations=N`.
  `key` es posicional por dimensiones (p.ej. `USA.M.IRSTCI......`). El dominio viejo `stats.oecd.org` está caído; usar `sdmx.oecd.org`.
- Uso: tasas de interés/CPI/PIB OCDE como complemento. Estructura `data.dataSets` + `data.structures`.

### Eurostat — dissemination API
- JSON-stat 2.0: `value{idx:val}` + `dimension{...category.index}` + `size[]` + `id[]`. Decodificar índice → coordenadas.
- Datasets: `prc_hicp_manr` (HICP i/a), `une_rt_m` (desempleo mensual), `namq_10_gdp` (PIB trimestral).
- Filtros por `geo`, `coicop`, `lastTimePeriod=1`.

### ECB — Data Portal
- SDMX-JSON: `dataSets[0].series["0:0:0:0:0"].observations`. EUR/USD: `EXR/D.USD.EUR.SP00.A` (=1.1467 al 19-jun-2026).
- Keyless para FX de referencia y tasas euro. No da yields soberanos de todos los países.

### Yahoo Finance (chart) — `query1.finance.yahoo.com/v8/finance/chart/{symbol}`
- Keyless. `meta.regularMarketPrice`, `meta.currency`, `indicators.quote[0].close[]` + `timestamp[]`. Usar `?interval=1d&range=…`.
- Símbolos verificados: `CL=F` (WTI 76.54), `BZ=F` (Brent 80.59), `GC=F` (oro 4172.9), `HG=F` (cobre 6.337),
  `^VIX` (16.78), `^GSPC` (S&P 7500.58), `DX-Y.NYB` (DXY 100.849). FX EM: `ARS=X`, `CLP=X`, `COP=X`, etc.
- Caballo de batalla para commodities/índices/volatilidad y pares FX que Frankfurter no cubre. Enviar `User-Agent`; cachear.

### Frankfurter — `api.frankfurter.dev/v1/latest?base=USD&symbols=…`
- Keyless, datos ECB. Cubre **majors** (BRL, MXN, CNY…), **no** ARS/CLP/COP → esos por Yahoo. `exchangerate.host` ahora exige key (descartado). Stooq devolvió 404 (descartado).

### UN Comtrade (preview) — `comtradeapi.un.org/public/v1/preview/C/A/HS`
- Keyless en `preview` (límite de filas). Campo de valor = **`primaryValue`** (ARG 2022 export X = 88 445 718 838).
- Códigos **M49** numéricos: reporter/partner (USA=842, ARG=032, BRA=076, CHN=156, DEU=276). `reporterISO`/`partnerISO`/`cmdDesc` vienen `null` en preview → mapa M49→ISO3+nombre local.
- `partnerCode=0` = mundo (total); `partnerCode!=0` = bilateral (socios). `cmdCode=TOTAL` o HS específico. Flujos `X` (export) / `M` (import).

### GDELT 2.0 DOC — `api.gdeltproject.org/api/v2/doc/doc`
- Keyless pero **1 req / 5 s** estricto (esta IP entró en cooldown durante la verificación → 429). El conector serializa global, cachea y hace backoff; ante 429 persistente marca la fuente `lag/down`.
- Modos: `timelinetone` (tono medio temporal), `timelinevolraw` (volumen=intensidad), `tonechart`, `artlist`. Query con `sourcecountry:XX` + keywords (`protest OR conflict`). `format=json`, `timespan=1w`.
- Para `fact_geo_events`: tono + volumen por país/fecha. **ACLED** (key) documentado como alternativa más rica (fatalities por evento geolocalizado).

### YouTube — muro de medios (§6)
- **Resolución keyless del live** verificada: `GET youtube.com/@{handle}/live` → extraer `watch?v={11}`; o embed directo `youtube.com/embed/live_stream?channel={channelId}`.
- channelIds verificados: Bloomberg TV (`@markets`) `UCIALMKvObZNtJ6AmdCLP7Lg`; CNBC `UCvJJ_dzjViJCoLf5uKUTwoA`;
  DW News `UCknLrEdhRCp1aegoMqRaCZg`; Al Jazeera English `UCNye-wNBqNL5ZzHSJj3l8Bg`; Yahoo Finance `UCEAZeUIeJs0IjQiqTCdVSIg`.
  (`@BloombergTelevision` es una cuenta ajena — **no usar**.)
- Robustez opcional con `YOUTUBE_API_KEY` (Data API v3 `search.list?eventType=live`). Solo iframe/IFrame API oficial; respeta el ToS de embed.

## Credenciales (todas opcionales; el panel se enciende al pegarlas en `.env`)
- `FRED_API_KEY` — gratuita en https://fred.stlouisfed.org/docs/api/api_key.html → yields/tasas/VIX/DXY oficiales.
- `YOUTUBE_API_KEY` — robustez extra del live (degradado keyless si falta).
- `ACLED_API_KEY` + `ACLED_EMAIL` — eventos de conflicto con fatalities.
