use std::{
    collections::BTreeMap,
    io::{Cursor, Read, Write},
    path::{Component, Path},
};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};
const LIMIT: u64 = 40_000_000;
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('\\')
        && Path::new(name)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}
pub fn unpack(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "Workbook is not a supported ZIP archive.")?;
    if archive.len() > 4096 {
        return Err("Workbook has too many parts.".into());
    }
    let mut result = BTreeMap::new();
    let mut total = 0;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|_| "Workbook contains an unreadable ZIP part.")?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        if !valid_name(&name) || result.contains_key(&name) {
            return Err("Workbook contains invalid or duplicate part names.".into());
        }
        if file.size() > LIMIT - total {
            return Err("Workbook expands beyond the supported 40 MB limit.".into());
        }
        let mut data = Vec::new();
        file.take(LIMIT - total + 1)
            .read_to_end(&mut data)
            .map_err(|_| "Workbook contains corrupt compressed data.")?;
        total += data.len() as u64;
        if total > LIMIT {
            return Err("Workbook expands beyond the supported 40 MB limit.".into());
        }
        result.insert(name, data);
    }
    Ok(result)
}
pub fn pack(files: BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, String> {
    if files.len() > 4096 || files.values().map(|bytes| bytes.len() as u64).sum::<u64>() > LIMIT {
        return Err("Workbook exceeds supported export limits.".into());
    }
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6));
    for (name, bytes) in files {
        if !valid_name(&name) {
            return Err("Workbook contains an invalid part name.".into());
        }
        archive
            .start_file(name, options)
            .map_err(|_| "Could not prepare workbook part.")?;
        archive
            .write_all(&bytes)
            .map_err(|_| "Could not write workbook part.")?;
    }
    Ok(archive
        .finish()
        .map_err(|_| "Could not finish workbook export.")?
        .into_inner())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_and_xml_parts_round_trip_and_unsafe_archives_are_rejected() {
        let parts = BTreeMap::from([
            ("xl/workbook.xml".into(), b"<workbook/>".to_vec()),
            ("xl/media/image.png".into(), vec![0, 255, 10, 0]),
        ]);
        assert_eq!(unpack(&pack(parts.clone()).unwrap()).unwrap(), parts);
        assert!(unpack(b"not a workbook").is_err());
        assert!(pack(BTreeMap::from([("../outside.xml".into(), vec![1])])).is_err());
    }
    #[test]
    fn actual_workbook_archive_preserves_every_part() {
        let Ok(path) = std::env::var("BANK_TEST_WORKBOOK") else {
            return;
        };
        let bytes = std::fs::read(path).expect("Could not open optional workbook fixture.");
        let original = unpack(&bytes).expect("Could not unpack workbook.");
        let restored = unpack(&pack(original.clone()).expect("Could not repack workbook."))
            .expect("Could not restore workbook.");
        assert!(
            original == restored,
            "Workbook parts must round-trip without changes."
        );
    }
}
