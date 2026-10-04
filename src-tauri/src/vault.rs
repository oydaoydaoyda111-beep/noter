use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
type Result<T> = std::result::Result<T, String>;
const MAX_NOTE: u64 = 10_000_000;
#[derive(Default, PartialEq, Serialize, Deserialize)]
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
/// The canonical Windows path (`\\?\C:\…`) in the form people recognize; other platforms are unchanged.
pub fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    let simple = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\").filter(|rest| rest.get(1..2) == Some(":")) {
        rest.to_string()
    } else {
        return text;
    };
    // Verbatim paths can name components that Win32 paths cannot express.
    let expressible = simple.len() < 260 && !simple.split('\\').any(|part| part.ends_with(['.', ' ']));
    if cfg!(windows) && expressible { simple } else { text }
}
/// Syncthing, Excel and other Windows programs briefly open files without delete sharing,
/// which makes replacing or removing them fail until the handle closes. Retry those briefly.
fn retry_in_use<T>(mut operation: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut delay = Duration::from_millis(10);
    loop {
        match operation() {
            Err(e) if cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32 | 33)) && Instant::now() < deadline => {
                std::thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_millis(200));
            }
            result => return result,
        }
    }
}
fn in_use_error(context: &str, path: &Path, problem: std::io::Error) -> String {
    if cfg!(windows) && matches!(problem.raw_os_error(), Some(5 | 32 | 33)) {
        format!("{context}: {} is open in another program, such as Syncthing or Excel. Close it or wait for synchronization, then save again ({problem}).", display_path(path))
    } else {
        error(context, problem)
    }
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::read(path).is_ok_and(|previous| previous == bytes) {
        return Ok(());
    }
    // Windows refuses to replace read-only files; macOS and Linux ignore the mode when renaming.
    #[cfg(windows)]
    if let Ok(metadata) = fs::metadata(path) {
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            let _ = fs::set_permissions(path, permissions);
        }
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
        retry_in_use(|| fs::rename(&temporary, path))
            .map_err(|e| in_use_error("Could not replace file", path, e))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn manifest(bytes: Option<&[u8]>) -> Result<Manifest> {
    match bytes {
        Some(bytes) => {
            let manifest: Manifest = serde_json::from_slice(bytes).map_err(|_| {
                "Workspace metadata could not be read. Your files have been kept.".to_string()
            })?;
            if manifest.workspace["version"] != json!(1) {
                return Err("Unsupported workspace metadata version. Your files have been kept; use a compatible Noter version.".into());
            }
            let nodes = manifest.workspace["nodes"].as_object().ok_or(
                "Workspace metadata could not be read. Your files have been kept.",
            )?;
            let mut used = HashSet::new();
            if nodes.len() != manifest.paths.len() {
                return Err("Workspace metadata has missing file paths. Your files have been kept.".into());
            }
            for (id, relative) in &manifest.paths {
                let node = nodes.get(id).ok_or("Invalid workspace file metadata. Your files have been kept.")?;
                if node["id"] != *id
                    || !matches!(node["type"].as_str(), Some("note" | "folder"))
                    || !node["name"].is_string()
                    || relative.contains('\\')
                    || relative.split('/').any(|part| !portable_segment(part) || part == "node_modules")
                    || (node["type"] == "note" && !relative.to_lowercase().ends_with(".md"))
                    || !used.insert(relative.to_lowercase())
                {
                    return Err("Invalid or conflicting workspace file metadata. Your files have been kept.".into());
                }
            }
            Ok(manifest)
        }
        None => Ok(Manifest::default()),
    }
}
// Paths are unique ignoring letter case on disk and in metadata, so case-only renames (from Explorer,
// Finder, or an interrupted save) still match their note IDs.
fn by_lowercase<'a, T>(entries: impl Iterator<Item = (&'a String, T)>) -> BTreeMap<String, T> {
    entries.map(|(path, value)| (path.to_lowercase(), value)).collect()
}
fn complete_snapshot(root: &Path, disk: &BTreeMap<String, Option<String>>, previous: &Manifest) -> Result<()> {
    let disk = by_lowercase(disk.iter());
    for (id, relative) in &previous.paths {
        safe_path(root, relative)?;
        let matches = match disk.get(&relative.to_lowercase()) {
            Some(Some(_)) => previous.workspace["nodes"][id]["type"] == "note",
            Some(None) => previous.workspace["nodes"][id]["type"] == "folder",
            None => false,
        };
        if !matches {
            return Err("SYNC_CONFLICT: Some workspace files are missing or do not match their metadata. Wait for synchronization to finish and reload. Your files and note IDs have been kept.".into());
        }
    }
    Ok(())
}
fn manifest_bytes(next: &Manifest, previous: &Manifest, original: Option<&[u8]>) -> Result<Vec<u8>> {
    if next == previous {
        if let Some(bytes) = original {
            return Ok(bytes.to_vec());
        }
    }
    serde_json::to_vec_pretty(next).map_err(|e| error("Could not prepare metadata", e))
}
/// Operating-system folders at a drive root (and Windows' protected hidden+system files) are never notes,
/// and some of them cannot even be listed, which would otherwise make a drive-root workspace unreadable.
fn system_entry(name: &str, _entry: &fs::DirEntry) -> bool {
    if name.eq_ignore_ascii_case("$RECYCLE.BIN") || name.eq_ignore_ascii_case("System Volume Information") {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN_SYSTEM: u32 = 0x2 | 0x4;
        if _entry.metadata().is_ok_and(|m| m.file_attributes() & HIDDEN_SYSTEM == HIDDEN_SYSTEM) {
            return true;
        }
    }
    false
}
fn scan(
    root: &Path,
    relative: &Path,
    files: &mut BTreeMap<String, Option<String>>,
    used: &mut HashSet<String>,
    read_note: &impl Fn(&Path, &fs::Metadata) -> Result<String>,
) -> Result<()> {
    let directory = root.join(relative);
    for entry in
        fs::read_dir(&directory).map_err(|e| error("Could not read workspace folder", e))?
    {
        let entry = entry.map_err(|e| error("Could not read file", e))?;
        let name = entry.file_name().into_string().map_err(|_| {
            "A workspace filename is not Unicode. Rename it outside Noter before opening this folder."
        })?;
        if name.starts_with('.') || name == "node_modules" || system_entry(&name, &entry) {
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
        if kind.is_dir() || (kind.is_file() && name.to_lowercase().ends_with(".md")) {
            if !portable_segment(&name) {
                return Err("A workspace filename is not compatible with desktop and Android. Rename it outside Noter before opening this folder.".into());
            }
            if !used.insert(key.to_lowercase()) {
                return Err("Workspace filenames differ only by letter case. Rename one outside Noter before opening this folder on both devices.".into());
            }
        }
        if kind.is_dir() {
            files.insert(key, None);
            scan(root, &child, files, used, read_note)?;
        } else if kind.is_file() && name.to_lowercase().ends_with(".md") {
            let metadata = entry
                .metadata()
                .map_err(|e| error("Could not inspect note", e))?;
            if metadata.len() > MAX_NOTE {
                return Err("A note is larger than 10 MB. Move it outside the workspace to open this folder.".into());
            }
            files.insert(key, Some(read_note(&entry.path(), &metadata)?));
        }
        if files.len() > 10_000 {
            return Err("Choose a workspace with fewer than 10,000 notes and folders.".into());
        }
    }
    Ok(())
}
/// Note text from UTF-8 (optionally with a BOM) or BOM-marked UTF-16, which Windows tools often write.
/// Unchanged notes keep their original bytes; edited notes are saved as UTF-8 without a BOM.
fn decode_note(bytes: &[u8]) -> Option<String> {
    let utf16 = |rest: &[u8], unit: fn([u8; 2]) -> u16| {
        let units: Vec<u16> = rest.chunks(2).map(|pair| <[u8; 2]>::try_from(pair).ok().map(unit)).collect::<Option<_>>()?;
        String::from_utf16(&units).ok()
    };
    match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8(rest.to_vec()).ok(),
        [0xFF, 0xFE, rest @ ..] => utf16(rest, u16::from_le_bytes),
        [0xFE, 0xFF, rest @ ..] => utf16(rest, u16::from_be_bytes),
        _ => String::from_utf8(bytes.to_vec()).ok(),
    }
}
fn read_note(path: &Path) -> Result<String> {
    let bytes = fs::read(path).map_err(|e| error(&format!("Could not read {}", display_path(path)), e))?;
    decode_note(&bytes).ok_or_else(|| format!("{} is not UTF-8 or UTF-16 text. Convert or move it outside the workspace; your files have been kept.", display_path(path)))
}
fn files(root: &Path) -> Result<BTreeMap<String, Option<String>>> {
    let mut result = BTreeMap::new();
    scan(root, Path::new(""), &mut result, &mut HashSet::new(), &|path, _| read_note(path))?;
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
fn read_snapshot(root: &Path) -> Result<(BTreeMap<String, Option<String>>, Option<Vec<u8>>)> {
    let disk = files(root)?;
    let metadata = match fs::read(safe_path(root, ".noter/workspace.json")?) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(error("Could not check metadata", e)),
    };
    Ok((disk, metadata))
}
// A whole-workspace check cannot protect later destinations after earlier files are written.
// Compare each target with the acknowledged snapshot immediately before changing it.
fn unchanged_file(root: &Path, relative: &str, expected: Option<&Option<String>>) -> Result<()> {
    let path = safe_path(root, relative)?;
    let unchanged = match expected {
        Some(Some(text)) => read_note(&path).is_ok_and(|current| current == *text),
        Some(None) => fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir()),
        None => match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            _ => false,
        },
    };
    if unchanged {
        Ok(())
    } else {
        Err("SYNC_CONFLICT: A file changed while saving. Reload the folder before saving again; your edits are still here.".into())
    }
}
fn unchanged_metadata(root: &Path, expected: Option<&[u8]>) -> Result<()> {
    let path = safe_path(root, ".noter/workspace.json")?;
    let actual = match fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(problem) => return Err(error("Could not check metadata", problem)),
    };
    if actual.as_deref() == expected {
        Ok(())
    } else {
        Err("SYNC_CONFLICT: Workspace metadata changed while saving. Wait for synchronization and reload; your edits are still here.".into())
    }
}
pub fn revision(root: &Path) -> Result<String> {
    let (disk, metadata) = read_snapshot(root)?;
    Ok(snapshot_revision(
        &disk,
        metadata.as_deref().unwrap_or_default(),
    ))
}
fn metadata_stamp(metadata: &fs::Metadata) -> Result<String> {
    let modified = metadata
        .modified()
        .map_err(|e| error("Could not check modification time", e))?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(format!("{}:{modified}", metadata.len()))
}
fn metadata_revision(root: &Path) -> Result<String> {
    let mut entries = BTreeMap::new();
    scan(root, Path::new(""), &mut entries, &mut HashSet::new(), &|_, metadata| {
        metadata_stamp(metadata)
    })?;
    let path = safe_path(root, ".noter/workspace.json")?;
    let manifest = match fs::metadata(path) {
        Ok(metadata) => metadata_stamp(&metadata)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(error("Could not check metadata", e)),
    };
    Ok(snapshot_revision(&entries, manifest.as_bytes()))
}
#[derive(Default)]
pub struct RevisionProbe {
    cached: Option<RevisionHint>,
}
struct RevisionHint {
    root: PathBuf,
    metadata: String,
    revision: String,
    checked: Instant,
}
impl RevisionProbe {
    pub fn check(&mut self, root: &Path, force: bool) -> Result<String> {
        self.check_at(root, force, Instant::now())
    }
    fn check_at(&mut self, root: &Path, force: bool, now: Instant) -> Result<String> {
        let metadata = metadata_revision(root)?;
        // Metadata scans avoid a watcher dependency; add a watcher if traversal gets costly.
        // Full audits catch edits preserving timestamps, and saves always verify complete contents.
        if !force {
            if let Some(cached) = &self.cached {
                if cached.root == root
                    && cached.metadata == metadata
                    && now.duration_since(cached.checked) < Duration::from_secs(60)
                {
                    return Ok(cached.revision.clone());
                }
            }
        }
        self.cached = None;
        let revision = revision(root)?;
        // Never pair a verified body hash with metadata that changed during the read.
        self.cached = if metadata_revision(root)? == metadata {
            Some(RevisionHint {
                root: root.to_path_buf(),
                metadata,
                revision: revision.clone(),
                checked: now,
            })
        } else {
            None
        };
        Ok(revision)
    }
}
pub fn load(root: &Path) -> Result<LoadedWorkspace> {
    let (disk, metadata) = read_snapshot(root)?;
    let before = snapshot_revision(&disk, metadata.as_deref().unwrap_or_default());
    let previous = manifest(metadata.as_deref())?;
    complete_snapshot(root, &disk, &previous)?;
    let reverse = by_lowercase(previous.paths.iter().map(|(id, path)| (path, id)));
    let mut paths = BTreeMap::new();
    let mut ids = HashSet::new();
    for path in disk.keys() {
        let mut id = reverse
            .get(&path.to_lowercase())
            .map(|id| id.to_string())
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
    let mut output_metadata = workspace.clone();
    for node in output_metadata["nodes"].as_object_mut().unwrap().values_mut() {
        node.as_object_mut().unwrap().remove("markdown");
    }
    let stable_paths = paths
        .iter()
        .map(|(path, id)| (id.clone(), path.clone()))
        .collect();
    let bytes = manifest_bytes(&Manifest {
        workspace: output_metadata,
        paths: stable_paths,
    }, &previous, metadata.as_deref())?;
    if revision(root)? != before {
        return Err("SYNC_CONFLICT: Files changed while opening the folder. Wait for synchronization and reload.".into());
    }
    unchanged_metadata(root, metadata.as_deref())?;
    atomic_write(&safe_path(root, ".noter/workspace.json")?, &bytes)?;
    let expected = snapshot_revision(&disk, &bytes);
    if revision(root)? != expected {
        return Err("SYNC_CONFLICT: Files changed while opening the folder. Wait for synchronization and reload.".into());
    }
    Ok(LoadedWorkspace {
        workspace,
        revision: expected,
        path: display_path(root),
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
fn reserved_filename(name: &str) -> bool {
    let upper = name.split('.').next().unwrap_or("").to_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.ends_with(|c: char| c.is_ascii_digit()))
}
fn portable_segment(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.trim_end_matches(['.', ' ']) == name
        && !name.chars().any(|c| c.is_control() || "/\\<>:\"|?*".contains(c))
        && !reserved_filename(name)
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
    if reserved_filename(name) {
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
#[derive(Debug, Serialize)]
pub struct PreservedEdits {
    pub snapshot: String,
    pub folder: Option<String>,
    pub notes: usize,
}
/// Preserve local work in new destinations only; incoming files and their manifest stay untouched.
pub fn preserve_edits(root: &Path, workspace: &Value, base: &Value) -> Result<PreservedEdits> {
    let mut paths = BTreeMap::new();
    let mut base_paths = BTreeMap::new();
    for (value, planned) in [(workspace, &mut paths), (base, &mut base_paths)] {
        if value["version"] != 1 {
            return Err("Invalid workspace version.".into());
        }
        plan(
            value,
            &value["rootIds"],
            "",
            planned,
            &mut HashSet::new(),
            &Manifest::default(),
        )?;
        if planned.len() != value["nodes"].as_object().ok_or("Invalid notes.")?.len() {
            return Err("Invalid workspace hierarchy.".into());
        }
    }
    let nodes = workspace["nodes"].as_object().unwrap();
    let changed: Vec<_> = paths
        .iter()
        .filter(|(id, path)| {
            let node = &nodes[*id];
            node["type"] == "note"
                && (base_paths.get(*id) != Some(*path)
                    || node["markdown"] != base["nodes"][*id]["markdown"])
        })
        .collect();
    if nodes.values().any(|node| {
        node["type"] == "note" && node["markdown"].as_str().unwrap().len() as u64 > MAX_NOTE
    }) {
        return Err("Keep each note below 10 MB.".into());
    }
    let bytes = serde_json::to_vec_pretty(workspace)
        .map_err(|e| error("Could not prepare recovery backup", e))?;
    if bytes.len() > 100_000_000 {
        return Err(
            "The recovery backup is larger than 100 MB. Your edits are still in memory.".into(),
        );
    }
    let token = format!("{}-{}", now(), Uuid::new_v4());
    let snapshot = format!(".noter/recovery/{token}/workspace.json");
    atomic_write(&safe_path(root, &snapshot)?, &bytes)?;
    if fs::read(safe_path(root, &snapshot)?)
        .map_err(|e| error("Could not verify recovery backup", e))?
        != bytes
    {
        return Err(
            "The recovery backup could not be verified. Your edits are still in memory.".into(),
        );
    }
    let folder = if changed.is_empty() {
        None
    } else {
        Some(format!("Recovered edits {token}"))
    };
    if let Some(folder) = &folder {
        for (id, path) in &changed {
            let bytes = nodes[*id]["markdown"].as_str().unwrap().as_bytes();
            let destination = safe_path(root, &format!("{folder}/{path}"))?;
            atomic_write(&destination, bytes)?;
            if fs::read(destination).map_err(|e| error("Could not verify recovered note", e))?
                != bytes
            {
                return Err(
                    "A recovered note could not be verified. Your edits are still in memory."
                        .into(),
                );
            }
        }
    }
    Ok(PreservedEdits {
        snapshot,
        folder,
        notes: changed.len(),
    })
}
pub fn save(root: &Path, workspace: Value, expected: &str) -> Result<String> {
    save_before_change(root, workspace, expected, &mut |_| {})
}
fn save_before_change(
    root: &Path,
    workspace: Value,
    expected: &str,
    before_change: &mut impl FnMut(&str),
) -> Result<String> {
    let (mut disk, metadata) = read_snapshot(root)?;
    if snapshot_revision(&disk, metadata.as_deref().unwrap_or_default()) != expected {
        return Err("SYNC_CONFLICT: Files changed outside Noter. Reload the folder before saving; your unsaved edits are still here.".into());
    }
    let previous = manifest(metadata.as_deref())?;
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
    let existing_paths: HashSet<_> = previous.paths.values().collect();
    // Only letter case changed: the entry moves in place instead of being copied and removed.
    let case_renames: BTreeMap<&String, &String> = paths
        .iter()
        .filter_map(|(id, new)| {
            let old = previous.paths.get(id)?;
            (old != new && old.to_lowercase() == new.to_lowercase()).then_some((new, old))
        })
        .collect();
    for (id, path) in &paths {
        let target = safe_path(root, path)?;
        if target.exists() && !existing_paths.contains(path) && !case_renames.contains_key(path) {
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
        let content = disk.get(old).and_then(|value| value.as_deref());
        let changed = desired.is_none_or(|path| path != old)
            || content != nodes.get(id).and_then(|node| node["markdown"].as_str());
        if changed && source.is_file() {
            let backup = safe_path(root, &format!("{trash}/{old}"))?;
            if let Some(text) = content {
                atomic_write(&backup, text.as_bytes())?;
            } else {
                atomic_write(
                    &backup,
                    &fs::read(&source).map_err(|e| error("Could not back up note", e))?,
                )?;
            }
        }
    }
    if revision(root)? != expected {
        return Err("SYNC_CONFLICT: Files changed while preparing the save. Your edits are still in memory.".into());
    }
    // On case-insensitive volumes (Windows, default macOS) the new spelling already resolves to the
    // old entry, so copying to it and removing the old path would delete the note. Rename parents
    // first; each child is then found under its parent's new spelling.
    let mut ordered_renames: Vec<_> = case_renames.iter().collect();
    ordered_renames.sort_by_key(|(new, _)| new.matches('/').count());
    for (new, old) in ordered_renames {
        let (parent, name) = new.rsplit_once('/').map_or(("", new.as_str()), |(parent, name)| (parent, name));
        let old_name = old.rsplit('/').next().unwrap_or(old);
        if old_name != name {
            let source = if parent.is_empty() { old_name.to_string() } else { format!("{parent}/{old_name}") };
            before_change(new);
            unchanged_file(root, &source, disk.get(*old))?;
            let (from, to) = (safe_path(root, &source)?, safe_path(root, new)?);
            retry_in_use(|| fs::rename(&from, &to)).map_err(|e| in_use_error("Could not rename note", &from, e))?;
        }
    }
    for (new, old) in &case_renames {
        if let Some(entry) = disk.remove(*old) {
            disk.insert((*new).clone(), entry);
        }
    }
    // Keep source paths until the manifest publishes the completed destinations. An
    // interrupted rename then leaves readable copies rather than broken note IDs.
    for (id, relative) in &paths {
        let target = safe_path(root, relative)?;
        if nodes[id]["type"] == "folder" {
            before_change(relative);
            unchanged_file(root, relative, disk.get(relative))?;
            fs::create_dir_all(target).map_err(|e| error("Could not create note folder", e))?;
            disk.insert(relative.clone(), None);
        } else {
            let markdown = nodes[id]["markdown"].as_str().unwrap();
            if disk.get(relative).and_then(|value| value.as_deref()) != Some(markdown) {
                before_change(relative);
                unchanged_file(root, relative, disk.get(relative))?;
                atomic_write(&target, markdown.as_bytes())?;
                disk.insert(relative.clone(), Some(markdown.to_string()));
            }
        }
    }
    // Case-renamed entries were moved above; their old spelling names the same file.
    let wanted: HashSet<_> = paths.values().map(|path| path.to_lowercase()).collect();
    let mut old_paths: Vec<_> = previous
        .paths
        .values()
        .filter(|path| !wanted.contains(&path.to_lowercase()))
        .collect();
    old_paths.sort_by_key(|path| std::cmp::Reverse(path.len()));
    let mut output_metadata = workspace;
    for node in output_metadata["nodes"].as_object_mut().unwrap().values_mut() {
        node.as_object_mut().unwrap().remove("markdown");
    }
    let bytes = manifest_bytes(&Manifest {
        workspace: output_metadata,
        paths,
    }, &previous, metadata.as_deref())?;
    before_change(".noter/workspace.json");
    if revision(root)? != snapshot_revision(&disk, metadata.as_deref().unwrap_or_default()) {
        return Err("SYNC_CONFLICT: Files changed before publishing the save. Reload the folder before saving again; your edits are still here.".into());
    }
    unchanged_metadata(root, metadata.as_deref())?;
    atomic_write(&safe_path(root, ".noter/workspace.json")?, &bytes)?;
    for old in old_paths {
        let path = safe_path(root, old)?;
        before_change(old);
        unchanged_file(root, old, disk.get(old))?;
        if path.is_file() {
            retry_in_use(|| fs::remove_file(&path)).map_err(|e| in_use_error("Could not move old note", &path, e))?;
            disk.remove(old);
        } else if path.is_dir() {
            // A folder that is another program's working directory stays until that program moves on.
            if retry_in_use(|| fs::remove_dir(&path)).is_ok() {
                disk.remove(old);
            }
        }
    }
    let saved_revision = snapshot_revision(&disk, &bytes);
    if revision(root)? != saved_revision {
        return Err("SYNC_CONFLICT: Files changed while saving. Reload the folder before saving again; your edits are still here.".into());
    }
    Ok(saved_revision)
}
const FINANCE_LOGS: &str = ".noter/finance";
const FINANCE_LEGACY: &str = ".noter/finance.json";
const FINANCE_TEMPLATE: &str = ".noter/finance-template.xlsx";
const MAX_FINANCE_LOGS: u64 = 100_000_000;
fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(problem) if problem.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(problem) => Err(error("Could not read Finance file", problem)),
    }
}
fn file_fingerprint(root: &Path, relative: &str) -> Result<Option<String>> {
    Ok(read_optional(&safe_path(root, relative)?)?.as_deref().map(fingerprint))
}
fn unchanged_finance(root: &Path, relative: &str, expected: Option<&str>) -> Result<()> {
    if file_fingerprint(root, relative)?.as_deref() == expected {
        Ok(())
    } else {
        Err("SYNC_CONFLICT: Finance files changed outside Noter. Reload Finance before saving; the incoming files have been kept.".into())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFinance {
    pub revision: String,
    pub own_log_sha256: Option<String>,
    pub template_sha256: Option<String>,
}
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
        hash.update(format!(
            "{name}\0{}\0{}\n",
            metadata.len(),
            millis(&metadata)
        ));
    }
    for name in [FINANCE_LEGACY, FINANCE_TEMPLATE] {
        match fs::metadata(safe_path(root, name)?) {
            Ok(metadata) => hash.update(format!(
                "{name}\0{}\0{}\n",
                metadata.len(),
                millis(&metadata)
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                hash.update(format!("{name}\0-\n"))
            }
            Err(e) => return Err(error("Could not check Finance files", e)),
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}
/// Raw Finance files: every device log, the legacy single-file data (until migrated), and the Excel template.
pub fn read_finance(root: &Path, device: &str) -> Result<Value> {
    let mut logs = Vec::new();
    let mut checked = Vec::new();
    let own_name = format!("log-{device}.jsonl");
    let mut own_log_sha256 = None;
    let mut total = 0;
    for (name, path, metadata) in finance_logs(root)? {
        total += metadata.len();
        if total > MAX_FINANCE_LOGS {
            return Err("Finance logs are larger than 100 MB.".into());
        }
        let text = fs::read_to_string(&path)
            .map_err(|_| "A Finance log could not be read as UTF-8. Your files have been kept.")?;
        let sha256 = fingerprint(text.as_bytes());
        if name == own_name {
            own_log_sha256 = Some(sha256.clone());
        }
        checked.push((path, sha256));
        logs.push(json!({"name": name, "text": text}));
    }
    let legacy = match fs::read(safe_path(root, FINANCE_LEGACY)?) {
        Ok(bytes) => {
            checked.push((safe_path(root, FINANCE_LEGACY)?, fingerprint(&bytes)));
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|_| "Finance data could not be read. Your files have been kept.")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(e) => return Err(error("Could not read Finance", e)),
    };
    let mut template_sha256 = None;
    let template = match fs::read(safe_path(root, FINANCE_TEMPLATE)?) {
        Ok(bytes) => {
            let sha256 = fingerprint(&bytes);
            template_sha256 = Some(sha256.clone());
            checked.push((safe_path(root, FINANCE_TEMPLATE)?, sha256));
            json!(bytes)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(e) => return Err(error("Could not read Finance workbook", e)),
    };
    for (path, expected) in checked {
        if read_optional(&path)?.as_deref().map(fingerprint).as_deref() != Some(&expected) {
            return Err("SYNC_CONFLICT: Finance changed while loading. Wait for synchronization and reload.".into());
        }
    }
    Ok(json!({"logs": logs, "legacy": legacy, "template": template, "ownLogSha256": own_log_sha256, "templateSha256": template_sha256}))
}
/// Appends one batch line to this device's log. A replaced workbook template is written first,
/// so a batch that references its fingerprint never exists without the template itself.
pub fn append_finance(
    root: &Path,
    device: &str,
    line: &str,
    template: Option<&[u8]>,
    retire_legacy: bool,
    expected_own_log: Option<&str>,
    expected_template: Option<&str>,
) -> Result<SavedFinance> {
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
    let relative = format!("{FINANCE_LOGS}/log-{device}.jsonl");
    let path = safe_path(root, &relative)?;
    let original = read_optional(&path)?;
    if original.as_deref().map(fingerprint).as_deref() != expected_own_log {
        return Err("SYNC_CONFLICT: This device's Finance log changed outside Noter. Reload Finance before saving; the incoming log has been kept.".into());
    }
    unchanged_finance(root, FINANCE_TEMPLATE, expected_template)?;
    let original_bytes = original.as_deref().unwrap_or_default();
    if !original_bytes.is_empty() && original_bytes.last() != Some(&b'\n') && !line.starts_with('\n') {
        return Err("An interrupted Finance log must be reloaded before saving.".into());
    }
    if let Some(bytes) = template {
        if bytes.len() > 10_000_000 {
            return Err("Finance workbook is too large.".into());
        }
        atomic_write(&safe_path(root, FINANCE_TEMPLATE)?, bytes)?;
    }
    fs::create_dir_all(path.parent().ok_or("Invalid Finance location.")?)
        .map_err(|e| error("Could not create Finance folder", e))?;
    let mut recovered = false;
    let mut committed = original_bytes.to_vec();
    committed.extend_from_slice(body.as_bytes());
    // A leading newline signals an ignored interrupted tail, not a record separator.
    // Keep the original recoverable and replace the tail and new batch in one durable write.
    if line.starts_with('\n') {
        let original = original_bytes;
        if !original.is_empty() && original.last() != Some(&b'\n') {
            let backup = safe_path(
                root,
                &format!(
                    ".noter/trash/finance-interrupted-{device}-{}-{}.jsonl",
                    now(),
                    Uuid::new_v4()
                ),
            )?;
            atomic_write(&backup, &original)?;
            let current = safe_path(root, &format!("{FINANCE_LOGS}/log-{device}.jsonl"))?;
            unchanged_finance(root, &relative, expected_own_log)?;
            let end = original
                .iter()
                .rposition(|&byte| byte == b'\n')
                .map_or(0, |index| index + 1);
            let mut repaired = original[..end].to_vec();
            repaired.extend_from_slice(body.as_bytes());
            atomic_write(&current, &repaired)?;
            committed = repaired;
            recovered = true;
        }
    }
    if !recovered {
        unchanged_finance(root, &relative, expected_own_log)?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| error("Could not open Finance log", e))?;
        file.write_all(body.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| error("Could not save Finance", e))?;
    }
    let legacy = safe_path(root, FINANCE_LEGACY)?;
    if retire_legacy && legacy.is_file() {
        let target = safe_path(
            root,
            &format!(
                ".noter/trash/finance-migrated-{}-{}.json",
                now(),
                Uuid::new_v4()
            ),
        )?;
        fs::create_dir_all(target.parent().ok_or("Invalid trash location.")?)
            .map_err(|e| error("Could not create trash folder", e))?;
        retry_in_use(|| fs::rename(&legacy, &target))
            .map_err(|e| in_use_error("Could not retire finance.json", &legacy, e))?;
    }
    let own_log_sha256 = Some(fingerprint(&committed));
    let template_sha256 = template.map(fingerprint).or_else(|| expected_template.map(str::to_string));
    unchanged_finance(root, &relative, own_log_sha256.as_deref())?;
    unchanged_finance(root, FINANCE_TEMPLATE, template_sha256.as_deref())?;
    Ok(SavedFinance { revision: finance_revision(root)?, own_log_sha256, template_sha256 })
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
    fn incomplete_sync_keeps_manifest_bytes_and_note_ids_until_files_arrive() {
        let root = tempfile::tempdir().unwrap();
        let mut metadata = workspace();
        metadata["nodes"]["note"].as_object_mut().unwrap().remove("markdown");
        let bytes = serde_json::to_vec(&json!({"workspace": metadata, "paths": {
            "folder": "Personal", "note": "Personal/✅ October 2.md"
        }})).unwrap();
        fs::create_dir(root.path().join(".noter")).unwrap();
        let path = root.path().join(".noter/workspace.json");
        fs::write(&path, &bytes).unwrap();
        assert!(load(root.path()).err().unwrap().contains("SYNC_CONFLICT"));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::create_dir(root.path().join("Personal")).unwrap();
        assert!(load(root.path()).err().unwrap().contains("SYNC_CONFLICT"));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::write(root.path().join("Personal/✅ October 2.md"), workspace()["nodes"]["note"]["markdown"].as_str().unwrap()).unwrap();
        let loaded = load(root.path()).unwrap();
        assert_eq!(loaded.workspace, workspace());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        save(root.path(), loaded.workspace, &loaded.revision).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    #[test]
    fn unsupported_or_conflicting_metadata_is_never_downgraded() {
        let root = tempfile::tempdir().unwrap();
        let loaded = load(root.path()).unwrap();
        save(root.path(), workspace(), &loaded.revision).unwrap();
        let path = root.path().join(".noter/workspace.json");
        let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut invalid = original.clone();
        invalid["workspace"]["version"] = json!(2);
        let bytes = serde_json::to_vec(&invalid).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(load(root.path()).err().unwrap().contains("Unsupported"));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        invalid = original;
        invalid["paths"]["folder"] = json!("Personal/✅ October 2.md");
        let bytes = serde_json::to_vec(&invalid).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(load(root.path()).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    #[test]
    fn incoming_edits_during_the_write_loop_are_not_overwritten() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("First.md"), "First original\n").unwrap();
        fs::write(root.path().join("Later.md"), "Later original\n").unwrap();
        let loaded = load(root.path()).unwrap();
        let mut local = loaded.workspace;
        for node in local["nodes"].as_object_mut().unwrap().values_mut() {
            node["markdown"] = json!("Local edits\n");
        }
        let failure = save_before_change(root.path(), local, &loaded.revision, &mut |path| {
            if path == "Later.md" {
                fs::write(root.path().join(path), "Incoming edit\n").unwrap();
            }
        }).unwrap_err();
        assert!(failure.contains("SYNC_CONFLICT"));
        assert_eq!(fs::read(root.path().join("Later.md")).unwrap(), b"Incoming edit\n");
    }
    #[test]
    fn incoming_metadata_and_renamed_source_edits_survive_save_races() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("Before.md"), "Original\n").unwrap();
        let loaded = load(root.path()).unwrap();
        let id = loaded.workspace["rootIds"][0].as_str().unwrap().to_string();
        let mut local = loaded.workspace;
        local["nodes"][&id]["name"] = json!("After");
        let failure = save_before_change(root.path(), local, &loaded.revision, &mut |path| {
            if path == "Before.md" {
                fs::write(root.path().join(path), "Incoming source edit\n").unwrap();
            }
        }).unwrap_err();
        assert!(failure.contains("SYNC_CONFLICT"));
        assert_eq!(fs::read(root.path().join("Before.md")).unwrap(), b"Incoming source edit\n");
        let reloaded = load(root.path()).unwrap();
        assert_eq!(reloaded.workspace["nodes"][&id]["name"], "After");
        assert_eq!(reloaded.workspace["nodes"][&id]["markdown"], "Original\n");
        let mut local = reloaded.workspace;
        local["nodes"][&id]["markdown"] = json!("Local second edit\n");
        let path = root.path().join(".noter/workspace.json");
        let bytes = fs::read(&path).unwrap();
        let mut incoming: Value = serde_json::from_slice(&bytes).unwrap();
        incoming["workspace"]["settings"]["fontSize"] = json!(22);
        let bytes = serde_json::to_vec(&incoming).unwrap();
        let failure = save_before_change(root.path(), local, &reloaded.revision, &mut |relative| {
            if relative == ".noter/workspace.json" {
                fs::write(&path, &bytes).unwrap();
            }
        }).unwrap_err();
        assert!(failure.contains("SYNC_CONFLICT"));
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    #[test]
    fn interrupted_renames_keep_a_complete_authoritative_note_path() {
        for stop in [".noter/workspace.json", "Before.md"] {
            let root = tempfile::tempdir().unwrap();
            fs::write(root.path().join("Before.md"), "Original\n").unwrap();
            let loaded = load(root.path()).unwrap();
            let id = loaded.workspace["rootIds"][0].as_str().unwrap().to_string();
            let mut local = loaded.workspace;
            local["nodes"][&id]["name"] = json!("After");
            let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = save_before_change(root.path(), local, &loaded.revision, &mut |path| {
                    if path == stop { panic!("simulated interruption"); }
                });
            }));
            assert!(stopped.is_err());
            assert_eq!(fs::read(root.path().join("Before.md")).unwrap(), b"Original\n");
            assert_eq!(fs::read(root.path().join("After.md")).unwrap(), b"Original\n");
            let reloaded = load(root.path()).unwrap();
            assert_eq!(reloaded.workspace["nodes"][&id]["markdown"], "Original\n");
            assert_eq!(reloaded.workspace["nodes"][&id]["name"], if stop == ".noter/workspace.json" { "Before" } else { "After" });
        }
    }
    #[test]
    fn conflict_recovery_preserves_local_edits_and_incoming_files_as_separate_notes() {
        let root = tempfile::tempdir().unwrap();
        let empty = load(root.path()).unwrap();
        save(root.path(), workspace(), &empty.revision).unwrap();
        fs::write(root.path().join("Keep.md"), "Unchanged locally\n").unwrap();
        let base = load(root.path()).unwrap().workspace;
        let mut local = base.clone();
        local["nodes"]["note"]["markdown"] =
            json!("# Local edits 📝\n\n```noter-database\n{\"rows\":[]}\n```\n");
        local["settings"]["fontSize"] = json!(23);
        let original = root.path().join("Personal/✅ October 2.md");
        fs::write(&original, "Incoming synced edit\n").unwrap();
        fs::write(
            root.path().join("Keep.md"),
            "Incoming edit to untouched note\n",
        )
        .unwrap();
        let manifest_before = fs::read(root.path().join(".noter/workspace.json")).unwrap();
        let preserved = preserve_edits(root.path(), &local, &base).unwrap();
        assert_eq!(preserved.notes, 1);
        let folder = preserved.folder.unwrap();
        assert_eq!(
            fs::read_to_string(
                root.path()
                    .join(format!("{folder}/Personal/✅ October 2.md"))
            )
            .unwrap(),
            local["nodes"]["note"]["markdown"].as_str().unwrap()
        );
        assert!(!root.path().join(format!("{folder}/Keep.md")).exists());
        assert_eq!(
            serde_json::from_slice::<Value>(
                &fs::read(root.path().join(preserved.snapshot)).unwrap()
            )
            .unwrap(),
            local
        );
        assert_eq!(fs::read(&original).unwrap(), b"Incoming synced edit\n");
        assert_eq!(
            fs::read(root.path().join(".noter/workspace.json")).unwrap(),
            manifest_before
        );
        let reopened = load(root.path()).unwrap().workspace;
        assert_eq!(
            reopened["nodes"]["note"]["markdown"],
            "Incoming synced edit\n"
        );
        assert!(
            reopened["nodes"]
                .as_object()
                .unwrap()
                .values()
                .any(|node| node["markdown"] == local["nodes"]["note"]["markdown"])
        );
        let mut settings_only = base.clone();
        settings_only["settings"]["fontSize"] = json!(24);
        let preserved = preserve_edits(root.path(), &settings_only, &base).unwrap();
        assert_eq!(preserved.notes, 0);
        assert!(preserved.folder.is_none());
        assert_eq!(
            serde_json::from_slice::<Value>(
                &fs::read(root.path().join(preserved.snapshot)).unwrap()
            )
            .unwrap(),
            settings_only
        );
    }
    #[test]
    fn recovery_failure_keeps_incoming_files_and_rejects_invalid_hierarchy() {
        let root = tempfile::tempdir().unwrap();
        let empty = load(root.path()).unwrap();
        save(root.path(), workspace(), &empty.revision).unwrap();
        let base = load(root.path()).unwrap().workspace;
        let mut local = base.clone();
        local["nodes"]["note"]["markdown"] = json!("Unsaved local text\n");
        let note = root.path().join("Personal/✅ October 2.md");
        fs::write(&note, "Incoming\n").unwrap();
        fs::write(root.path().join(".noter/recovery"), b"blocked destination").unwrap();
        assert!(preserve_edits(root.path(), &local, &base).is_err());
        assert_eq!(fs::read(&note).unwrap(), b"Incoming\n");
        assert!(!fs::read_dir(root.path()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("Recovered edits")
        }));
        local["rootIds"] = json!([]);
        assert!(
            preserve_edits(root.path(), &local, &base)
                .unwrap_err()
                .contains("hierarchy")
        );
    }
    #[test]
    fn polling_uses_metadata_hints_but_forced_and_periodic_checks_read_content() {
        let root = tempfile::tempdir().unwrap();
        let note = root.path().join("Note.md");
        fs::write(&note, "Before\n").unwrap();
        let modified = fs::metadata(&note).unwrap().modified().unwrap();
        let original = revision(root.path()).unwrap();
        let mut probe = RevisionProbe::default();
        let start = Instant::now();
        assert_eq!(probe.check_at(root.path(), false, start).unwrap(), original);

        fs::write(&note, "Synced\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&note)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let incoming = revision(root.path()).unwrap();
        assert_ne!(incoming, original);
        assert_eq!(
            probe
                .check_at(root.path(), false, start + Duration::from_secs(5))
                .unwrap(),
            original
        );
        assert_eq!(
            probe
                .check_at(root.path(), true, start + Duration::from_secs(6))
                .unwrap(),
            incoming
        );

        fs::write(&note, "Latest\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&note)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(
            probe
                .check_at(root.path(), false, start + Duration::from_secs(11))
                .unwrap(),
            incoming
        );
        assert_eq!(
            probe
                .check_at(root.path(), false, start + Duration::from_secs(66))
                .unwrap(),
            revision(root.path()).unwrap()
        );
    }
    #[test]
    fn a_failed_full_poll_cannot_fall_back_to_a_cached_revision() {
        let root = tempfile::tempdir().unwrap();
        let note = root.path().join("Note.md");
        fs::write(&note, b"valid").unwrap();
        let modified = fs::metadata(&note).unwrap().modified().unwrap();
        let mut probe = RevisionProbe::default();
        probe.check(root.path(), false).unwrap();
        fs::write(&note, [255u8; 5]).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&note)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert!(probe.check(root.path(), true).is_err());
        assert!(probe.check(root.path(), false).is_err());
        fs::write(&note, b"fixed").unwrap();
        assert_eq!(
            probe.check(root.path(), false).unwrap(),
            revision(root.path()).unwrap()
        );
    }
    #[test]
    fn polling_detects_note_metadata_and_tree_changes_and_folder_switches() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let note = root.path().join("Note.md");
        fs::write(&note, "First\n").unwrap();
        let mut probe = RevisionProbe::default();
        let original = probe.check(root.path(), false).unwrap();
        fs::write(&note, "Longer incoming note\n").unwrap();
        let changed = probe.check(root.path(), false).unwrap();
        assert_ne!(changed, original);
        assert_eq!(changed, revision(root.path()).unwrap());
        fs::create_dir(root.path().join("Empty folder")).unwrap();
        let with_folder = probe.check(root.path(), false).unwrap();
        assert_ne!(with_folder, changed);
        fs::rename(&note, root.path().join("Renamed.md")).unwrap();
        let renamed = probe.check(root.path(), false).unwrap();
        assert_ne!(renamed, with_folder);
        fs::remove_file(root.path().join("Renamed.md")).unwrap();
        let deleted = probe.check(root.path(), false).unwrap();
        assert_ne!(deleted, renamed);
        fs::create_dir(root.path().join(".noter")).unwrap();
        fs::write(root.path().join(".noter/workspace.json"), "{}").unwrap();
        let metadata = probe.check(root.path(), false).unwrap();
        assert_ne!(metadata, deleted);
        fs::write(other.path().join("Note.md"), "Other\n").unwrap();
        assert_eq!(
            probe.check(other.path(), false).unwrap(),
            revision(other.path()).unwrap()
        );
        assert_eq!(probe.check(root.path(), false).unwrap(), metadata);
    }
    #[test]
    fn targeted_saves_preserve_other_notes_and_detect_same_size_synced_edits() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("Edit.md"), "Before\n").unwrap();
        let untouched = root.path().join("Keep.md");
        fs::write(&untouched, "Original\n").unwrap();
        let original_time = fs::metadata(&untouched).unwrap().modified().unwrap();
        let loaded = load(root.path()).unwrap();
        let note_id = loaded.workspace["nodes"]
            .as_object()
            .unwrap()
            .iter()
            .find(|(_, node)| node["name"] == "Edit")
            .unwrap()
            .0
            .clone();
        let mut next = loaded.workspace;
        next["settings"]["fontSize"] = json!(20);
        let revision = save(root.path(), next.clone(), &loaded.revision).unwrap();
        assert!(!root.path().join(".noter/trash").exists());
        next["nodes"][&note_id]["markdown"] = json!("After\n");
        let revision = save(root.path(), next.clone(), &revision).unwrap();
        assert_eq!(
            fs::metadata(&untouched).unwrap().modified().unwrap(),
            original_time
        );
        let backups: Vec<_> = fs::read_dir(root.path().join(".noter/trash"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(backups[0].join("Edit.md")).unwrap(), b"Before\n");
        assert!(!backups[0].join("Keep.md").exists());
        assert_eq!(load(root.path()).unwrap().workspace, next);

        fs::write(&untouched, "External\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&untouched)
            .unwrap()
            .set_modified(original_time)
            .unwrap();
        assert!(
            save(root.path(), next, &revision)
                .unwrap_err()
                .contains("SYNC_CONFLICT")
        );
        assert_eq!(fs::read(&untouched).unwrap(), b"External\n");
    }
    #[test]
    fn removing_notes_keeps_folders_that_contain_unmanaged_files() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("Attachments")).unwrap();
        fs::write(root.path().join("Attachments/Note.md"), "Keep a backup\n").unwrap();
        fs::write(
            root.path().join("Attachments/photo.bin"),
            b"unmanaged bytes",
        )
        .unwrap();
        let loaded = load(root.path()).unwrap();
        let mut next = loaded.workspace;
        next["nodes"] = json!({});
        next["rootIds"] = json!([]);
        next["openTabs"] = json!([]);
        next["activeNoteId"] = Value::Null;
        let saved = save(root.path(), next, &loaded.revision).unwrap();
        assert_eq!(saved, revision(root.path()).unwrap());
        assert!(!root.path().join("Attachments/Note.md").exists());
        assert_eq!(
            fs::read(root.path().join("Attachments/photo.bin")).unwrap(),
            b"unmanaged bytes"
        );
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
    fn link_folder(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        // Junctions need neither Developer Mode nor administrator rights, so any Windows user can create one.
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout) + String::from_utf8_lossy(&output.stderr));
        }
    }
    #[test]
    fn symlinks_never_escape_the_workspace() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("Outside.md"), "Private\n").unwrap();
        link_folder(outside.path(), &root.path().join("Linked"));
        let loaded = load(root.path()).unwrap();
        assert!(loaded.workspace["nodes"].as_object().unwrap().is_empty());
        assert!(safe_path(root.path(), "Linked/Outside.md").is_err());
        let root = tempfile::tempdir().unwrap();
        link_folder(outside.path(), &root.path().join(".noter"));
        assert!(load(root.path()).is_err());
        assert!(!outside.path().join("workspace.json").exists());
    }
    #[test]
    fn case_only_renames_keep_notes_and_folders() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("todo.md"), "Keep me\n").unwrap();
        fs::create_dir(root.path().join("work")).unwrap();
        fs::write(root.path().join("work/a.md"), "Inside\n").unwrap();
        let loaded = load(root.path()).unwrap();
        let id = |name: &str| loaded.workspace["nodes"].as_object().unwrap().values()
            .find(|node| node["name"] == name).unwrap()["id"].as_str().unwrap().to_string();
        let (note, folder, child) = (id("todo"), id("work"), id("a"));
        let mut edited = loaded.workspace.clone();
        edited["nodes"][&note]["name"] = json!("Todo");
        edited["nodes"][&folder]["name"] = json!("Work");
        edited["nodes"][&child]["name"] = json!("A");
        save(root.path(), edited.clone(), &loaded.revision).unwrap();
        let mut names: Vec<_> = fs::read_dir(root.path()).unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| !name.starts_with('.')).collect();
        names.sort();
        assert_eq!(names, ["Todo.md", "Work"]);
        let children: Vec<_> = fs::read_dir(root.path().join("Work")).unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(children, ["A.md"]);
        assert_eq!(fs::read_to_string(root.path().join("Todo.md")).unwrap(), "Keep me\n");
        assert_eq!(fs::read_to_string(root.path().join("Work/A.md")).unwrap(), "Inside\n");
        let reloaded = load(root.path()).unwrap();
        assert_eq!(reloaded.workspace["nodes"], edited["nodes"]);
        // An external case-only rename keeps the same note ID.
        fs::rename(root.path().join("Todo.md"), root.path().join("TODO.md")).unwrap();
        let renamed = load(root.path()).unwrap();
        assert_eq!(renamed.workspace["nodes"][&note]["name"], "TODO");
        assert_eq!(renamed.workspace["nodes"][&note]["markdown"], "Keep me\n");
    }
    #[test]
    fn utf8_bom_and_utf16_notes_load_and_keep_their_bytes_until_edited() {
        let root = tempfile::tempdir().unwrap();
        let bom = [b"\xEF\xBB\xBF".as_slice(), "# Bom\r\n".as_bytes()].concat();
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter()
            .chain("# Wide ✓\r\n".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        fs::write(root.path().join("Bom.md"), &bom).unwrap();
        fs::write(root.path().join("Wide.md"), &utf16).unwrap();
        fs::write(root.path().join("Plain.md"), "Plain\n").unwrap();
        let loaded = load(root.path()).unwrap();
        let notes = loaded.workspace["nodes"].as_object().unwrap();
        let id = |name: &str| notes.values().find(|node| node["name"] == name).unwrap()["id"].as_str().unwrap().to_string();
        assert_eq!(notes[&id("Bom")]["markdown"], "# Bom\r\n");
        assert_eq!(notes[&id("Wide")]["markdown"], "# Wide ✓\r\n");
        let mut edited = loaded.workspace.clone();
        edited["nodes"][&id("Plain")]["markdown"] = json!("Edited\n");
        let revision = save(root.path(), edited.clone(), &loaded.revision).unwrap();
        assert_eq!(fs::read(root.path().join("Bom.md")).unwrap(), bom);
        assert_eq!(fs::read(root.path().join("Wide.md")).unwrap(), utf16);
        edited["nodes"][&id("Wide")]["markdown"] = json!("# Wide ✓\n\nMore\n");
        save(root.path(), edited, &revision).unwrap();
        assert_eq!(fs::read(root.path().join("Wide.md")).unwrap(), "# Wide ✓\n\nMore\n".as_bytes());
        fs::write(root.path().join("Broken.md"), [0xC3, 0x28]).unwrap();
        assert!(load(root.path()).err().unwrap().contains("Broken.md"));
    }
    #[test]
    fn drive_root_system_folders_are_not_notes() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("System Volume Information")).unwrap();
        fs::write(root.path().join("System Volume Information/Tracking.md"), "x").unwrap();
        fs::create_dir(root.path().join("$RECYCLE.BIN")).unwrap();
        fs::write(root.path().join("$RECYCLE.BIN/$R1.md"), "deleted").unwrap();
        fs::write(root.path().join("Note.md"), "Kept\n").unwrap();
        let loaded = load(root.path()).unwrap();
        let names: Vec<_> = loaded.workspace["nodes"].as_object().unwrap().values().map(|node| node["name"].clone()).collect();
        assert_eq!(names, [json!("Note")]);
    }
    #[cfg(windows)]
    #[test]
    fn windows_read_only_hidden_system_and_busy_files_do_not_block_saves() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("Locked.md"), "Original\n").unwrap();
        fs::create_dir(root.path().join("Protected")).unwrap();
        fs::write(root.path().join("Protected/Hidden.md"), "x").unwrap();
        assert!(std::process::Command::new("attrib").args(["+h", "+s"]).arg(root.path().join("Protected")).status().unwrap().success());
        let mut permissions = fs::metadata(root.path().join("Locked.md")).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(root.path().join("Locked.md"), permissions).unwrap();
        let loaded = load(root.path()).unwrap();
        assert_eq!(loaded.workspace["nodes"].as_object().unwrap().len(), 1);
        let id = loaded.workspace["nodes"].as_object().unwrap().keys().next().unwrap().clone();
        let mut edited = loaded.workspace.clone();
        edited["nodes"][&id]["markdown"] = json!("Edited read-only note\n");
        let revision = save(root.path(), edited.clone(), &loaded.revision).unwrap();
        assert_eq!(fs::read_to_string(root.path().join("Locked.md")).unwrap(), "Edited read-only note\n");
        // Syncthing (Go) opens files without delete sharing while hashing; the replace waits for it.
        let held = fs::OpenOptions::new().read(true).share_mode(1 | 2).open(root.path().join("Locked.md")).unwrap();
        let release = std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(300)); drop(held); });
        edited["nodes"][&id]["markdown"] = json!("Saved after Syncthing finished\n");
        save(root.path(), edited, &revision).unwrap();
        release.join().unwrap();
        assert_eq!(fs::read_to_string(root.path().join("Locked.md")).unwrap(), "Saved after Syncthing finished\n");
    }
    #[cfg(windows)]
    #[test]
    fn workspace_paths_are_shown_without_the_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\Users\me\Notes")), r"C:\Users\me\Notes");
        assert_eq!(display_path(Path::new(r"\\?\UNC\server\share\Notes")), r"\\server\share\Notes");
        assert_eq!(display_path(Path::new(r"\\?\C:\Notes.")), r"\\?\C:\Notes.");
        assert_eq!(display_path(Path::new(r"C:\Notes")), r"C:\Notes");
    }
    #[test]
    fn finance_logs_append_per_device_and_retire_legacy_data() {
        let root = tempfile::tempdir().unwrap();
        let empty = finance_revision(root.path()).unwrap();
        assert_eq!(read_finance(root.path(), "abc").unwrap()["logs"], json!([]));
        fs::create_dir(root.path().join(".noter")).unwrap();
        fs::write(root.path().join(".noter/finance.json"), r#"{"version":1}"#).unwrap();
        let line = "{\"v\":1,\"ts\":1,\"dev\":\"abc\",\"seq\":1,\"ops\":[]}\n";
        let saved =
            append_finance(root.path(), "abc", line, Some(&[1, 2, 3]), true, None, None).unwrap();
        let revision = saved.revision.clone();
        assert_ne!(revision, empty);
        let stale = fingerprint(b"stale");
        let template = saved.template_sha256.as_deref();
        let rejected = append_finance(root.path(), "abc", line, None, false, Some(&stale), template);
        assert!(rejected.is_err_and(|message| message.starts_with("SYNC_CONFLICT")));
        let own = saved.own_log_sha256.as_deref();
        let saved =
            append_finance(root.path(), "abc", &format!("\n{line}"), None, false, own, template)
                .unwrap();
        let loaded = read_finance(root.path(), "abc").unwrap();
        assert_eq!(loaded["ownLogSha256"], json!(saved.own_log_sha256));
        assert_eq!(loaded["templateSha256"], json!(saved.template_sha256));
        assert_eq!(loaded["logs"][0]["name"], "log-abc.jsonl");
        assert_eq!(loaded["logs"][0]["text"], format!("{line}{line}"));
        assert_eq!(loaded["template"], json!([1, 2, 3]));
        assert_eq!(loaded["legacy"], Value::Null);
        assert!(
            fs::read_dir(root.path().join(".noter/trash"))
                .unwrap()
                .next()
                .is_some()
        );
        fs::write(root.path().join(".noter/finance/log-other.jsonl"), line).unwrap();
        assert_ne!(finance_revision(root.path()).unwrap(), revision);
        assert_eq!(
            read_finance(root.path(), "abc").unwrap()["logs"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn finance_rejects_invalid_changes_and_devices() {
        let root = tempfile::tempdir().unwrap();
        let line = "{\"v\":1}\n";
        let append = |device, line| append_finance(root.path(), device, line, None, false, None, None);
        assert!(append("../x", line).is_err());
        assert!(append("abc", "{\"v\":1}").is_err());
        assert!(append("abc", "{\"v\":1}\n{}\n").is_err());
        assert!(append("abc", "not json\n").is_err());
        assert!(!root.path().join(".noter/finance").exists());
    }
    #[test]
    fn finance_recovers_only_an_interrupted_tail_and_backs_up_the_original() {
        let root = tempfile::tempdir().unwrap();
        let first = "{\"v\":1,\"ts\":1,\"dev\":\"abc\",\"seq\":1,\"ops\":[]}\n";
        let second = "{\"v\":1,\"ts\":2,\"dev\":\"abc\",\"seq\":2,\"ops\":[]}\n";
        let next = "{\"v\":1,\"ts\":3,\"dev\":\"abc\",\"seq\":3,\"ops\":[]}\n";
        let path = root.path().join(".noter/finance/log-abc.jsonl");
        let original = format!("{first}{second}{{\"v\":1,\"ts\":3,");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &original).unwrap();
        fs::write(
            root.path().join(".noter/finance/log-other.jsonl"),
            "unfinished",
        )
        .unwrap();
        let interrupted = fingerprint(original.as_bytes());
        let saved =
            append_finance(root.path(), "abc", &format!("\n{next}"), None, false, Some(&interrupted), None)
                .unwrap();
        let recovered = fs::read_to_string(&path).unwrap();
        assert_eq!(recovered, format!("{first}{second}{next}"));
        assert!(
            recovered
                .lines()
                .all(|line| serde_json::from_str::<Value>(line).is_ok())
        );
        let backup = fs::read_dir(root.path().join(".noter/trash"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(fs::read_to_string(backup).unwrap(), original);
        assert_eq!(
            fs::read_to_string(root.path().join(".noter/finance/log-other.jsonl")).unwrap(),
            "unfinished"
        );
        // A stale recovery signal must retain records that already completed on disk.
        let own = saved.own_log_sha256.as_deref();
        append_finance(root.path(), "abc", &format!("\n{next}"), None, false, own, None).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("{first}{second}{next}{next}")
        );
        assert_eq!(
            fs::read_dir(root.path().join(".noter/trash"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    fn finance_recovery_does_not_discard_data_when_backup_fails() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".noter/finance/log-abc.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "interrupted").unwrap();
        fs::write(root.path().join(".noter/trash"), "not a directory").unwrap();
        let interrupted = fingerprint(b"interrupted");
        let line = "\n{\"v\":1}\n";
        assert!(append_finance(root.path(), "abc", line, None, false, Some(&interrupted), None).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "interrupted");
    }
    #[test]
    fn shared_workspace_fixture_round_trips_without_schema_or_markdown_changes() {
        let root = tempfile::tempdir().unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/file-storage");
        let manifest_bytes = fs::read(fixture.join("workspace.json")).unwrap();
        let manifest: Value = serde_json::from_slice(&manifest_bytes).unwrap();
        let mut expected = manifest["workspace"].clone();
        for (id, relative) in manifest["paths"].as_object().unwrap() {
            let relative = relative.as_str().unwrap();
            if expected["nodes"][id]["type"] == "folder" {
                fs::create_dir_all(root.path().join(relative)).unwrap();
            } else {
                let markdown = fs::read_to_string(fixture.join(relative)).unwrap();
                let target = root.path().join(relative);
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::write(target, markdown.as_bytes()).unwrap();
                expected["nodes"][id]["markdown"] = json!(markdown);
            }
        }
        fs::create_dir_all(root.path().join(".noter")).unwrap();
        fs::write(root.path().join(".noter/workspace.json"), manifest_bytes).unwrap();
        let loaded = load(root.path()).unwrap();
        assert_eq!(loaded.workspace, expected);
        save(root.path(), loaded.workspace, &loaded.revision).unwrap();
        let reloaded = load(root.path()).unwrap();
        assert_eq!(reloaded.workspace, expected);
        let saved: Value =
            serde_json::from_slice(&fs::read(root.path().join(".noter/workspace.json")).unwrap())
                .unwrap();
        assert_eq!(saved, manifest);
        for (id, relative) in manifest["paths"].as_object().unwrap() {
            if expected["nodes"][id]["type"] == "note" {
                let relative = relative.as_str().unwrap();
                assert_eq!(
                    fs::read(root.path().join(relative)).unwrap(),
                    fs::read(fixture.join(relative)).unwrap()
                );
            }
        }
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
