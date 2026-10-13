# Job Matcher

Local desktop app (Electron + React + TypeScript + SQLite) that collects job postings, analyzes them against resume profiles with LLMs, and exports the best matches. No server, no login, no telemetry.

## Using it

1. **Settings → API keys**: add keys (stored encrypted with the OS keychain via Electron `safeStorage`). Check **Task routing** to pick which model handles each task — tasks marked as containing personal data send your resume to that provider.
2. **Profiles**: create a profile, upload a resume (PDF/DOCX/TXT), check the parsed result, set hard filters and soft preferences.
3. **Settings → Companies**: add companies by careers URL (Greenhouse, Lever, Ashby, Workday and iCIMS are detected; anything else is read as a generic page).
4. **Collect**: pick a date range and sources, paste job-platform links, and collect.
5. **Jobs & Analyze**: one screen to add links, browse saved jobs and analyze them.
   - Pick profiles and which jobs to analyze: a date range by **posted date** or **date added**, or the jobs ticked in the list ("Selected in list"). Check the cost estimate, then run.
   - Each job shows the profiles it was analyzed for, with the score (or "filtered" / "skipped"). Group the list by **Analyzed profiles**, or filter it to jobs analyzed / not analyzed for a profile.
   - Pages the app can't read land in **Needs manual paste**: paste the description, or use **Retry fetching all** after the app learns to read a site.
   - **Re-fetch selected** downloads and reads the ticked jobs again on the next run (e.g. to pick up details the app learned to read later, such as a work mode stated only in the page title). Scores are kept; pasted descriptions are left alone.
6. **Results**: filter, review (opening a row marks it reviewed), set statuses, and export the selection as `.txt` / `.csv` or to the clipboard. The CSV file columns are `company, role, link, work_type, location, score, verdict, summary` — role, company and location come from the job description itself, work type is Remote / Hybrid / Onsite. **CSV + Copy to clipboard** copies rows laid out for a job sheet — Company | Role | Link | Work type | (blank) | Location — as plain tab-separated text: paste into the first empty Company cell and each value lands in its own column, keeping the sheet's formatting and dropdowns. Tick "Include a header row" for an empty sheet.
7. **Usage**: this month's spend against the budget, by task, model, day and run.

### Keeping LLM costs down

- Every step is cached: a job's description is extracted once per prompt + model, a job × profile match is scored once per resume + prompt + model. Re-running an analysis is free unless **Re-analyze** is on.
- Hard filters run in code before any LLM call; the optional **quick pre-score** skips weak matches before full matching; closed postings are caught by rules first.
- Prompts put everything shared (instructions, taxonomy, output schema, the candidate) before the job, so providers serve it from the prompt cache; JSON sent to the model is compact and very long pages are capped.
- The estimate shows the cost before every run and checks it against the monthly budget.
- The biggest lever is **Task routing**: matching with thinking at a high effort is most of the bill, and extraction / pre-score run fine on a cheaper model.

### Hard-to-read sites

