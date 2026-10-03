# Noter

A Tauri desktop workspace for Markdown notes, embedded databases, and personal Finance. Desktop data lives in a folder you choose, so you can synchronize it with Syncthing and edit your notes with other Markdown tools.

## Run and build

Requirements: Node.js 24, Rust through [rustup](https://rust-lang.org/tools/install/), and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) (Xcode on macOS).

```sh
npm ci
npm run desktop:dev
npm run desktop:build
```

`desktop:dev` starts Vite on port 1420 and launches the native app. Production builds embed the frontend and work offline without a development server. The launcher also finds Rust in `~/.cargo/bin` without requiring a shell-profile change.

Build outputs are in `src-tauri/target/release/bundle/`. On macOS `desktop:build` produces `Noter.app`; `npm run desktop:package` also creates a DMG using macOS disk-image tools without Finder automation. Build Windows/Linux packages on their corresponding platforms; those targets have not been verified here. The local macOS build is ad-hoc signed, not notarized for public distribution.

```sh
npm test
npm run desktop:test
npm run build
```

The browser preview (`npm run dev`) remains useful for development and migrating existing browser data; the desktop app is the primary product.

## Workspace files and Syncthing

On first launch, choose an empty folder or an existing Markdown folder. The location is remembered on that device. Change it in Settings → Workspace or File → Choose Workspace Folder.

```text
Your workspace/
  Journal/
    ✅ October 2.md
  Projects/
    Notes App.md
  .noter/
    workspace.json
    finance/
      log-<device>.jsonl
    finance-template.xlsx
    trash/
```

- Notes are UTF-8 `.md` files. Folders and emoji filenames are preserved. Filename characters unsupported on Windows are normalized when saving. Embedded Noter databases remain fenced `noter-database` blocks inside their Markdown notes.
- `.noter/workspace.json` contains note IDs, file paths, ordering, tabs, and preferences, without duplicating note content.
- `.noter/finance/log-<device>.jsonl` holds Finance as one append-only change log per device: accounts, category definitions, defaults, and transactions. Each device writes only its own log, so Syncthing never creates conflicting copies; every device replays all logs, and the latest change wins per transaction or setting. Amounts are signed integer cents. A former `.noter/finance.json` is migrated once and moved to `.noter/trash`.
- `.noter/finance-template.xlsx` preserves the imported workbook's other sheets and formatting for Excel exports. Import through Finance once; export `.xlsx` backups with the native save dialog. Don't edit this template directly: reimport a changed workbook through Noter.
- `.noter/trash` keeps prior note versions, removed notes, and Finance snapshots. These are ordinary files you can copy back manually. It can grow over time; manage it yourself when backups are no longer needed.

Sync the **whole workspace folder, including `.noter`**. Syncthing performs the synchronization; Noter does not upload anything or require an account. If you have custom ignore rules, make sure they do not exclude `.noter` or its Finance template. App binaries, development caches, and the device's chosen-folder configuration are outside the workspace and should not be synced.

Noter checks for incoming changes every five seconds when there are no unsaved edits or open dialogs. You can also use File → Reload Synced Files. Saves check the disk revision before writing. If your unsaved notes conflict with incoming files, Noter offers to export the edits before reloading. Markdown conflict copies remain visible as separate notes. Finance changes from different devices merge automatically through the per-device logs; if two devices edit the same transaction before syncing, the later edit wins.

File storage, safe-path checks, revision hashing, recovery snapshots, and Excel ZIP compression/decompression run in Rust. Native workbook archive processing runs on worker threads; the desktop UI does not load the browser ZIP library.

Each file is replaced atomically. A workspace involves multiple files, so an interrupted sync or crash can still leave a partial set temporarily. Finance waits if its template and log fingerprints differ. Keep regular Excel/notes backups and Syncthing versioning if you want additional recovery.

Existing hidden files, symlinks, non-Markdown files, and `node_modules` are not imported as notes. A workspace supports up to 10,000 notes/folders, 10 MB per note, and 100 MB of Markdown content.

## Move existing browser data to desktop

Browser data is retained in the browser; the desktop app has its own file workspace.

1. Open the existing browser workspace and use Settings → Workspace → Export notes backup.
2. In desktop Noter, choose your synced folder, then use Settings → Workspace → Restore notes backup. Notes are written as `.md` files.
3. In browser Finance, export the Excel backup. Import that workbook in desktop Finance. Accounts, categories, transfers, and IDs round-trip through the workbook metadata.

The notes JSON backup contains settings and embedded databases. It does not contain Finance; Finance uses its Excel backup separately.
