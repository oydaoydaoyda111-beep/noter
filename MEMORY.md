# Noter project memory

Last updated: 2026-10-04. This is a durable handoff, not a feature backlog. Check current code and Git state before relying on historical verification.

## Product decisions and preferences

- Noter is the user's main personal workspace. Supported apps are Tauri desktop and Kotlin/Compose Android; both must use the same portable files for Syncthing. Browser persistence is removed, old browser data is left untouched, and `npm run dev` launches desktop. Vite remains the desktop UI build tool. Android has SAF storage, tree, tabs, scoped note search, autosave, settings, live-styled Markdown with toolbar/slash commands/undo, native databases, and Finance with transactions/transfers/accounts/categories/filters. Moving notes is not yet ported; Excel import/export is deferred by the user. The native apps share the v1 contract in `docs/FILE_STORAGE.md` and synthetic compatibility fixtures.
- The user synchronizes files with Syncthing. Choose the workspace folder on first launch; keep notes readable as Markdown and shared app data in `.noter`. No hosted backend is needed.
- Finance replaces routine Excel entry. Excel remains the backup/export format. Preserve imported workbook formatting, other sheets, formulas, transaction IDs, and transfers.
- Prefer compact UI: small Finance row padding, compact account management, convenient category/subcategory selection and database property management.
- Show an emoji title without an additional generic file icon. New notes ask for a name in a dialog; search offers scope filters.
- Move suitable file and archive work into Rust to reduce frontend work. Continue using strict TypeScript and native DOM APIs for the UI.
- After completing a requested feature, ask what to implement next with a few concrete options. Do not treat suggested options as approved work.

## Implemented capabilities

- Notes: naming dialogs, emoji selection/titles, folders, tabs, Markdown editing, undo/redo, autosave, and scoped search.
- Android search: All/Names/Contents/Folders scopes, case-insensitive literal matching, previews around content matches and folder paths. Debounced scans use current in-memory notes on a worker thread, including unsaved edits, without persisted indexes. A full-screen dialog keeps the editor mounted so closing search preserves selection and undo.
- Databases: property manager, hidden/resizable columns, colored select options, saved named views, bulk row operations, and table/kanban/calendar views.
- Android databases: native table/board/calendar views, record CRUD/duplication, property management, search, exact filters, sorting and switching existing saved views. Database cards replace raw JSON by default; Edit Markdown remains available. Changes use note undo/autosave, preserve unknown JSON and desktop settings, and reject stale block replacements while retaining open drafts. Bulk editing, column resizing/colors and creating/managing saved views remain desktop-only.
- Finance: Excel import/export, transactions and linked transfers, balances, account management with archive/restore and defaults, category/subcategory creation/rename/delete/merge, and searchable selectors with keyboard support.
- Settings: Appearance, Workspace, and Finance tabs; typography, width, density, motion, accent, startup/spellcheck/statistics/autosave preferences, Finance display formats, row count, default account, and entry preferences. Currency labels do not convert amounts.
- Desktop: native folder/open/save dialogs, menus, clipboard and validated external links, embedded offline frontend, and notes JSON/Excel Finance backup import/export.

## Persistence and important boundaries

