import { bool, getDb } from '../db';
import type { TaskKey } from '@shared/tasks';
import type { PromptVersion } from '@shared/types';

function toPrompt(r: any): PromptVersion {
  return {
    id: r.id,
    task: r.task,
    version: r.version,
    content: r.content,
    notes: r.notes,
    is_active: bool(r.is_active),
    created_at: r.created_at,
  };
}

export function listPrompts(task: TaskKey): PromptVersion[] {
  return (getDb().prepare('SELECT * FROM prompts WHERE task = ? ORDER BY version DESC').all(task) as any[]).map(toPrompt);
}

export function getPrompt(id: number): PromptVersion | null {
  const r = getDb().prepare('SELECT * FROM prompts WHERE id = ?').get(id);
  return r ? toPrompt(r) : null;
}

export function getActivePrompt(task: TaskKey): PromptVersion | null {
  const r = getDb().prepare('SELECT * FROM prompts WHERE task = ? AND is_active = 1').get(task);
  return r ? toPrompt(r) : null;
}

/** Prompts are immutable: an "edit" always creates a new version. */
export function createPromptVersion(task: TaskKey, content: string, notes: string, activate: boolean): number {
  const db = getDb();
  return db.transaction(() => {
    const { next } = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM prompts WHERE task = ?').get(task) as {
      next: number;
    };
    const hasActive = !!db.prepare('SELECT 1 FROM prompts WHERE task = ? AND is_active = 1').get(task);
    const makeActive = activate || !hasActive;
    if (makeActive) db.prepare('UPDATE prompts SET is_active = 0 WHERE task = ?').run(task);
    const res = db
      .prepare('INSERT INTO prompts (task, version, content, notes, is_active) VALUES (?, ?, ?, ?, ?)')
      .run(task, next, content, notes, makeActive ? 1 : 0);
    return Number(res.lastInsertRowid);
  })();
}

export function updatePromptNotes(id: number, notes: string): TaskKey {
  const p = getPrompt(id);
  if (!p) throw new Error('Prompt version not found');
  getDb().prepare('UPDATE prompts SET notes = ? WHERE id = ?').run(notes, id);
  return p.task;
}

export function setActivePrompt(id: number): TaskKey {
  const db = getDb();
  const p = getPrompt(id);
  if (!p) throw new Error('Prompt version not found');
  db.transaction(() => {
    db.prepare('UPDATE prompts SET is_active = 0 WHERE task = ?').run(p.task);
    db.prepare('UPDATE prompts SET is_active = 1 WHERE id = ?').run(id);
  })();
  return p.task;
}
