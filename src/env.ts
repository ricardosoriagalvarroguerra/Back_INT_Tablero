// Configuración desde el entorno (.env cargado con node --env-file). Secretos
// nunca en el repo. Las keys opcionales se exponen como posiblemente undefined;
// los conectores degradan elegante si faltan.

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export const env = {
  databaseUrl: req('DATABASE_URL', 'postgres://localhost:5432/internacional'),
  // Railway/Render/etc. inyectan el puerto en PORT; respetarlo. Local: API_PORT o 5176.
  apiPort: Number(process.env.PORT || process.env.API_PORT || '5176'),
  // credenciales opcionales (string vacío = ausente)
  fredApiKey: process.env.FRED_API_KEY || '',
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  acledApiKey: process.env.ACLED_API_KEY || '',
  acledEmail: process.env.ACLED_EMAIL || '',
} as const;

export const has = {
  fred: () => env.fredApiKey.length > 0,
  youtube: () => env.youtubeApiKey.length > 0,
  acled: () => env.acledApiKey.length > 0 && env.acledEmail.length > 0,
};
