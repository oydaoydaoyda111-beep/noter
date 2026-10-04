# Shared desktop and Android file storage

The selected workspace folder is the source of truth on both platforms. There is no browser workspace, hosted database, or platform-specific copy of the notes/Finance data. Sync the whole folder, including `.noter`. Device folder selections, installation identities, last-used section, and Android recovery journals stay outside that folder.

## Workspace v1

- Notes are UTF-8 Markdown files; directories represent folders. Writers save UTF-8 without a byte-order mark. The desktop reader also accepts a UTF-8 BOM and BOM-marked UTF-16LE/BE, which Windows tools write, and keeps those bytes until the note is edited. Android currently requires UTF-8 (a UTF-8 BOM appears as U+FEFF in the text).
- Paths are unique ignoring letter case. The desktop matches manifest paths to files ignoring case, so an external case-only rename keeps its note ID, and it renames case-only changes in place, because case-insensitive volumes resolve both spellings to the same file.
- `.noter/workspace.json` is a JSON object with `workspace` and `paths`.
- `workspace.version` is `1`. Nodes are keyed by stable IDs and contain `id`, `type`, `name`, `parentId`, `createdAt`, and `updatedAt`; folders also contain ordered `children` IDs.
- `paths` maps those IDs to relative paths with `/` separators. The manifest omits note bodies; `.md` files contain the actual Markdown.
- `rootIds`, `openTabs`, `activeNoteId`, `collapsedFolders`, and settings preserve their current v1 meaning on both clients. Font size and autosave delay may be fractional; enumerated numeric settings must match a supported choice exactly.
- Both apps edit version 1 databases inside fenced `noter-database` JSON blocks. Android retains row/property/view IDs, unknown JSON fields, option colors, hidden columns and widths while replacing only the selected block's JSON payload. Surrounding Markdown and fence markers are preserved. Unsupported or malformed blocks remain available in the Markdown editor.
- External changes are checked before saving. A stale workspace revision must fail rather than overwrite incoming files.
- Desktop reuses its verified snapshot for save comparisons and history; unchanged Markdown files are skipped. Full content checks before writes and at completion protect against incoming changes, including same-size edits with unchanged timestamps.
- Desktop sync polling checks paths, sizes and modification times every five seconds when the UI is visible and safe to reload. Note bodies are rechecked when metadata changes, on returning to the app, and after a minute without a full check. Edits preserving size and timestamps may wait for that full check; save-time verification always reads complete contents. Polling uses a worker thread and overlapping checks are skipped.
- Android pauses note and Finance polling when its activity stops and checks again when it starts. Pending note saves still flush in the background. Unsaved edits and open Finance dialogs keep their existing reload protection.

The shared fixture in `tests/fixtures/file-storage/workspace.json` and its Markdown siblings checks IDs, ordering, settings and database content through Rust and Android load/save/reopen paths.

`tests/fixtures/file-storage/database.json` checks all five property types, saved views, filters, sorting and view settings on desktop and Android. Both apps create, rename and delete saved views, with independent filters, sorting and column visibility. New views copy the active view; deleting a view preserves all records and properties. Android database edits share the note editor's undo/autosave path. Before applying an edit, Android compares the opened block's payload with the current note buffer; a changed or removed block rejects the save and keeps the open form's draft. Database records use ordinary note synchronization and conflict handling, rather than Finance's per-record log merge.

## Finance log v1

Each installation has its own persistent device ID and writes `.noter/finance/log-<device>.jsonl`. Every device reads all logs. Each complete line is one batch:

```json
{"v":1,"ts":1000,"dev":"example","seq":1,"ops":[{"k":"meta","key":"accounts","value":[{"name":"Cash","note":""}]}]}
```

