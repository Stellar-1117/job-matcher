import type Database from 'better-sqlite3';

export interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

/**
 * Append-only list. Never edit a migration that has shipped; add a new one instead.
 * Tables for later milestones (jobs, profiles, analyses, runs, ...) are added by their own migrations.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'settings_models_routes_prompts_keys_usage',
    up: (db) => {
      db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );

        CREATE TABLE models (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          display_name TEXT NOT NULL,
          provider TEXT NOT NULL,
          model_id TEXT NOT NULL,
          supports_thinking INTEGER NOT NULL DEFAULT 0,
          thinking_style TEXT NOT NULL DEFAULT 'none',
          supports_json_schema INTEGER NOT NULL DEFAULT 0,
          price_in REAL NOT NULL DEFAULT 0,
          price_out REAL NOT NULL DEFAULT 0,
          price_cache_read REAL NOT NULL DEFAULT 0,
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE task_routes (
          task TEXT PRIMARY KEY,
          model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
          thinking_enabled INTEGER NOT NULL DEFAULT 0,
          thinking_level TEXT NOT NULL DEFAULT 'low',
          fallback_model_id INTEGER REFERENCES models(id) ON DELETE SET NULL
        );

        CREATE TABLE prompts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task TEXT NOT NULL,
          version INTEGER NOT NULL,
          content TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(task, version)
        );
        CREATE INDEX idx_prompts_task ON prompts(task);

        CREATE TABLE api_keys (
          provider TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          encrypted_key BLOB,
          base_url TEXT,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE usage_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER,
          task TEXT NOT NULL,
          model_id INTEGER,
          model_name TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_usage_created ON usage_log(created_at);
        CREATE INDEX idx_usage_task_model ON usage_log(task, model_id);
      `);
    },
  },
  {
    id: 2,
    name: 'model_effort_and_jobs',
    up: (db) => {
      db.exec(`
        ALTER TABLE models ADD COLUMN effort_levels TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE models ADD COLUMN default_effort TEXT;
        ALTER TABLE models ADD COLUMN server_fallback INTEGER NOT NULL DEFAULT 0;

        ALTER TABLE task_routes ADD COLUMN effort TEXT;
        UPDATE task_routes SET effort = CASE WHEN thinking_enabled = 1 THEN thinking_level ELSE NULL END;
        ALTER TABLE task_routes DROP COLUMN thinking_level;

        CREATE TABLE companies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          careers_url TEXT NOT NULL,
          ats_type TEXT NOT NULL DEFAULT 'generic',
          board_token TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical_url TEXT NOT NULL UNIQUE,
          source_key TEXT NOT NULL,
          company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
          company_name TEXT,
          title TEXT,
          location_raw TEXT,
          posted_at TEXT,
          posted_at_source TEXT NOT NULL DEFAULT 'first_seen',
          first_seen_at TEXT NOT NULL,
          description_text TEXT,
          fetch_status TEXT NOT NULL DEFAULT 'pending',
          is_closed INTEGER NOT NULL DEFAULT 0,
          closed_reason TEXT,
          closed_detected_at TEXT,
          dedupe_key TEXT,
          raw_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_jobs_source ON jobs(source_key);
        CREATE INDEX idx_jobs_dedupe ON jobs(dedupe_key);
        CREATE INDEX idx_jobs_first_seen ON jobs(first_seen_at);

        CREATE TABLE job_urls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          url TEXT NOT NULL UNIQUE,
          source_key TEXT NOT NULL
        );
        CREATE INDEX idx_job_urls_job ON job_urls(job_id);
      `);
    },
  },
  {
    id: 3,
    name: 'profiles_resumes',
    up: (db) => {
      db.exec(`
        CREATE TABLE profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          preferences_json TEXT NOT NULL DEFAULT '{}',
          active_resume_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE resumes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          file_name TEXT NOT NULL,
          file_kind TEXT NOT NULL,
          file_blob BLOB,
          text TEXT NOT NULL,
          structured_json TEXT,
          structured_parsed_json TEXT,
          structured_edited INTEGER NOT NULL DEFAULT 0,
          parse_status TEXT NOT NULL DEFAULT 'pending',
          parse_error TEXT,
          prompt_version_id INTEGER,
          model_id INTEGER,
          model_name TEXT,
          parsed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(profile_id, version)
        );
        CREATE INDEX idx_resumes_profile ON resumes(profile_id);
      `);
    },
  },
  {
    id: 4,
    name: 'collection_runs',
    up: (db) => {
      db.exec(`
        ALTER TABLE jobs ADD COLUMN external_id TEXT;
        ALTER TABLE jobs ADD COLUMN last_seen_at TEXT;
        CREATE INDEX idx_jobs_company ON jobs(company_id);
        CREATE INDEX idx_jobs_external ON jobs(source_key, external_id);

        CREATE TABLE runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          params_json TEXT NOT NULL,
          status TEXT NOT NULL,
          total INTEGER NOT NULL DEFAULT 0,
          done INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          error_log_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX idx_runs_type ON runs(type, id);

        CREATE TABLE source_health (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          source_key TEXT NOT NULL,
          company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
          label TEXT NOT NULL,
          jobs_found INTEGER NOT NULL DEFAULT 0,
          jobs_in_range INTEGER NOT NULL DEFAULT 0,
          jobs_new INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          error TEXT,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_health_run ON source_health(run_id);
        CREATE INDEX idx_health_company ON source_health(company_id, id);
      `);
    },
  },
  {
    id: 5,
    name: 'analysis',
    up: (db) => {
      db.exec(`
        ALTER TABLE jobs ADD COLUMN fetch_error TEXT;
        ALTER TABLE jobs ADD COLUMN fetched_at TEXT;
        ALTER TABLE jobs ADD COLUMN extraction_id INTEGER;

        -- model_id is the task route's model when the call was made (the cache key); used_model_id is
        -- the model that actually answered (differs when the fallback was used).
        CREATE TABLE job_extractions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          prompt_version_id INTEGER NOT NULL,
          model_id INTEGER NOT NULL,
          used_model_id INTEGER,
          model_name TEXT NOT NULL,
          fields_json TEXT NOT NULL,
          job_function TEXT,
          seniority TEXT,
          industry TEXT,
          company_stage TEXT,
          work_mode TEXT,
          employment_type TEXT,
          remote_region TEXT,
          country TEXT,
          city TEXT,
          salary_min REAL,
          salary_max REAL,
          salary_currency TEXT,
          salary_period TEXT,
          salary_listed INTEGER NOT NULL DEFAULT 0,
          visa_sponsorship TEXT,
          required_years REAL,
          cost_usd REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(job_id, prompt_version_id, model_id)
        );
        CREATE INDEX idx_extractions_job ON job_extractions(job_id);

        CREATE TABLE job_tags (
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          tag_type TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (job_id, tag_type, tag)
        );
        CREATE INDEX idx_job_tags_tag ON job_tags(tag_type, tag);

        CREATE TABLE analyses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          resume_id INTEGER NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
          prompt_version_id INTEGER NOT NULL,
          model_id INTEGER NOT NULL,
          used_model_id INTEGER,
          model_name TEXT,
          extraction_id INTEGER,
          outcome TEXT NOT NULL,
          hard_filter_pass INTEGER NOT NULL,
          hard_filter_reasons_json TEXT NOT NULL DEFAULT '[]',
          hard_filter_results_json TEXT NOT NULL DEFAULT '[]',
          pre_score REAL,
          pre_score_reason TEXT,
          sub_scores_json TEXT,
          strengths_json TEXT,
          gaps_json TEXT,
          summary TEXT,
          cost_usd REAL NOT NULL DEFAULT 0,
          run_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(job_id, profile_id, resume_id, prompt_version_id, model_id)
        );
        CREATE INDEX idx_analyses_profile ON analyses(profile_id, job_id);
        CREATE INDEX idx_analyses_run ON analyses(run_id);

        CREATE TABLE run_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
          profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
          step TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          outcome TEXT,
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          updated_at TEXT
        );
        CREATE INDEX idx_run_items_run ON run_items(run_id, status);
        CREATE INDEX idx_run_items_job ON run_items(job_id);

        CREATE TABLE unreadable_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          domain TEXT NOT NULL,
          url TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_unreadable_domain ON unreadable_log(domain);
      `);
    },
  },
  {
    id: 6,
    name: 'job_profile_status',
    up: (db) => {
      db.exec(`
        -- Per job × profile review state (§2): one profile's status never affects another's.
        -- No row = "new".
        CREATE TABLE job_profile_status (
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'new',
          feedback INTEGER NOT NULL DEFAULT 0,
          feedback_note TEXT,
          exported_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (job_id, profile_id)
        );
        CREATE INDEX idx_jps_profile ON job_profile_status(profile_id, status);
      `);
    },
  },
];

export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
  );
  const ran: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
    })();
    ran.push(m.id);
  }
  return ran;
}
