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
fn check_finance_conflicts(root: &Path) -> Result<()> {
    let folder = safe_path(root, ".noter")?;
    if folder.exists() {
        for entry in fs::read_dir(folder).map_err(|e| error("Could not inspect Finance sync", e))? {
            let name = entry
                .map_err(|e| error("Could not inspect Finance sync", e))?
                .file_name()
                .to_string_lossy()
                .to_string();
            if name.starts_with("finance.sync-conflict-") && name.ends_with(".json") {
                return Err("Finance has a Syncthing conflict copy in .noter. Keep both files and resolve the conflict before editing Finance.".into());
            }
        }
    }
    Ok(())
}
pub fn read_finance(root: &Path) -> Result<Option<Value>> {
    check_finance_conflicts(root)?;
    let path = safe_path(root, ".noter/finance.json")?;
    match fs::read(&path) {
        Ok(bytes) => {
            let mut data: Value = serde_json::from_slice(&bytes)
                .map_err(|_| "Finance data could not be read. Your files have been kept.")?;
            let template = safe_path(root, ".noter/finance-template.xlsx")?;
            let bytes =
                fs::read(template).map_err(|e| error("Could not read Finance workbook", e))?;
            if data["templateSha256"]
                .as_str()
                .is_some_and(|hash| hash != format!("{:x}", Sha256::digest(&bytes)))
            {
                return Err("Finance workbook is still syncing or was changed independently. Wait for Syncthing to finish and reload.".into());
            }
            data.as_object_mut()
                .ok_or("Invalid Finance data.")?
                .remove("templateSha256");
            data["template"] = json!(bytes);
            Ok(Some(data))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(error("Could not read Finance", e)),
    }
}
pub fn finance_revision(root: &Path) -> Result<String> {
    check_finance_conflicts(root)?;
    let mut hash = Sha256::new();
    for name in [".noter/finance.json", ".noter/finance-template.xlsx"] {
        match fs::read(safe_path(root, name)?) {
            Ok(bytes) => hash.update(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => hash.update([0]),
            Err(e) => return Err(error("Could not check Finance files", e)),
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn save_finance(
    root: &Path,
    mut data: Value,
    template: &[u8],
    expected: &str,
) -> Result<String> {
    if finance_revision(root)? != expected {
        return Err(
            "SYNC_CONFLICT: Finance files changed outside Noter. Reload Finance before saving."
                .into(),
        );
    }
    if data["version"] != 1
        || !data["transactions"].is_array()
        || !data["accounts"].is_array()
        || template.len() > 10_000_000
    {
        return Err("Invalid Finance data.".into());
    }
    data.as_object_mut()
        .ok_or("Invalid Finance data.")?
        .remove("template");
    data["templateSha256"] = json!(format!("{:x}", Sha256::digest(template)));
    let previous_json = safe_path(root, ".noter/finance.json")?;
    let previous_template = safe_path(root, ".noter/finance-template.xlsx")?;
    let old_template = fs::read(&previous_template).ok();
    if let Ok(bytes) = fs::read(&previous_json) {
        let backup = format!(".noter/trash/finance-{}-{}", now(), Uuid::new_v4());
        atomic_write(&safe_path(root, &format!("{backup}/finance.json"))?, &bytes)?;
        if let Some(bytes) = &old_template {
            atomic_write(
                &safe_path(root, &format!("{backup}/finance-template.xlsx"))?,
                bytes,
            )?;
        }
    }
    if finance_revision(root)? != expected {
        return Err(
            "SYNC_CONFLICT: Finance changed while preparing the save. Reload before saving.".into(),
        );
    }
    atomic_write(&safe_path(root, ".noter/finance-template.xlsx")?, template)?;
    if let Err(problem) = atomic_write(
        &previous_json,
        &serde_json::to_vec_pretty(&data).map_err(|e| error("Could not prepare Finance", e))?,
    ) {
        if let Some(bytes) = old_template {
            let _ = atomic_write(&previous_template, &bytes);
        } else {
            let _ = fs::remove_file(&previous_template);
        }
        return Err(problem);
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
    fn finance_is_file_based_and_checks_external_changes() {
        let root = tempfile::tempdir().unwrap();
        let revision = finance_revision(root.path()).unwrap();
        let data = json!({"version":1,"accounts":[{"name":"Checking","note":""}],"transactions":[{"id":"example","cents":10,"account":"Checking"}],"categories":[],"sourceName":"sample.xlsx"});
        let revision = save_finance(root.path(), data.clone(), &[1, 2, 3], &revision).unwrap();
        let loaded = read_finance(root.path()).unwrap().unwrap();
        assert_eq!(loaded["template"], json!([1, 2, 3]));
        assert_eq!(loaded["transactions"], data["transactions"]);
        fs::write(
            root.path().join(".noter/finance.json"),
            serde_json::to_vec(&json!({"version":1,"transactions":[],"accounts":[]})).unwrap(),
        )
        .unwrap();
        assert!(
            save_finance(root.path(), data, &[1, 2, 3], &revision)
                .unwrap_err()
                .contains("SYNC_CONFLICT")
        );
    }
    #[test]
    fn finance_waits_for_complete_sync_and_keeps_conflict_copies() {
        let root = tempfile::tempdir().unwrap();
        let data = json!({"version":1,"accounts":[],"transactions":[]});
        let revision = finance_revision(root.path()).unwrap();
        save_finance(root.path(), data.clone(), &[1, 2, 3], &revision).unwrap();
        fs::write(root.path().join(".noter/finance-template.xlsx"), [4, 5, 6]).unwrap();
        assert!(
            read_finance(root.path())
                .unwrap_err()
                .contains("still syncing")
        );
        fs::write(root.path().join(".noter/finance-template.xlsx"), [1, 2, 3]).unwrap();
        assert!(read_finance(root.path()).is_ok());
        let conflict = root
            .path()
            .join(".noter/finance.sync-conflict-20261003-TEST.json");
        fs::write(&conflict, serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(
            finance_revision(root.path())
                .unwrap_err()
                .contains("conflict copy")
        );
        assert!(
            read_finance(root.path())
                .unwrap_err()
                .contains("conflict copy")
        );
        assert!(conflict.exists());
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