The fetch ladder is ATS API → plain HTTP (JSON-LD, then Readability) → hidden browser window. The hidden browser uses a user agent that matches its real Chrome engine and waits through bot checks (Cloudflare's "Just a moment…"), reloading once the check's cookie is set. A work mode stated outside the description (JSON-LD `TELECOMMUTE`, Welcome to the Jungle's "Fully-remote" / "A few days at home" / "No remote work" title tag) is added on top of the saved description. ZipRecruiter has its own page reader, and its expired links (which land on its search page) are marked closed. Pages that still can't be read go to **Needs manual paste**.

## Commands

```bash
npm install          # also downloads Electron and prepares native deps
npm run dev          # run with hot reload (main process restarts on change)
npm run build        # production bundles into out/
npm test             # unit tests (vitest)
npm run typecheck
npm run dist:win     # Windows installer + zip via electron-builder (unsigned)
npm run dist:mac     # macOS .dmg + .zip for Apple Silicon and Intel — must run on a Mac
```

## Running without npm

`npm run dist:win` produces, in `dist/`:

- `Job Matcher-Setup-<version>.exe` — installer (Start menu + desktop shortcut). Recommended; re-run it to update.
- `Job Matcher-<version>-win.zip` — extract anywhere and run `Job Matcher.exe`.
- `win-unpacked/Job Matcher.exe` — the unpacked app, runnable in place. Close it before rebuilding: while it runs, its `resources\app.asar` is locked and the build can't replace it.

All variants share the same database: `%APPDATA%\Job Matcher\jobmatcher.db`. For testing, set `JOB_MATCHER_USER_DATA=<folder>` to run against a separate, throwaway data folder (own DB, no saved keys).

**Windows Smart App Control.** The app isn't code-signed. Smart App Control lets the stock Electron
binary run because its hash is well known, but blocks any *modified* unsigned exe ("An Application
Control policy has blocked this file"). The build therefore ships Electron's exe byte-for-byte
unchanged (`win.signAndEditExecutable: false`, `disableAsarIntegrity: true`, no fuses) — which is
also why the exe shows the default Electron icon and file details. Don't re-enable those options
without a real code-signing certificate.

### macOS

macOS packages can only be built on a Mac: run `npm run dist:mac` there, or run the **Build** workflow
(`.github/workflows/build.yml`) on GitHub (Actions → Build → Run workflow, or push a `v*` tag) and download
the `.dmg` from the run's artifacts. It produces separate Apple Silicon (`arm64`) and Intel (`x64`) builds,
because better-sqlite3's native binary is per CPU.

The app has no Apple Developer ID, so it's only ad-hoc signed and not notarized. On first launch macOS says
it can't verify the developer: open **System Settings → Privacy & Security** and click **Open Anyway**
(or run `xattr -dr com.apple.quarantine "/Applications/Job Matcher.app"`). Data lives in
`~/Library/Application Support/Job Matcher/jobmatcher.db`.

**Gotcha:** if `ELECTRON_RUN_AS_NODE=1` is set in your shell (VS Code-spawned terminals inherit it), Electron starts as plain Node and fails with `Cannot read properties of undefined (reading 'whenReady')`. Unset it before `npm run dev` or launching the exe from that shell. Double-clicking is unaffected.

## Layout

```
src/shared/     types, Zod schemas (LLM outputs, settings), IPC contract, scoring, taxonomy, date ranges
src/main/       main process: db/ (migrations), repos/, llm/ (provider adapters + complete()), seed/, ipc.ts
  sources/      job source adapters (greenhouse, lever, ashby, workday, icims, generic), URL normalization, ATS detection,
                dedupe, dates; site readers (ziprecruiter.ts)
  net/          HTTP client (per-host concurrency, backoff on 429/5xx, timeouts, cancellation); hidden-browser page renderer
                (bot-check aware)
  analysis/     fetch ladder (ATS API → HTTP/JSON-LD/site readers/Readability → hidden browser → manual paste), closed-posting
                rules, pipeline steps (extraction, hard filters, pre-score, matching) and the cost estimate
  runs/         background runs (collect, analyze) with progress events, cancel and resume; analyze runs are a
                persistent queue (run_items) and resume automatically after a restart
  resume/       resume text extraction (PDF/DOCX/TXT) and background parsing
  repos/        SQLite access; jobs.ts (job list incl. analyzed profiles), results.ts (per-profile results, status, export),
                usage.ts (Usage screen)
src/preload/    contextBridge exposing a typed `window.api.invoke/on`
src/renderer/   React UI (Tailwind; results table on TanStack Table); screens/jobs/ holds Jobs & Analyze
tests/          vitest unit tests (fixtures/ for ATS responses and site pages)
```

All network, DB, file and LLM work runs in the main process. The renderer only talks through the typed IPC bridge; every IPC payload is validated with Zod in main.
