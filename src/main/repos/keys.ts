import { getDb, nowIso } from '../db';
import { BUILTIN_PROVIDERS, DEFAULT_BASE_URLS, PROVIDER_LABELS, type ApiKeyInfo, type BuiltinProvider } from '@shared/types';

/** Abstracts Electron's safeStorage so the repo is testable outside Electron. */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

let cipher: SecretCipher | null = null;
export function setSecretCipher(c: SecretCipher): void {
  cipher = c;
}
function getCipher(): SecretCipher {
  if (!cipher) throw new Error('Secret cipher not initialised');
  if (!cipher.isAvailable()) throw new Error('OS secure storage is not available; cannot store API keys.');
  return cipher;
}

const isBuiltin = (p: string): p is BuiltinProvider => (BUILTIN_PROVIDERS as readonly string[]).includes(p);

export function maskKey(key: string): string {
  return `••••${key.slice(-4)}`;
}

interface KeyRow {
  provider: string;
  display_name: string;
  encrypted_key: Buffer | null;
  base_url: string | null;
}

export function listKeys(): ApiKeyInfo[] {
  const rows = getDb().prepare('SELECT provider, display_name, encrypted_key, base_url FROM api_keys').all() as KeyRow[];
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const out: ApiKeyInfo[] = [];
  const describe = (provider: string, row: KeyRow | undefined): ApiKeyInfo => {
    let masked: string | null = null;
    if (row?.encrypted_key) {
      try {
        masked = maskKey(getCipher().decrypt(row.encrypted_key));
      } catch {
        masked = '(unreadable — re-enter key)';
      }
    }
    return {
      provider,
      displayName: row?.display_name ?? (isBuiltin(provider) ? PROVIDER_LABELS[provider] : provider),
      baseUrl: row?.base_url ?? (isBuiltin(provider) ? DEFAULT_BASE_URLS[provider] : null),
      masked,
      isCustom: !isBuiltin(provider),
    };
  };
  for (const p of BUILTIN_PROVIDERS) out.push(describe(p, byProvider.get(p)));
  for (const r of rows) if (!isBuiltin(r.provider)) out.push(describe(r.provider, r));
  return out;
}

export function setKey(input: { provider: string; key?: string; baseUrl?: string | null; displayName?: string }): void {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM api_keys WHERE provider = ?').get(input.provider) as KeyRow | undefined;
  if (!isBuiltin(input.provider) && !existing && !input.baseUrl) {
    throw new Error('Custom providers need a base URL.');
  }
  const encrypted = input.key ? getCipher().encrypt(input.key.trim()) : existing?.encrypted_key ?? null;
  const displayName =
    input.displayName ?? existing?.display_name ?? (isBuiltin(input.provider) ? PROVIDER_LABELS[input.provider] : input.provider);
  const baseUrl = input.baseUrl !== undefined ? input.baseUrl : existing?.base_url ?? null;
  db.prepare(
    `INSERT INTO api_keys (provider, display_name, encrypted_key, base_url, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET display_name=excluded.display_name, encrypted_key=excluded.encrypted_key,
       base_url=excluded.base_url, updated_at=excluded.updated_at`,
  ).run(input.provider, displayName, encrypted, baseUrl, nowIso());
}

export function deleteKey(provider: string): void {
  getDb().prepare('DELETE FROM api_keys WHERE provider = ?').run(provider);
}

/** Main-process only. Never send the result over IPC or log it. */
export function getProviderCredentials(provider: string): { apiKey: string; baseUrl: string | null } | null {
  const row = getDb().prepare('SELECT encrypted_key, base_url FROM api_keys WHERE provider = ?').get(provider) as
    | Pick<KeyRow, 'encrypted_key' | 'base_url'>
    | undefined;
  if (!row?.encrypted_key) return null;
  const baseUrl = row.base_url ?? (isBuiltin(provider) ? DEFAULT_BASE_URLS[provider] : null);
  return { apiKey: getCipher().decrypt(row.encrypted_key), baseUrl };
}
