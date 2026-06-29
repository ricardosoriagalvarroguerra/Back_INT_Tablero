-- ════════════════════════════════════════════════════════════════════════
-- Tablero Inteligente INT · Seed dimensional (catálogos)
-- Idempotente: ON CONFLICT (clave natural) DO UPDATE. Re-ejecutable.
-- NO contiene hechos (fact_*): esos los carga la ingesta desde fuentes vivas.
-- ════════════════════════════════════════════════════════════════════════
SET search_path = public;

-- ── dim_country · 42 economías (G7/G20/EM/LatAm/avanzada) ───────────────
INSERT INTO dim_country (iso3, iso2, m49, nombre_es, nombre_en, region, grupos) VALUES
  ('USA','US',840,'Estados Unidos','United States','Norteamérica','{G7,G20,avanzada}'),
  ('CAN','CA',124,'Canadá','Canada','Norteamérica','{G7,G20,avanzada}'),
  ('MEX','MX',484,'México','Mexico','LatAm','{G20,EM,LatAm}'),
  ('GBR','GB',826,'Reino Unido','United Kingdom','Europa','{G7,G20,avanzada}'),
  ('FRA','FR',250,'Francia','France','Europa','{G7,G20,avanzada}'),
  ('DEU','DE',276,'Alemania','Germany','Europa','{G7,G20,avanzada}'),
  ('ITA','IT',380,'Italia','Italy','Europa','{G7,G20,avanzada}'),
  ('ESP','ES',724,'España','Spain','Europa','{avanzada}'),
  ('NLD','NL',528,'Países Bajos','Netherlands','Europa','{avanzada}'),
  ('CHE','CH',756,'Suiza','Switzerland','Europa','{avanzada}'),
  ('SWE','SE',752,'Suecia','Sweden','Europa','{avanzada}'),
  ('NOR','NO',578,'Noruega','Norway','Europa','{avanzada}'),
  ('POL','PL',616,'Polonia','Poland','Europa','{EM}'),
  ('RUS','RU',643,'Rusia','Russia','Europa','{G20,EM}'),
  ('TUR','TR',792,'Turquía','Türkiye','Europa','{G20,EM}'),
  ('JPN','JP',392,'Japón','Japan','Asia','{G7,G20,avanzada}'),
  ('KOR','KR',410,'Corea del Sur','South Korea','Asia','{G20,avanzada}'),
  ('CHN','CN',156,'China','China','Asia','{G20,EM}'),
  ('IND','IN',356,'India','India','Asia','{G20,EM}'),
  ('IDN','ID',360,'Indonesia','Indonesia','Asia','{G20,EM}'),
  ('THA','TH',764,'Tailandia','Thailand','Asia','{EM}'),
  ('MYS','MY',458,'Malasia','Malaysia','Asia','{EM}'),
  ('PHL','PH',608,'Filipinas','Philippines','Asia','{EM}'),
  ('VNM','VN',704,'Vietnam','Vietnam','Asia','{EM}'),
  ('SGP','SG',702,'Singapur','Singapore','Asia','{avanzada}'),
  ('AUS','AU',36,'Australia','Australia','Oceanía','{G20,avanzada}'),
  ('ARG','AR',32,'Argentina','Argentina','LatAm','{G20,EM,LatAm}'),
  ('BRA','BR',76,'Brasil','Brazil','LatAm','{G20,EM,LatAm}'),
  ('CHL','CL',152,'Chile','Chile','LatAm','{EM,LatAm}'),
  ('COL','CO',170,'Colombia','Colombia','LatAm','{EM,LatAm}'),
  ('PER','PE',604,'Perú','Peru','LatAm','{EM,LatAm}'),
  ('URY','UY',858,'Uruguay','Uruguay','LatAm','{LatAm}'),
  ('BOL','BO',68,'Bolivia','Bolivia','LatAm','{LatAm}'),
  ('ECU','EC',218,'Ecuador','Ecuador','LatAm','{LatAm}'),
  ('PRY','PY',600,'Paraguay','Paraguay','LatAm','{LatAm}'),
  ('VEN','VE',862,'Venezuela','Venezuela','LatAm','{LatAm}'),
  ('ZAF','ZA',710,'Sudáfrica','South Africa','África','{G20,EM}'),
  ('NGA','NG',566,'Nigeria','Nigeria','África','{EM}'),
  ('EGY','EG',818,'Egipto','Egypt','África','{EM}'),
  ('SAU','SA',682,'Arabia Saudita','Saudi Arabia','Medio Oriente','{G20,EM}'),
  ('ARE','AE',784,'Emiratos Árabes Unidos','United Arab Emirates','Medio Oriente','{EM}'),
  ('ISR','IL',376,'Israel','Israel','Medio Oriente','{avanzada}')