- `src-tauri/src/vault.rs` owns Markdown files, IDs/paths/order/settings in `.noter/workspace.json`, revision checks, safe paths, symlink restrictions, and recoverable snapshots in `.noter/trash`.
- Desktop load/save reuses the first verified file snapshot for metadata, comparisons and backups, and skips unchanged Markdown destinations. Filename collision checks use a set. Full content checks remain before writes and after saving; a mismatch at the end rejects acknowledgement. Routine sync checks use file metadata on a worker thread, with full content audits on resume, changed metadata, or after a minute. This cache is only a polling hint; saves always read full contents.
- Finance is separate: append-only per-device logs in `.noter/finance/log-<device>.jsonl` (TS/Kotlin replay ordered by ts/dev/seq, last write wins) plus the original `.noter/finance-template.xlsx`. Cents, timestamps and sequences use the same JS-safe integer bounds on both clients. Each installation writes its own log to reduce competing writes; same-record and accounts/categories list edits still use last-write-wins. Legacy `finance.json` is migrated once and moved to trash. Device IDs stay outside the synced folder (desktop app config `device.json`, Android SharedPreferences). Template fingerprints detect mismatched sync state. Incomplete own-log tails are quarantined before repair; uncertain save failures require reload before further edits. No log compaction yet.
- `src-tauri/src/archive.rs` processes bounded Excel ZIP archives on worker threads. `src/finance/archive.ts` uses native commands; `fflate` is a test-only dependency. Workbook export is asynchronous.
- `src/desktop/platform.ts` coordinates native revisions and save queues. `src/app.ts` flushes pending work before closing and checks external changes every five seconds when visible and safe to reload, skipping overlapping checks. Android starts/stops note and Finance polling with activity visibility while keeping background note flushes.
- Note conflict recovery on both apps offers Keep edits and reload: changed notes become readable Markdown in a new Recovered edits folder, with a full v1 notes backup in `.noter/recovery/<timestamp>-<uuid>/workspace.json`. Compare against the last acknowledged snapshot; verify backups before reloading, preserve incoming originals, and retain edits if more typing arrives during reload. Android manual reload and folder switching protect unsaved work. Reconciliation remains manual; settings/deletion intent can be restored through desktop notes backup import.
- Last-used section is device-local (`ui.json` on desktop, SharedPreferences on Android). Existing notes JSON backups exclude Finance; export Finance separately to Excel on desktop.
- Embedded databases round-trip inside fenced `noter-database` Markdown blocks. Preserve metadata IDs and compatibility when changing formats.

## Known limitations

- Desktop replacement uses a flushed temp file and rename. Android SAF is not atomic: completed temporary content, a preserved old document and a device-private journal provide recovery on reopen. Syncthing should ignore only `.noter-*.tmp` and `.noter-write-*`; keep `.noter` data included. A multi-file save or interrupted synchronization can temporarily leave a partial set.
- Finance merges per record (last write wins); concurrent edits to the same transaction keep only the later one. Logs grow without compaction. Markdown conflict copies appear as separate notes.
- Recovery snapshots accumulate; no automatic retention management exists.
- macOS bundles are locally ad-hoc signed, not notarized. Android debug builds and emulator flows are verified; Windows/Linux release packages have not been verified or delivered.

## Validation and repository handoff

- 2026-10-04 latest verification: 23 JavaScript tests passed (optional private-workbook check skipped), production build, Android assembleDebug/assembleDebugAndroidTest/lintDebug and emulator instrumentation passed (lint: 0 errors, 5 existing warnings). Database checks cover typed cells, saved views/settings/unknown fields, CRUD/properties, filters/sorting, fences, stale replacements, SAF save/reopen with other notes intact, undo/redo, visible buttons in all layouts and saving/validation with the keyboard open. Desktop also read an Android-written database successfully. Search/storage/recovery/polling checks passed in the same emulator run. The preceding storage change passed 19 Rust tests and a temporary desktop IPC/keyboard recovery harness. No actual two-device Syncthing run was performed. This delivery also includes the preceding UI and shared-file improvements.

- At the desktop implementation handoff, 19 JavaScript tests and 10 Rust tests passed, including optional real-workbook round trips. Production build, macOS packaging, code-signature verification, and DMG checksum verification passed.
- Native interaction checks covered folder selection, note creation/edit/save, external Markdown reload, Excel import/export through Rust, save-on-close, and persistence after restart. These are historical results; run applicable checks after new code changes as required by `AGENTS.md`.
- The user's private bank workbook is external to the repository. The first sheet is the transaction ledger; the second is balances. Use `BANK_TEST_WORKBOOK` for optional local tests, never commit the workbook or include its records in logs or this file.
- Git remote: `https://github.com/oydaoydaoyda111-beep/noter.git`; branch `main`. The local folder was attached to the existing upstream history without replacing working files.
- Dependencies and generated bundles are ignored (`node_modules`, `dist`, `src-tauri/target`, `src-tauri/gen`). Use npm with the committed lockfile. Rust launch scripts locate Cargo in `~/.cargo/bin`.
- Android database support was the user's selected follow-up and is complete. No next implementation feature is selected.
