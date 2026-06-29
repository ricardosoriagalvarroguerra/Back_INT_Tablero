// Cliente HTTP robusto para la ingesta: timeout, reintentos con backoff y
// throttle por host (p.ej. GDELT: 1 req / 5 s). Usa el fetch global de Node.

const DEFAULT_UA = 'TableroINT/0.1 (+intelligence dashboard; contacto: ops)';

const lastHit = new Map<string, number>();

/** Espera lo necesario para respetar `minIntervalMs` entre llamadas al host. */
export async function throttle(host: string, minIntervalMs: number): Promise<void> {
  const prev = lastHit.get(host) ?? 0;
  const wait = prev + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FetchOpts {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

async function raw(url: string, opts: FetchOpts): Promise<Response> {
  const { timeoutMs = 25_000, retries = 2, headers = {} } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
      });
      // 429/5xx → reintenta con backoff; otros se devuelven al caller.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error(`fetch falló: ${url}`);
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await raw(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await raw(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

/** Igual que fetchJson pero devuelve null en vez de lanzar (para degradado suave). */
export async function tryJson<T>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  try {
    return await fetchJson<T>(url, opts);
  } catch {
    return null;
  }
}
