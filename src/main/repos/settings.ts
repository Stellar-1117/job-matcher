import { getDb } from '../db';
import { AppSettingsSchema, DEFAULT_SETTINGS, type AppSettings, type SettingsKey } from '@shared/settings';

export function getSettings(): AppSettings {
  const rows = getDb().prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[];
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const shape = AppSettingsSchema.shape;
  for (const r of rows) {
    if (!(r.key in shape)) continue;
    try {
      const parsed = shape[r.key as SettingsKey].safeParse(JSON.parse(r.value_json));
      if (parsed.success) out[r.key] = parsed.data;
    } catch {
      // corrupt value: fall back to the default
    }
  }
  return out as AppSettings;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  );
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      stmt.run(k, JSON.stringify(v));
    }
  })();
  return getSettings();
}

/** Internal flags that aren't user settings (e.g. seed markers). */
export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(`meta:${key}`) as
    | { value_json: string }
    | undefined;
  return row ? (JSON.parse(row.value_json) as string) : null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(`meta:${key}`, JSON.stringify(value));
}
