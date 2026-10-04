# Noter

A desktop and Android workspace for Markdown notes, embedded databases, and personal Finance. Both apps read and write the same local file formats in a folder you choose, ready to synchronize with Syncthing.

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

`npm run dev` also launches the desktop app. Vite builds the desktop interface; opening its URL in a browser shows a retired-app notice and does not load or save a workspace. The localStorage/IndexedDB persistence paths have been removed. Existing browser data is left untouched.

For Android, open `android/` in Android Studio and run the app on your device or emulator. With a configured JDK 17 and Android SDK, `android/gradlew.bat -p android :app:assembleDebug` builds `android/app/build/outputs/apk/debug/app-debug.apk` on Windows. Choose the local folder synchronized by Syncthing using Android's folder picker.

Tap the search icon in Android's Notes screen to find notes by name, content, or folder path. All, Names, Contents, and Folders filters match desktop search. Results include previews and open the note when tapped. Search includes current edits, keeps editor selection and undo when closed, and does not add index files to the synced workspace.

Tap the table icon in Android's Notes screen to create a database, or open a note containing a desktop database and tap **Open database**. Android supports table, board, and calendar views; record creation, editing, duplication and deletion; property management; search, exact property filters, sorting, and switching existing saved views. Changes use note autosave and Undo/Redo. **Edit Markdown** opens the original source. Desktop option colors, column widths, saved view settings and IDs are retained; their advanced controls and bulk record editing remain desktop-only.

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

- Notes are UTF-8 `.md` files. Folders and emoji filenames are preserved. Filename characters unsupported on Windows are normalized when saving. Embedded Noter databases remain fenced `noter-database` JSON blocks inside their Markdown notes on both platforms; no separate database file is needed.
- `.noter/workspace.json` contains note IDs, file paths, ordering, tabs, and preferences, without duplicating note content.
- `.noter/finance/log-<device>.jsonl` holds Finance as one append-only change log per device: accounts, category definitions, defaults, and transactions. Each installation writes only its own log to avoid competing writes during normal sync; both apps replay all logs, and the latest change wins per transaction or setting. Amounts are signed integer cents within the JavaScript safe integer range on both platforms. A former `.noter/finance.json` is migrated once and moved to `.noter/trash`.
- `.noter/finance-template.xlsx` preserves the imported workbook's other sheets and formatting for Excel exports. Import through Finance once; export `.xlsx` backups with the native save dialog. Don't edit this template directly: reimport a changed workbook through Noter.
- `.noter/trash` keeps prior note versions, removed notes, and Finance snapshots. These are ordinary files you can copy back manually. It can grow over time; manage it yourself when backups are no longer needed.

Sync the **whole workspace folder, including `.noter`**. Syncthing performs the synchronization; Noter does not upload anything or require an account. If you have custom ignore rules, make sure they do not exclude `.noter` or its Finance template. App binaries, development caches, and the device's chosen-folder configuration are outside the workspace and should not be synced.

Add these temporary-file patterns to Syncthing's ignore list on each device (or each folder's existing root `.stignore` file). Keep `.noter` included. Ignore files themselves do not sync; patterns without a leading slash match filenames in subfolders too. See [Syncthing's ignore documentation](https://docs.syncthing.net/users/ignoring.html).

```text
.noter-*.tmp
.noter-write-*
```

Use a separate app installation identity on each device; sync the workspace, not the app configuration. Both clients use the [same versioned file contract](docs/FILE_STORAGE.md), checked by shared synthetic fixtures.

Noter checks for incoming changes every five seconds when there are no unsaved edits or open dialogs. You can also use File → Reload Synced Files. Saves check the disk revision before writing. If your unsaved notes conflict with incoming files, Noter offers to export the edits before reloading. Markdown conflict copies remain visible as separate notes. Finance changes from different devices merge automatically through the per-device logs; if two devices edit the same transaction before syncing, the later edit wins.

Desktop file storage, safe-path checks, revision hashing, recovery snapshots, and Excel ZIP compression/decompression run in Rust. Android uses Kotlin and the Storage Access Framework to access the same files. The JavaScript ZIP library is used only by tests. Excel import/export remains desktop-only.

Desktop replacements use a temporary file and rename. Android's document providers do not offer atomic replacement: Noter verifies a temporary sibling, preserves the old document, and uses a device-private recovery journal to restore it if replacement is interrupted. Pending new content is retained for recovery. A workspace involves multiple files, so an interrupted sync or crash can still leave a partial set temporarily. Finance waits if its template and log fingerprints differ. An incomplete own-device log tail is backed up before the next complete batch is saved. After an uncertain Finance save, reload before editing again to preserve any already-completed batch.

Existing hidden files, symlinks, non-Markdown files, and `node_modules` are not imported as notes. A workspace supports up to 10,000 notes/folders, 10 MB per note, and 100 MB of Markdown content.

## Compatibility checks

`npm test` checks the shared file fixtures and native frontend persistence commands. `npm run desktop:test` saves and reopens the same Markdown/manifest fixture through Rust, and tests Finance tail recovery. To run Android's checks, build `:app:assembleDebugAndroidTest`, install both debug APKs on an emulator, then run `adb shell am instrument -w app.noter.test/app.noter.StorageContractCheck`. The native check covers the same manifest, Markdown and Finance fixtures, stale saves, replacement failures, recovery, foreground polling and note search. Search UI checks use synthetic notes and cover filters, opening results, clearing, Back, and preserving editor undo.

Existing notes JSON backups can still be restored in desktop Settings → Workspace. Existing Excel Finance backups can still be imported on desktop. The notes backup does not contain Finance.
