import { bool, getDb } from '../db';
import type { CompanyInput, CompanyRow, SourceHealthRow } from '@shared/collect';
import type { CompanyRef } from '../sources/types';
import { toHealthRow } from './runs';

export function listCompanies(): CompanyRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM jobs j WHERE j.company_id = c.id) AS job_count,
         (SELECT MAX(h.id) FROM source_health h WHERE h.company_id = c.id) AS last_health_id
       FROM companies c ORDER BY c.name COLLATE NOCASE`,
    )
    .all() as any[];
  const healthIds = rows.map((r) => r.last_health_id).filter((x) => x != null);
  const health = new Map<number, SourceHealthRow>();
  if (healthIds.length) {
    const hs = db.prepare(`SELECT * FROM source_health WHERE id IN (${healthIds.map(() => '?').join(',')})`).all(...healthIds) as any[];
    for (const h of hs) health.set(h.id, toHealthRow(h));
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    careersUrl: r.careers_url,
    atsType: r.ats_type,
    boardToken: r.board_token,
    enabled: bool(r.enabled),
    createdAt: r.created_at,
    lastHealth: r.last_health_id != null ? health.get(r.last_health_id) ?? null : null,
    jobCount: r.job_count,
  }));
}

export function getCompanyRef(id: number): CompanyRef | null {
  const r = getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id) as any;
  return r ? { id: r.id, name: r.name, careersUrl: r.careers_url, atsType: r.ats_type, boardToken: r.board_token } : null;
}

function findDuplicate(input: CompanyInput, excludeId?: number): string | null {
  const db = getDb();
  const sameBoard =
    input.boardToken &&
    (db.prepare('SELECT name FROM companies WHERE ats_type = ? AND lower(board_token) = lower(?) AND id IS NOT ?').get(input.atsType, input.boardToken, excludeId ?? null) as
      | { name: string }
      | undefined);
  if (sameBoard) return sameBoard.name;
  const sameUrl = db.prepare('SELECT name FROM companies WHERE careers_url = ? AND id IS NOT ?').get(input.careersUrl, excludeId ?? null) as { name: string } | undefined;
  return sameUrl?.name ?? null;
}

export function addCompany(input: CompanyInput): number {
  const dup = findDuplicate(input);
  if (dup) throw new Error(`"${dup}" already uses this careers board.`);
  const res = getDb()
    .prepare('INSERT INTO companies (name, careers_url, ats_type, board_token, enabled) VALUES (?, ?, ?, ?, 1)')
    .run(input.name, input.careersUrl, input.atsType, input.atsType === 'generic' ? null : input.boardToken);
  return Number(res.lastInsertRowid);
}

export function updateCompany(id: number, patch: Partial<CompanyInput> & { enabled?: boolean }): void {
  const cur = getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id) as any;
  if (!cur) throw new Error('Company not found');
  const next: CompanyInput = {
    name: patch.name ?? cur.name,
    careersUrl: patch.careersUrl ?? cur.careers_url,
    atsType: patch.atsType ?? cur.ats_type,
    boardToken: patch.boardToken !== undefined ? patch.boardToken : cur.board_token,
  };
  const dup = findDuplicate(next, id);
  if (dup) throw new Error(`"${dup}" already uses this careers board.`);
  getDb()
    .prepare('UPDATE companies SET name = ?, careers_url = ?, ats_type = ?, board_token = ?, enabled = ? WHERE id = ?')
    .run(next.name, next.careersUrl, next.atsType, next.atsType === 'generic' ? null : next.boardToken, patch.enabled ?? bool(cur.enabled) ? 1 : 0, id);
}

export function deleteCompany(id: number): void {
  getDb().prepare('DELETE FROM companies WHERE id = ?').run(id);
}