- A batch ends with a newline. An unfinished final line is not committed.
- `ts` and `seq` are safe integers. Transaction `cents` is a signed safe integer. The inclusive supported range is `-9007199254740991` to `9007199254740991`; whole decimal/exponent JSON representations have the same meaning as integer representations.
- Operations are `reset`, `tx` (an ID and transaction, or `null` for deletion), and `meta` (a key and value). Metadata keys are `accounts`, `categories`, `categoryDefinitions`, `defaults`, `sourceName`, `templateSha256`, and optional `budgets`.
- `budgets` is an array of `{month: "YYYY-MM", category: "Food", cents: 5000}`. Limits are positive safe integer cents, unique per month/category; transfer categories cannot have budgets. Desktop tracks negative expense entries across all accounts in that month, excluding linked transfers and the reserved transfer category. Income does not consume a budget. There is no automatic rollover; desktop can copy missing limits from the previous month. Category renames follow budgets, merges add same-month limits, and category deletion removes its limits. Excel backups keep budgets in the hidden Noter metadata sheet.
- Legacy logs without budgets load unchanged. Both current readers preserve budget metadata; Android has no budget controls yet. Update Android to the reader with budget support before sharing budget-enabled logs with it: older readers reject unknown metadata keys. A transaction-only Android edit does not rewrite budgets. Budget lists use the same whole-metadata last-write-wins rule as account/category lists.
- Desktop bulk selection spans matching pages, clears on filter changes, and always includes both linked transfer entries. Bulk editing changes only checked fields and keeps amounts/IDs intact. Transfer selections allow date/payee/note changes; account/category edits require individual transfer editing. Bulk deletion removes both entries together.
- Desktop monthly reports derive calendar-month income, expenses, net income and category shares from the replayed transactions, across all accounts or one account (including archived history). Linked transfers, the reserved transfer category and categories named `Initial` after trimming/case normalization are excluded. Positive cents are income; negative cents are expenses; net income is income minus expenses. Aggregates retain integer cents and report overflow instead of rounding. Reports introduce no files, metadata keys or log writes; synced changes update them on reload.
- Replay orders batches by timestamp, device ID, and sequence. The last operation for a transaction or metadata key wins. Independent transaction edits merge; concurrent changes to the same record or whole accounts/categories list require care.
- The original workbook lives in `.noter/finance-template.xlsx`, with its fingerprint in the logs. An absent workbook is supported when starting Finance on Android. A fingerprint mismatch blocks loading until the matching files arrive.
- Legacy `.noter/finance.json` is imported once and preserved in `.noter/trash`.
- Before repairing an unfinished own-device tail, keep the original log in `.noter/trash`; retain every completed line and append the next batch. Invalid completed lines remain an error and are never silently discarded.
- A failed append can have reached disk before acknowledgement. Both clients require reload before another edit so a committed batch's sequence is not reused.

The two synthetic device logs and `expected-finance.json` in the shared fixture directory verify replay, Unicode, transfers, account recovery, metadata and numeric compatibility on both clients.

## Replacement and synchronization boundaries

Both apps offer **Keep edits and reload** when notes have unsaved work. Changed or renamed/moved local notes are compared with the last acknowledged workspace and copied into a new `Recovered edits <timestamp>-<uuid>/` folder with their hierarchy and Markdown intact. Incoming originals are preserved. Each recovery also writes `.noter/recovery/<timestamp>-<uuid>/workspace.json`: a v1 notes backup containing note bodies, folders, settings and deletion intent, in the same shape as desktop notes exports. Finance stays in its own logs.

Recovery files are verified before reloading; a backup failure or further typing during reload leaves the current edits in memory. Settings-only changes and deletions need only the JSON backup. Use desktop's notes backup import to restore that snapshot, or open and edit the recovered Markdown normally on either platform. Android manual reload and folder switching also protect unsaved work. These actions preserve versions for manual reconciliation; they do not merge conflicting note text automatically.

Desktop writes flush temporary files to disk before rename. Android SAF replacement uses a completed, verified `.noter-write-*.new` sibling, a preserved `.old` document, and a fsynced device-private journal. On interruption, that installation restores the old document only when the target is missing; an externally created target is preserved. Recovery never consumes another device's journal or incomplete temporary content. SAF replacement and a multi-file workspace are not single atomic transactions.

Keep `.noter-*.tmp` and `.noter-write-*` out of synchronization using each device's Syncthing ignore list. Keep `.noter/workspace.json`, Finance logs, workbook and wanted recovery snapshots included. Noter does not change existing ignore rules automatically. [Syncthing ignore syntax](https://docs.syncthing.net/users/ignoring.html).

Logs and recovery snapshots currently grow without compaction or automatic retention. Shared metadata can still produce Syncthing conflicts, and same-record Finance changes use last-write-wins. The file contract does not imply conflict-free concurrent editing.