ON CONFLICT (iso3) DO UPDATE SET
  iso2 = EXCLUDED.iso2, m49 = EXCLUDED.m49, nombre_es = EXCLUDED.nombre_es,
  nombre_en = EXCLUDED.nombre_en, region = EXCLUDED.region, grupos = EXCLUDED.grupos;

-- ── dim_indicator · catálogo macro (códigos de fuente verificados) ──────
INSERT INTO dim_indicator (codigo, nombre_es, nombre_en, unidad, frecuencia, fuente, polaridad, descripcion) VALUES
  ('gdp_growth','Crecimiento del PIB real','Real GDP growth','%','anual','World Bank / IMF','up','WB NY.GDP.MKTP.KD.ZG · IMF NGDP_RPCH'),
  ('cpi_yoy','Inflación (IPC i/a)','Inflation (CPI YoY)','%','anual','World Bank / IMF','down','WB FP.CPI.TOTL.ZG · IMF PCPIPCH'),
  ('unemployment','Desempleo','Unemployment','%','anual','World Bank / IMF','down','WB SL.UEM.TOTL.ZS · IMF LUR'),
  ('policy_rate','Tasa de política monetaria','Policy rate','%','mensual','OECD / FRED / ECB','none','OECD IRSTCI · FRED · ECB'),
  ('debt_gdp','Deuda bruta / PIB','Gross debt to GDP','% PIB','anual','IMF / World Bank','down','IMF GGXWDG_NGDP · WB GC.DOD.TOTL.GD.ZS'),
  ('fiscal_balance','Balance fiscal / PIB','Fiscal balance to GDP','% PIB','anual','IMF / World Bank','up','IMF GGXCNL_NGDP · WB GC.NLD.TOTL.GD.ZS'),
  ('current_account','Cuenta corriente / PIB','Current account to GDP','% PIB','anual','IMF / World Bank','up','IMF BCA_NGDPD · WB BN.CAB.XOKA.GD.ZS'),
  ('yield_10y','Rendimiento soberano 10A','10Y sovereign yield','%','diaria','FRED / ECB','down','FRED DGS10 · ECB'),
  ('yield_2y','Rendimiento soberano 2A','2Y sovereign yield','%','diaria','FRED','none','FRED DGS2')
ON CONFLICT (codigo) DO UPDATE SET
  nombre_es = EXCLUDED.nombre_es, nombre_en = EXCLUDED.nombre_en, unidad = EXCLUDED.unidad,
  frecuencia = EXCLUDED.frecuencia, fuente = EXCLUDED.fuente, polaridad = EXCLUDED.polaridad,
  descripcion = EXCLUDED.descripcion;

-- ── dim_source · fuentes verificadas 2026-06-20 (ver docs/SOURCES.md) ───
INSERT INTO dim_source (codigo, proveedor, url, licencia, auth, rate_limit, estado, ultima_verificacion) VALUES
  ('worldbank','World Bank Open Data','https://api.worldbank.org/v2/','CC-BY 4.0','none','laxo','cold','2026-06-20'),
  ('imf','IMF DataMapper (WEO)','https://www.imf.org/external/datamapper/api/v1/','IMF terms','none','laxo','cold','2026-06-20'),
  ('oecd','OECD Data Explorer','https://sdmx.oecd.org/public/rest/','OECD terms','none','laxo','cold','2026-06-20'),
  ('eurostat','Eurostat','https://ec.europa.eu/eurostat/api/dissemination/','CC-BY 4.0','none','laxo','cold','2026-06-20'),
  ('ecb','ECB Data Portal','https://data-api.ecb.europa.eu/service/','ECB terms','none','laxo','cold','2026-06-20'),
  ('yahoo','Yahoo Finance','https://query1.finance.yahoo.com/v8/finance/chart/','No comercial','none','moderado','cold','2026-06-20'),
  ('frankfurter','Frankfurter (ECB)','https://api.frankfurter.dev/v1/','Dominio público','none','laxo','cold','2026-06-20'),
  ('comtrade','UN Comtrade','https://comtradeapi.un.org/public/v1/preview/','UN terms','none','filas limitadas','cold','2026-06-20'),
  ('gdelt','GDELT 2.0','https://api.gdeltproject.org/api/v2/doc/doc','GDELT terms','none','1 req / 5 s','cold','2026-06-20'),
  ('fred','FRED (St. Louis Fed)','https://api.stlouisfed.org/fred/','Fed terms','api_key','120/min','cold','2026-06-20'),
  ('acled','ACLED','https://api.acleddata.com/','ACLED terms','registration','n/d','cold',NULL),
  ('youtube','YouTube','https://www.youtube.com/','YouTube ToS','none','n/d','cold','2026-06-20')
ON CONFLICT (codigo) DO UPDATE SET
  proveedor = EXCLUDED.proveedor, url = EXCLUDED.url, licencia = EXCLUDED.licencia,
  auth = EXCLUDED.auth, rate_limit = EXCLUDED.rate_limit;
