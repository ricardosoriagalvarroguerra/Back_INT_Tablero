// Calendario de próximos releases macro (FRED release dates). Fechas REALES y
// programadas (no inventadas) de las publicaciones clave de EE.UU. Requiere
// FRED_API_KEY. release_ids resueltos en vivo desde /fred/releases (verificado).

import { fetchJson } from '../lib/http.ts';
import { env } from '../env.ts';
import { countryMaps, sourceId } from '../lib/ingest.ts';
import { query } from '../db.ts';

// Solo releases de cadencia mensual (eventos reales). Se excluye H.15 (tasas
// Fed) por ser diario → saturaría el calendario con ruido repetido.
const RELEASES: { id: number; titulo: string; tipo: string; tono: string }[] = [
  { id: 10, titulo: 'IPC / inflación (CPI)', tipo: 'release', tono: 'info' },
  { id: 50, titulo: 'Situación del empleo (nóminas, desempleo)', tipo: 'release', tono: 'info' },
  { id: 53, titulo: 'PIB (GDP)', tipo: 'release', tono: 'info' },
  { id: 54, titulo: 'Ingreso y gasto personal (PCE)', tipo: 'release', tono: 'info' },
  { id: 46, titulo: 'Precios al productor (PPI)', tipo: 'release', tono: 'info' },
  { id: 9, titulo: 'Ventas minoristas', tipo: 'release', tono: 'info' },
  { id: 13, titulo: 'Producción industrial', tipo: 'release', tono: 'info' },
];

interface FredDates {
  release_dates?: { date: string }[];
}

export async function ingestCalendar(): Promise<number> {
  if (!env.fredApiKey) throw new Error('Sin FRED_API_KEY (calendario)');
  const { byIso3 } = await countryMaps();
  const usa = byIso3.get('USA') ?? null;
  await sourceId('fred'); // asegura existencia de la fuente

  const hoy = new Date().toISOString().slice(0, 10);
  const finRango = `${new Date().getUTCFullYear() + 1}-12-31`;

  const fechas: string[] = [];
  const countryIds: (number | null)[] = [];
  const tipos: string[] = [];
  const titulos: string[] = [];
  const tonos: string[] = [];
  const fuentes: string[] = [];

  for (const r of RELEASES) {
    const url =
      `https://api.stlouisfed.org/fred/release/dates?release_id=${r.id}` +
      `&api_key=${env.fredApiKey}&file_type=json&realtime_start=${hoy}&realtime_end=${finRango}` +
      `&include_release_dates_with_no_data=true&sort_order=asc&limit=12`;
    try {
      const j = await fetchJson<FredDates>(url, { retries: 2 });
      const vistos = new Set<string>();
      for (const d of j.release_dates ?? []) {
        if (d.date < hoy || vistos.has(d.date)) continue; // sólo futuro, 1 por fecha
        vistos.add(d.date);
        fechas.push(d.date);
        countryIds.push(usa);
        tipos.push(r.tipo);
        titulos.push(r.titulo);
        tonos.push(r.tono);
        fuentes.push('FRED');
      }
    } catch {
      // un release falla → se omite; el resto sigue.
    }
  }

  if (!fechas.length) throw new Error('Calendario sin fechas futuras');

  await query(
    `INSERT INTO calendar_event (fecha, country_id, tipo, titulo, tono, fuente)
     SELECT * FROM unnest($1::date[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[])
     ON CONFLICT (fecha, titulo)
     DO UPDATE SET tipo = EXCLUDED.tipo, tono = EXCLUDED.tono, fuente = EXCLUDED.fuente,
                   country_id = EXCLUDED.country_id`,
    [fechas, countryIds, tipos, titulos, tonos, fuentes],
  );
  return fechas.length;
}
