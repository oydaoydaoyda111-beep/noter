# Agent guidance for Noter

## Project

Read `MEMORY.md` for established product decisions, completed work, and known limitations. Keep that file concise and current when decisions change; do not store secrets or private financial records.

Noter is a Tauri 2 desktop personal workspace built with Rust, strict TypeScript, Vite, and native DOM APIs. It includes a Markdown editor, folders, tabs, search, settings, and embedded databases with table, kanban, and calendar views. Desktop notes are Markdown files in a user-selected folder. Shared metadata and Finance JSON/Excel files live in `.noter` for Syncthing. There is no backend. The browser preview retains legacy localStorage/IndexedDB for development and migration.

## Setup and commands

- Use npm and the committed `package-lock.json`. Install dependencies with `npm ci`.
- Use a Node.js version supported by the locked Vite release; Node.js 24 works with this project.
- `npm run desktop:dev` launches Tauri with its fixed Vite port 1420.
- `npm run desktop:build` builds native bundles; platform prerequisites are required.
- `npm run desktop:package` builds the app and creates a DMG on macOS without Finder automation.
- `npm run desktop:test` runs Rust vault regression tests.
- `npm run dev` starts the development server on localhost.
- `npm run check` checks TypeScript without generating files.
- `npm run build` checks TypeScript and builds the production app into `dist/`.
- `npm run preview` serves the production build locally.
- `npm test` runs database regression tests with the built-in Node.js test runner (Node.js 24).
- There is currently no lint script. Do not report lint checks as passing.

## Code map

- `src/main.ts`: styles and application entry point.
- `src/app.ts`: application composition, events, and save coordination.
- `src/types.ts`: workspace and settings types.
- `src/state/`: workspace store and initial/demo data.
- `src/storage/storage.ts`: workspace validation and asynchronous platform persistence.
- `src/desktop/`: native platform adapters, file dialogs, startup folder selection, and browser migration support.
- `src-tauri/src/vault.rs`: Markdown/metadata persistence, file revision checks, safe paths, and recoverable snapshots.
- `src-tauri/src/archive.rs`: bounded native Excel ZIP processing on worker threads.
- `src-tauri/src/lib.rs`: scoped native commands, platform plugins, and desktop menus.
- `src/finance/`: precise transaction model, IndexedDB persistence, template-preserving Excel import/export, and the Finance view. Finance is saved separately from notes, as native JSON plus an Excel template or legacy IndexedDB.
- `src/editor/`: editing, Markdown conversion, selection, history, slash commands, and syntax highlighting.
- `src/database/`: database models, serialization, and views.
- `src/tree/`, `src/tabs/`, `src/search/`, `src/settings/`: feature-specific UI.
- `src/ui/`: shared DOM helpers, icons, menus, dialogs, and motion.
- `src/styles/`: design tokens and application, editor, and database styles.

## Implementation rules

- Follow the existing native DOM and TypeScript patterns. Keep feature logic in its corresponding module and reuse shared UI helpers.
- Keep strict type checking, including unused-variable checks, passing. Avoid introducing `any` or disabling compiler checks to hide errors.
- Use CSS design tokens and existing component styles. Preserve keyboard navigation, accessible names, focus behavior, and reduced-motion preferences.
- Treat note text, imported Markdown, URLs, and saved workspace JSON as untrusted input. Use text nodes for user content and preserve URL validation; never interpolate user content into HTML.
- Preserve existing saved workspaces and Markdown/database round trips. If a data format changes, provide compatible loading or a deliberate migration.
- Keep edits, selection, undo/redo, tab switching, and autosave working together. Avoid resetting editor DOM unnecessarily during ordinary typing.
- Do not add dependencies unless they serve a concrete requirement. Update the manifest and lockfile together when dependencies change.
- Never commit `node_modules/`, `dist/`, secrets, or environment files. Preserve unrelated user changes.

## Validation and ongoing work

- Run `npm test` for database model or persistence changes.
- Run `npm test` for finance changes; set `BANK_TEST_WORKBOOK` to a local bank workbook path for the optional real-workbook round-trip check. Never commit private financial files or print transaction details in test failures.
- Run `npm run build` after code changes; it includes the TypeScript check. Run `npm run check` when a faster intermediate check helps.
- For native storage changes, run `npm run desktop:test`. Preserve readable Markdown, metadata IDs, integer cents, and the original Excel template. Keep revision checks and symlink/path restrictions; never silently overwrite incoming synced changes.
- For interaction changes, verify the affected desktop or browser flow and relevant keyboard behavior. For persistence changes, verify saving and reloading without losing existing notes.
- Add focused regression tests when a behavioral change warrants them; avoid tests that merely repeat implementation details.
- Report what changed, how it was verified, and any remaining limitation accurately.
- Ask the user which feature to implement next when the requested work is complete. Offer a few concrete options grounded in the current app, then implement their choice and look for improvements within that scope.
- Do not invent a feature backlog or perform destructive data resets without the user's direction.
