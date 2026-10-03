use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
type Result<T> = std::result::Result<T, String>;
const MAX_NOTE: u64 = 10_000_000;
#[derive(Default, Serialize, Deserialize)]
struct Manifest {
    workspace: Value,
    paths: BTreeMap<String, String>,
}
#[derive(Serialize)]
pub struct LoadedWorkspace {
    pub workspace: Value,
    pub revision: String,
    pub path: String,
}
fn error(context: &str, problem: impl std::fmt::Display) -> String {
    format!("{context}: {problem}")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
        || path.as_os_str().is_empty()
    {
        return Err("Invalid workspace file path.".into());
    }
    let mut joined = root.to_path_buf();
    for part in path.components() {
        joined.push(part);
        if fs::symlink_metadata(&joined).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("Workspace files cannot be symbolic links.".into());
        }
    }
    Ok(joined)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::read(path).is_ok_and(|previous| previous == bytes) {
        return Ok(());
    }
    let parent = path.parent().ok_or("Invalid file location.")?;
    fs::create_dir_all(parent).map_err(|e| error("Could not create folder", e))?;
    let temporary = parent.join(format!(".noter-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| error("Could not prepare file", e))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| error("Could not write file", e))?;
        fs::rename(&temporary, path).map_err(|e| error("Could not replace file", e))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn manifest(root: &Path) -> Result<Manifest> {
    let path = safe_path(root, ".noter/workspace.json")?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Workspace metadata could not be read. Your files have been kept.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(e) => Err(error("Could not read workspace metadata", e)),
    }
}
fn scan(root: &Path, relative: &Path, files: &mut BTreeMap<String, Option<String>>) -> Result<()> {
    let directory = root.join(relative);
    for entry in
        fs::read_dir(&directory).map_err(|e| error("Could not read workspace folder", e))?
    {
        let entry = entry.map_err(|e| error("Could not read file", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let kind = entry
            .file_type()
            .map_err(|e| error("Could not inspect file", e))?;
        if kind.is_symlink() {
            continue;
        }
        let child = relative.join(&name);
        let key = child.to_string_lossy().replace('\\', "/");
        if kind.is_dir() {
            files.insert(key, None);
            scan(root, &child, files)?;
        } else if kind.is_file() && name.to_lowercase().ends_with(".md") {
            if entry
                .metadata()
                .map_err(|e| error("Could not inspect note", e))?
                .len()
                > MAX_NOTE
            {
                return Err("A note is larger than 10 MB. Move it outside the workspace to open this folder.".into());
            }
            let text = fs::read_to_string(entry.path()).map_err(|_| {
                "A Markdown file could not be read as UTF-8. Your files have been kept.".to_string()
            })?;
            files.insert(key, Some(text));
        }
        if files.len() > 10_000 {
            return Err("Choose a workspace with fewer than 10,000 notes and folders.".into());
        }
    }
    Ok(())
}
fn files(root: &Path) -> Result<BTreeMap<String, Option<String>>> {
    let mut result = BTreeMap::new();
    scan(root, Path::new(""), &mut result)?;
    if result
        .values()
        .filter_map(Option::as_ref)
        .map(String::len)
        .sum::<usize>()
        > 100_000_000
    {
        return Err("Choose a workspace with less than 100 MB of Markdown content.".into());
    }
    Ok(result)
}
fn snapshot_revision(disk: &BTreeMap<String, Option<String>>, metadata: &[u8]) -> String {
    let mut hash = Sha256::new();
    for (path, content) in disk {
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path.as_bytes());
        hash.update([content.is_some() as u8]);
        if let Some(text) = content {
            hash.update((text.len() as u64).to_le_bytes());
            hash.update(text.as_bytes());
        }
    }
    hash.update(metadata);
    format!("{:x}", hash.finalize())
}
pub fn revision(root: &Path) -> Result<String> {
    let disk = files(root)?;
    let metadata = match fs::read(safe_path(root, ".noter/workspace.json")?) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(error("Could not check metadata", e)),
    };
    Ok(snapshot_revision(&disk, &metadata))
}
pub fn load(root: &Path) -> Result<LoadedWorkspace> {
    let before = revision(root)?;
    let previous = manifest(root)?;
    let disk = files(root)?;
    let reverse: BTreeMap<_, _> = previous
        .paths
        .iter()
        .map(|(id, path)| (path.clone(), id.clone()))
        .collect();
    let mut paths = BTreeMap::new();
    let mut ids = HashSet::new();
    for path in disk.keys() {
        let mut id = reverse
            .get(path)
            .cloned()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if !ids.insert(id.clone()) {
            id = Uuid::new_v4().to_string();
            ids.insert(id.clone());
        }
        paths.insert(path.clone(), id);
    }
    let mut nodes = serde_json::Map::new();
    for (path, content) in &disk {
        let id = &paths[path];
        let original = &previous.workspace["nodes"][id];
        let name = Path::new(path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let parent = Path::new(path)
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .and_then(|path| paths.get(&path.to_string_lossy().replace('\\', "/")));
        let mut node = json!({"id":id, "name":if content.is_some() {name[..name.len()-3].to_string()} else {name}, "parentId":parent, "createdAt":original["createdAt"].as_u64().unwrap_or_else(now), "updatedAt":original["updatedAt"].as_u64().unwrap_or_else(now)});
        if let Some(markdown) = content {
            node["type"] = json!("note");
            node["markdown"] = json!(markdown);
        } else {
            node["type"] = json!("folder");
            let children: Vec<_> = disk
                .keys()
                .filter(|child| Path::new(child).parent() == Some(Path::new(path)))
                .map(|child| paths[child].clone())
                .collect();
            node["children"] = ordered(&original["children"], children);
        }
        nodes.insert(id.clone(), node);
    }
    let roots = disk
        .keys()
        .filter(|path| {
            Path::new(path)
                .parent()
                .is_some_and(|p| p.as_os_str().is_empty())
        })
        .map(|path| paths[path].clone())
        .collect();
    let mut workspace = json!({"version":1,"nodes":nodes,"rootIds":ordered(&previous.workspace["rootIds"], roots),"settings":previous.workspace["settings"],"openTabs":previous.workspace["openTabs"],"activeNoteId":previous.workspace["activeNoteId"],"collapsedFolders":previous.workspace["collapsedFolders"]});
    if !workspace["openTabs"].is_array() {
        let first = nodes
            .iter()
            .find(|(_, node)| node["type"] == "note")
            .map(|(id, _)| id.clone());
        workspace["openTabs"] = json!(first.iter().collect::<Vec<_>>());
        workspace["activeNoteId"] = json!(first);
    }
    let mut metadata = workspace.clone();
    for node in metadata["nodes"].as_object_mut().unwrap().values_mut() {
        node.as_object_mut().unwrap().remove("markdown");
    }
    let stable_paths = paths
        .iter()
        .map(|(path, id)| (id.clone(), path.clone()))
        .collect();
    let bytes = serde_json::to_vec_pretty(&Manifest {
        workspace: metadata,
        paths: stable_paths,
    })
    .map_err(|e| error("Could not prepare metadata", e))?;
    if revision(root)? != before {
        return Err("SYNC_CONFLICT: Files changed while opening the folder. Wait for synchronization and reload.".into());
    }
    atomic_write(&safe_path(root, ".noter/workspace.json")?, &bytes)?;
    let expected = snapshot_revision(&disk, &bytes);
    if revision(root)? != expected {
        return Err("SYNC_CONFLICT: Files changed while opening the folder. Wait for synchronization and reload.".into());
    }
    Ok(LoadedWorkspace {
        workspace,
        revision: expected,
        path: root.to_string_lossy().to_string(),
    })
}
fn ordered(previous: &Value, current: Vec<String>) -> Value {
    let mut result = Vec::new();
    for id in previous
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .chain(current.iter().map(String::as_str))
    {
        if current.iter().any(|item| item == id) && !result.iter().any(|item| item == id) {
            result.push(id.to_string());
        }
    }
    json!(result)
}
fn filename(raw: &str) -> String {
    let name: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || "/\\<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim().trim_end_matches(['.', ' ']);
    let name = if name.is_empty() || name.starts_with('.') {
        "Untitled"
    } else {
        name
    };
    let upper = name.split('.').next().unwrap_or("").to_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.ends_with(|c: char| c.is_ascii_digit()))
    {
        format!("_{name}")
    } else {
        name.to_string()
    }
}
fn plan(
    workspace: &Value,
    ids: &Value,
    parent: &str,
    paths: &mut BTreeMap<String, String>,
    used: &mut HashSet<String>,
    previous: &Manifest,
) -> Result<()> {
    for id in ids.as_array().ok_or("Invalid workspace hierarchy.")? {
        let id = id.as_str().ok_or("Invalid note ID.")?;
        let node = &workspace["nodes"][id];
        if paths.contains_key(id) {
            return Err("Invalid workspace hierarchy.".into());
        }
        let raw = node["name"].as_str().ok_or("Invalid note name.")?;
        let stem = filename(raw);
        let note = node["type"] == "note";
        let suffix = if note { ".md" } else { "" };
        let existing = previous.paths.get(id).filter(|_| {
            previous.workspace["nodes"][id]["name"] == node["name"]
                && previous.workspace["nodes"][id]["type"] == node["type"]
        });
        let basename = existing
            .and_then(|path| Path::new(path).file_name())
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{stem}{suffix}"));
        let mut candidate = format!("{parent}{basename}");
        let mut index = 2;
        while used.contains(&candidate.to_lowercase()) {
            candidate = format!("{parent}{stem} ({index}){suffix}");
            index += 1;
        }
        used.insert(candidate.to_lowercase());
        paths.insert(id.into(), candidate.clone());
        if node["type"] == "folder" {
            plan(
                workspace,
                &node["children"],
                &format!("{candidate}/"),
                paths,
                used,
                previous,
            )?;
        } else if !note || !node["markdown"].is_string() {
            return Err("Invalid note content.".into());
        }
    }
    Ok(())
}
pub fn save(root: &Path, workspace: Value, expected: &str) -> Result<String> {
    if revision(root)? != expected {
        return Err("SYNC_CONFLICT: Files changed outside Noter. Reload the folder before saving; your unsaved edits are still here.".into());
    }
    let previous = manifest(root)?;
    let mut paths = BTreeMap::new();
    let mut used = HashSet::new();
    plan(
        &workspace,
        &workspace["rootIds"],
        "",
        &mut paths,
        &mut used,
        &previous,
    )?;
    let nodes = workspace["nodes"].as_object().ok_or("Invalid notes.")?;
    if paths.len() != nodes.len() {
        return Err("Invalid workspace hierarchy.".into());
    }
    for (id, path) in &paths {
        let target = safe_path(root, path)?;
        if target.exists() && !previous.paths.values().any(|old| old == path) {
            return Err(
                "SYNC_CONFLICT: A file already uses that name. Reload the folder before saving."
                    .into(),
            );
        }
        if nodes[id]["type"] == "note"
            && nodes[id]["markdown"].as_str().unwrap().len() as u64 > MAX_NOTE
        {
            return Err("Keep each note below 10 MB.".into());
        }
    }
    // Keep changed/deleted files in recoverable trash before moving or replacing them.
    let trash = format!(".noter/trash/{}-{}", now(), Uuid::new_v4());
    for (id, old) in &previous.paths {
        if previous.workspace["nodes"][id]["type"] != "note" {
            continue;
        }
        let source = safe_path(root, old)?;
        let desired = paths.get(id);
        let changed = desired.is_none_or(|path| path != old)
            || fs::read_to_string(&source).ok().as_deref()
                != nodes.get(id).and_then(|node| node["markdown"].as_str());
        if changed && source.is_file() {
            let backup = safe_path(root, &format!("{trash}/{old}"))?;
            atomic_write(
                &backup,
                &fs::read(&source).map_err(|e| error("Could not back up note", e))?,
            )?;
        }
    }
    if revision(root)? != expected {
        return Err("SYNC_CONFLICT: Files changed while preparing the save. Your edits are still in memory.".into());
    }
    // Write destinations first. Then remove old paths that are no longer in use.
    for (id, relative) in &paths {
        let target = safe_path(root, relative)?;
        if nodes[id]["type"] == "folder" {
            fs::create_dir_all(target).map_err(|e| error("Could not create note folder", e))?;
        } else {
            atomic_write(&target, nodes[id]["markdown"].as_str().unwrap().as_bytes())?;
        }
    }
    let wanted: HashSet<_> = paths.values().collect();
    let mut old_paths: Vec<_> = previous
        .paths
        .values()
        .filter(|path| !wanted.contains(path))
        .collect();
    old_paths.sort_by_key(|path| std::cmp::Reverse(path.len()));
    for old in old_paths {
        let path = safe_path(root, old)?;
        if path.is_file() {
            fs::remove_file(path).map_err(|e| error("Could not move old note", e))?;
        } else if path.is_dir() {
            let _ = fs::remove_dir(path);
        }
    }
    let mut metadata = workspace;
    for node in metadata["nodes"].as_object_mut().unwrap().values_mut() {
        node.as_object_mut().unwrap().remove("markdown");
    }
    let bytes = serde_json::to_vec_pretty(&Manifest {
        workspace: metadata,
        paths,
    })
    .map_err(|e| error("Could not prepare metadata", e))?;
    atomic_write(&safe_path(root, ".noter/workspace.json")?, &bytes)?;
    revision(root)
}
const FINANCE_LOGS: &str = ".noter/finance";
const FINANCE_LEGACY: &str = ".noter/finance.json";
const FINANCE_TEMPLATE: &str = ".noter/finance-template.xlsx";
const MAX_FINANCE_LOGS: u64 = 100_000_000;
fn millis(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |time| time.as_millis())
}
/// Finance log files, sorted by name. Each device appends only to its own `log-<device>.jsonl`.
fn finance_logs(root: &Path) -> Result<Vec<(String, PathBuf, fs::Metadata)>> {
    let folder = safe_path(root, FINANCE_LOGS)?;
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(error("Could not read Finance logs", e)),
    };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| error("Could not read Finance logs", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|e| error("Could not inspect Finance logs", e))?;
        if name.starts_with('.') || !name.ends_with(".jsonl") || !metadata.is_file() {
            continue;
        }
        result.push((name, entry.path(), metadata));
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}
pub fn finance_revision(root: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    for (name, _, metadata) in finance_logs(root)? {
        hash.update(format!("{name}\0{}\0{}\n", metadata.len(), millis(&metadata)));
    }
    for name in [FINANCE_LEGACY, FINANCE_TEMPLATE] {
        match fs::metadata(safe_path(root, name)?) {
            Ok(metadata) => {
                hash.update(format!("{name}\0{}\0{}\n", metadata.len(), millis(&metadata)))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                hash.update(format!("{name}\0-\n"))
            }
            Err(e) => return Err(error("Could not check Finance files", e)),
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
/// Raw Finance files: every device log, the legacy single-file data (until migrated), and the Excel template.
pub fn read_finance(root: &Path) -> Result<Value> {
    let mut logs = Vec::new();
    let mut total = 0;
    for (name, path, metadata) in finance_logs(root)? {
        total += metadata.len();
        if total > MAX_FINANCE_LOGS {
            return Err("Finance logs are larger than 100 MB.".into());
        }
        let text = fs::read_to_string(path)
            .map_err(|_| "A Finance log could not be read as UTF-8. Your files have been kept.")?;
        logs.push(json!({"name": name, "text": text}));
    }
    let legacy = match fs::read(safe_path(root, FINANCE_LEGACY)?) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "Finance data could not be read. Your files have been kept.")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(e) => return Err(error("Could not read Finance", e)),
    };
    let template = match fs::read(safe_path(root, FINANCE_TEMPLATE)?) {
        Ok(bytes) => json!(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(e) => return Err(error("Could not read Finance workbook", e)),
    };
    Ok(json!({"logs": logs, "legacy": legacy, "template": template}))
}
/// Appends one batch line to this device's log. A replaced workbook template is written first,
/// so a batch that references its fingerprint never exists without the template itself.
pub fn append_finance(
    root: &Path,
    device: &str,
    line: &str,
    template: Option<&[u8]>,
    retire_legacy: bool,
) -> Result<String> {
    if device.is_empty() || device.len() > 64 || !device.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err("Invalid device identifier.".into());
    }
    let body = line.strip_prefix('\n').unwrap_or(line);
    let record = body.strip_suffix('\n').ok_or("Invalid Finance change.")?;
    if record.contains('\n')
        || record.len() > 50_000_000
        || serde_json::from_str::<Value>(record).map_or(true, |value| value["v"] != 1)
    {
        return Err("Invalid Finance change.".into());
    }
    if let Some(bytes) = template {
        if bytes.len() > 10_000_000 {
            return Err("Finance workbook is too large.".into());
        }
        atomic_write(&safe_path(root, FINANCE_TEMPLATE)?, bytes)?;
    }
    let path = safe_path(root, &format!("{FINANCE_LOGS}/log-{device}.jsonl"))?;
    fs::create_dir_all(path.parent().ok_or("Invalid Finance location.")?)
        .map_err(|e| error("Could not create Finance folder", e))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| error("Could not open Finance log", e))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| error("Could not save Finance", e))?;
    let legacy = safe_path(root, FINANCE_LEGACY)?;
    if retire_legacy && legacy.is_file() {
        let target = safe_path(
            root,
            &format!(".noter/trash/finance-migrated-{}-{}.json", now(), Uuid::new_v4()),
        )?;
        fs::create_dir_all(target.parent().ok_or("Invalid trash location.")?)
            .map_err(|e| error("Could not create trash folder", e))?;
        fs::rename(&legacy, &target).map_err(|e| error("Could not retire finance.json", e))?;
    }
    finance_revision(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> Value {
        json!({"version":1,"nodes":{"folder":{"id":"folder","name":"Personal","type":"folder","children":["note"],"parentId":null,"createdAt":1,"updatedAt":1},"note":{"id":"note","name":"✅ October 2","type":"note","markdown":"# Hello\n\n```noter-database\n{\"rows\":[]}\n```\n","parentId":"folder","createdAt":1,"updatedAt":1}},"rootIds":["folder"],"settings":{"fontSize":18},"openTabs":["note"],"activeNoteId":"note","collapsedFolders":[]})
    }
    #[test]
    fn readable_markdown_and_metadata_survive_restart_and_rename() {
        let root = tempfile::tempdir().unwrap();
        let loaded = load(root.path()).unwrap();
        let revision = save(root.path(), workspace(), &loaded.revision).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("Personal/✅ October 2.md")).unwrap(),
            workspace()["nodes"]["note"]["markdown"]
        );
        let loaded = load(root.path()).unwrap();
        assert_eq!(loaded.revision, revision);
        assert_eq!(loaded.workspace, workspace());
        let metadata = fs::read_to_string(root.path().join(".noter/workspace.json")).unwrap();
        assert!(!metadata.contains("markdown"));
        let mut edited = loaded.workspace;
        edited["nodes"]["folder"]["name"] = json!("Journal");
        edited["nodes"]["note"]["name"] = json!("📒 Day");
        save(root.path(), edited.clone(), &loaded.revision).unwrap();
        assert!(root.path().join("Journal/📒 Day.md").exists());
        assert!(!root.path().join("Personal/✅ October 2.md").exists());
        assert_eq!(load(root.path()).unwrap().workspace, edited);
        assert!(
            fs::read_dir(root.path().join(".noter/trash"))
                .unwrap()
                .next()
                .is_some()
        );
    }
    #[test]
    fn imported_files_and_external_edits_are_not_silently_overwritten() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("Existing.md"), "Original\n").unwrap();
        let loaded = load(root.path()).unwrap();
        save(root.path(), loaded.workspace.clone(), &loaded.revision).unwrap();
        fs::write(root.path().join("Existing.md"), "Synced change\n").unwrap();
        assert!(
            save(root.path(), loaded.workspace, &loaded.revision)
                .unwrap_err()
                .contains("SYNC_CONFLICT")
        );
        assert_eq!(
            fs::read_to_string(root.path().join("Existing.md")).unwrap(),
            "Synced change\n"
        );
        fs::write(
            root.path().join("New.sync-conflict-20261003.md"),
            "Keep both\n",
        )
        .unwrap();
        let next = load(root.path()).unwrap();
        assert_eq!(next.workspace["nodes"].as_object().unwrap().len(), 2);
    }
    #[test]
    fn deleted_notes_are_recoverable_and_other_files_are_untouched() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("unrelated.txt"), "keep").unwrap();
        let loaded = load(root.path()).unwrap();
        save(root.path(), workspace(), &loaded.revision).unwrap();
        let loaded = load(root.path()).unwrap();
        let mut next = workspace();
        next["nodes"] = json!({});
        next["rootIds"] = json!([]);
        next["openTabs"] = json!([]);
        next["activeNoteId"] = Value::Null;
        save(root.path(), next, &loaded.revision).unwrap();
        assert!(!root.path().join("Personal/✅ October 2.md").exists());
        let backup = fs::read_dir(root.path().join(".noter/trash"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join("Personal/✅ October 2.md");
        assert!(backup.exists());
        assert_eq!(
            fs::read_to_string(root.path().join("unrelated.txt")).unwrap(),
            "keep"
        );
    }
    #[test]
    fn path_traversal_and_corrupt_metadata_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        assert!(safe_path(root.path(), "../outside.md").is_err());
        assert!(safe_path(root.path(), "/outside.md").is_err());
        fs::create_dir(root.path().join(".noter")).unwrap();
        fs::write(root.path().join(".noter/workspace.json"), "broken").unwrap();
        assert!(load(root.path()).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join(".noter/workspace.json")).unwrap(),
            "broken"
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_never_escape_the_workspace() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join(".noter")).unwrap();
        assert!(load(root.path()).is_err());
        assert!(!outside.path().join("workspace.json").exists());
    }
    #[test]
    fn finance_logs_append_per_device_and_retire_legacy_data() {
        let root = tempfile::tempdir().unwrap();
        let empty = finance_revision(root.path()).unwrap();
        assert_eq!(read_finance(root.path()).unwrap()["logs"], json!([]));
        fs::create_dir(root.path().join(".noter")).unwrap();
        fs::write(root.path().join(".noter/finance.json"), r#"{"version":1}"#).unwrap();
        let line = "{\"v\":1,\"ts\":1,\"dev\":\"abc\",\"seq\":1,\"ops\":[]}\n";
        let revision = append_finance(root.path(), "abc", line, Some(&[1, 2, 3]), true).unwrap();
        assert_ne!(revision, empty);
        append_finance(root.path(), "abc", &format!("\n{line}"), None, false).unwrap();
        let loaded = read_finance(root.path()).unwrap();
        assert_eq!(loaded["logs"][0]["name"], "log-abc.jsonl");
        assert_eq!(loaded["logs"][0]["text"], format!("{line}\n{line}"));
        assert_eq!(loaded["template"], json!([1, 2, 3]));
        assert_eq!(loaded["legacy"], Value::Null);
        assert!(fs::read_dir(root.path().join(".noter/trash")).unwrap().next().is_some());
        fs::write(root.path().join(".noter/finance/log-other.jsonl"), line).unwrap();
        assert_ne!(finance_revision(root.path()).unwrap(), revision);
        assert_eq!(read_finance(root.path()).unwrap()["logs"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn finance_rejects_invalid_changes_and_devices() {
        let root = tempfile::tempdir().unwrap();
        let line = "{\"v\":1}\n";
        assert!(append_finance(root.path(), "../x", line, None, false).is_err());
        assert!(append_finance(root.path(), "abc", "{\"v\":1}", None, false).is_err());
        assert!(append_finance(root.path(), "abc", "{\"v\":1}\n{}\n", None, false).is_err());
        assert!(append_finance(root.path(), "abc", "not json\n", None, false).is_err());
        assert!(!root.path().join(".noter/finance").exists());
    }
    #[test]
    fn existing_markdown_filename_spelling_is_preserved() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("Existing.MD"), "Original\n").unwrap();
        let loaded = load(root.path()).unwrap();
        save(root.path(), loaded.workspace, &loaded.revision).unwrap();
        assert!(root.path().join("Existing.MD").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("Existing.MD")).unwrap(),
            "Original\n"
        );
    }
}
