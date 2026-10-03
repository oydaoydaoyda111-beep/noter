# Noter project memory

Last updated: 2026-10-03. This is a durable handoff, not a feature backlog. Check current code and Git state before relying on historical verification.

## Product decisions and preferences

- Noter is the user's main personal workspace. Tauri desktop is the primary product; the browser preview remains for development and migration. A future Kotlin mobile client is an intention, not implemented work.
- The user synchronizes files with Syncthing. Choose the workspace folder on first launch; keep notes readable as Markdown and shared app data in `.noter`. No hosted backend is needed.
- Finance replaces routine Excel entry. Excel remains the backup/export format. Preserve imported workbook formatting, other sheets, formulas, transaction IDs, and transfers.
- Prefer compact UI: small Finance row padding, compact account management, convenient category/subcategory selection and database property management.
- Show an emoji title without an additional generic file icon. New notes ask for a name in a dialog; search offers scope filters.
- Move suitable file and archive work into Rust to reduce frontend work. Continue using strict TypeScript and native DOM APIs for the UI.
- After completing a requested feature, ask what to implement next with a few concrete options. Do not treat suggested options as approved work.

## Implemented capabilities

- Notes: naming dialogs, emoji selection/titles, folders, tabs, Markdown editing, undo/redo, autosave, and scoped search.
- Databases: property manager, hidden/resizable columns, colored select options, saved named views, bulk row operations, and table/kanban/calendar views.
- Finance: Excel import/export, transactions and linked transfers, balances, account management with archive/restore and defaults, category/subcategory creation/rename/delete/merge, and searchable selectors with keyboard support.
- Settings: Appearance, Workspace, and Finance tabs; typography, width, density, motion, accent, startup/spellcheck/statistics/autosave preferences, Finance display formats, row count, default account, and entry preferences. Currency labels do not convert amounts.
- Desktop: native folder/open/save dialogs, menus, clipboard and validated external links, embedded offline frontend, and notes/Finance browser migration through backups.

## Persistence and important boundaries

- `src-tauri/src/vault.rs` owns Markdown files, IDs/paths/order/settings in `.noter/workspace.json`, revision checks, safe paths, symlink restrictions, and recoverable snapshots in `.noter/trash`.
- Finance is separate: `.noter/finance.json` (schema version 1, signed integer cents) plus the original `.noter/finance-template.xlsx`. A template fingerprint detects mismatched sync state. Never silently overwrite incoming synced changes.
- `src-tauri/src/archive.rs` processes bounded Excel ZIP archives on worker threads. `src/finance/archive.ts` uses native commands on desktop and lazily loads `fflate` in browser preview. Workbook export is asynchronous.
- `src/desktop/platform.ts` coordinates native revisions and save queues. `src/app.ts` flushes pending work before closing and checks external changes every five seconds when safe to reload.
- Browser legacy stores remain available for migration: notes in localStorage `noter.workspace.v1`, Finance in IndexedDB `noter.finance.v1`. Notes JSON backups exclude Finance; export Finance separately to Excel.
- Embedded databases round-trip inside fenced `noter-database` Markdown blocks. Preserve metadata IDs and compatibility when changing formats.

## Known limitations

- Writes are atomic per file, not across the whole workspace. An interrupted operation or synchronization can temporarily leave a partial set.
- Finance sync conflict copies block writes and require manual resolution; automatic record merging is not implemented. Markdown conflict copies appear as separate notes.
- Recovery snapshots accumulate; no automatic retention management exists.
- macOS bundles are locally ad-hoc signed, not notarized. Windows/Linux packages and a mobile client have not been verified or delivered.

## Validation and repository handoff

- At the desktop implementation handoff, 19 JavaScript tests and 10 Rust tests passed, including optional real-workbook round trips. Production build, macOS packaging, code-signature verification, and DMG checksum verification passed.
- Native interaction checks covered folder selection, note creation/edit/save, external Markdown reload, Excel import/export through Rust, save-on-close, and persistence after restart. These are historical results; run applicable checks after new code changes as required by `AGENTS.md`.
- The user's private bank workbook is external to the repository. The first sheet is the transaction ledger; the second is balances. Use `BANK_TEST_WORKBOOK` for optional local tests, never commit the workbook or include its records in logs or this file.
- Git remote: `git@github.com:oydaoydaoyda111-beep/noter.git`; branch `main`. Implementation commit `885c45015adde262ab4aee71a24d67c07a690a4b` was pushed successfully. The local folder was attached to the existing upstream history without replacing working files.
- Dependencies and generated bundles are ignored (`node_modules`, `dist`, `src-tauri/target`, `src-tauri/gen`). Use npm with the committed lockfile. Rust launch scripts locate Cargo in `~/.cargo/bin`.
- No next implementation feature is selected. Last offered options were note history, sync conflict resolution, and Finance improvements.
