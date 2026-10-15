//! Line counts and `git diff -U0` patch text for one file's change.
//!
//! The patch is read back by the extension's patch-id code, which hashes the
//! mode and rename headers and the hunk bodies, so those have to come out as
//! git writes them for a reviewed file to keep its viewed tick. The `index`
//! line matters too: its base-side blob is how a tick notices the ground under
//! it moved. Hunk line numbers are not hashed, but are written correctly anyway
//! so the text reads as a real patch.

use gix::diff::blob::{Algorithm, InternedInput, diff_with_slider_heuristics};
use std::fmt::Write;

/// How much of a blob git inspects for a NUL when deciding it is binary.
const BINARY_SNIFF_BYTES: usize = 8000;

pub fn is_binary(data: &[u8]) -> bool {
    data[..data.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// What one side of a change holds.
pub struct Side<'a> {
    pub path: &'a str,
    /// Octal tree mode, e.g. `100644`.
    pub mode: u32,
    /// Abbreviated object id as the `index` line shows it.
    pub short_id: String,
    pub data: &'a [u8],
}

pub enum Kind {
    Added,
    Deleted,
    Modified,
    Renamed { similarity: u32, copy: bool },
}

pub struct Rendered {
    /// Unset for binary files, as `git diff --numstat` reports `-`.
    pub counts: Option<(u32, u32)>,
    pub patch: String,
}

/// `old` is absent for an addition and `new` for a deletion.
pub fn render(kind: &Kind, old: Option<&Side<'_>>, new: Option<&Side<'_>>, submodule: bool) -> Rendered {
    let old_path = old.or(new).map(|s| s.path).unwrap_or_default();
    let new_path = new.or(old).map(|s| s.path).unwrap_or_default();
    let mut out = String::new();
    let _ = writeln!(out, "diff --git {} {}", quote(&format!("a/{old_path}")), quote(&format!("b/{new_path}")));

    let old_mode = old.map(|s| s.mode);
    let new_mode = new.map(|s| s.mode);
    match kind {
        Kind::Added => {
            let _ = writeln!(out, "new file mode {:o}", new_mode.unwrap_or(0o100644));
        }
        Kind::Deleted => {
            let _ = writeln!(out, "deleted file mode {:o}", old_mode.unwrap_or(0o100644));
        }
        Kind::Modified | Kind::Renamed { .. } => {
            if old_mode != new_mode {
                let _ = writeln!(out, "old mode {:o}", old_mode.unwrap_or(0));
                let _ = writeln!(out, "new mode {:o}", new_mode.unwrap_or(0));
            }
        }
    }
    if let Kind::Renamed { similarity, copy } = kind {
        let verb = if *copy { "copy" } else { "rename" };
        let _ = writeln!(out, "similarity index {similarity}%");
        let _ = writeln!(out, "{verb} from {}", quote(old_path));
        let _ = writeln!(out, "{verb} to {}", quote(new_path));
    }

    let old_data = old.map_or(&[][..], |s| s.data);
    let new_data = new.map_or(&[][..], |s| s.data);
    let same_content = matches!(kind, Kind::Modified | Kind::Renamed { .. }) && old_data == new_data;
    if same_content {
        // A pure rename or mode change: headers only, no index line, no hunks.
        return Rendered { counts: Some((0, 0)), patch: out };
    }

    let zero = |len: usize| "0".repeat(len.max(7));
    let old_short = old.map(|s| s.short_id.clone()).unwrap_or_else(|| zero(new.map_or(7, |s| s.short_id.len())));
    let new_short = new.map(|s| s.short_id.clone()).unwrap_or_else(|| zero(old.map_or(7, |s| s.short_id.len())));
    // The mode rides on the index line only when both sides share it.
    match (old_mode, new_mode) {
        (Some(a), Some(b)) if a == b => {
            let _ = writeln!(out, "index {old_short}..{new_short} {a:o}");
        }
        _ => {
            let _ = writeln!(out, "index {old_short}..{new_short}");
        }
    }

    let old_label = if old.is_some() { quote(&format!("a/{old_path}")) } else { "/dev/null".into() };
    let new_label = if new.is_some() { quote(&format!("b/{new_path}")) } else { "/dev/null".into() };

    if submodule {
        let _ = writeln!(out, "--- {old_label}\n+++ {new_label}");
        let (removed, added) = (u32::from(old.is_some()), u32::from(new.is_some()));
        let _ = writeln!(out, "@@ -{} +{} @@", range(0, removed), range(0, added));
        if let Some(s) = old {
            let _ = writeln!(out, "-Subproject commit {}", String::from_utf8_lossy(s.data));
        }
        if let Some(s) = new {
            let _ = writeln!(out, "+Subproject commit {}", String::from_utf8_lossy(s.data));
        }
        return Rendered { counts: Some((added, removed)), patch: out };
    }

    if is_binary(old_data) || is_binary(new_data) {
        let _ = writeln!(out, "Binary files {old_label} and {new_label} differ");
        return Rendered { counts: None, patch: out };
    }
    // An empty file added or deleted has no lines to show.
    if old_data.is_empty() && new_data.is_empty() {
        return Rendered { counts: Some((0, 0)), patch: out };
    }

    let _ = writeln!(out, "--- {old_label}\n+++ {new_label}");
    let input = InternedInput::new(old_data, new_data);
    let diff = diff_with_slider_heuristics(Algorithm::Myers, &input);
    let (mut added, mut removed) = (0u32, 0u32);
    for hunk in diff.hunks() {
        let before = hunk.before.clone();
        let after = hunk.after.clone();
        removed += before.end - before.start;
        added += after.end - after.start;
        let _ = writeln!(
            out,
            "@@ -{} +{} @@",
            range(before.start, before.end - before.start),
            range(after.start, after.end - after.start)
        );
        for token in &input.before[before.start as usize..before.end as usize] {
            write_line(&mut out, '-', input.interner[*token]);
        }
        for token in &input.after[after.start as usize..after.end as usize] {
            write_line(&mut out, '+', input.interner[*token]);
        }
    }
    Rendered { counts: Some((added, removed)), patch: out }
}

/// A hunk side as git writes it: `start,len` with `,1` left off, and for an
/// empty side the line before it rather than the one after.
fn range(start: u32, len: u32) -> String {
    match len {
        0 => format!("{start},0"),
        1 => format!("{}", start + 1),
        n => format!("{},{n}", start + 1),
    }
}

fn write_line(out: &mut String, marker: char, line: &[u8]) {
    out.push(marker);
    match line.strip_suffix(b"\n") {
        Some(body) => {
            out.push_str(&String::from_utf8_lossy(body));
            out.push('\n');
        }
        None => {
            out.push_str(&String::from_utf8_lossy(line));
            out.push_str("\n\\ No newline at end of file\n");
        }
    }
}

/// Git's C-style quoting, applied even with `core.quotePath=false` to a path
/// holding a quote, backslash, or control character.
pub fn quote(path: &str) -> String {
    if !path.chars().any(|c| c == '"' || c == '\\' || (c as u32) < 0x20 || c == '\x7f') {
        return path.to_string();
    }
    let mut out = String::from("\"");
    for c in path.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\x07' => out.push_str("\\a"),
            '\x08' => out.push_str("\\b"),
            '\x0b' => out.push_str("\\v"),
            '\x0c' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || c == '\x7f' => {
                let _ = write!(out, "\\{:03o}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Lines in a blob as `git diff --numstat` counts an added file: a final line
/// with no newline still counts.
pub fn count_lines(data: &[u8]) -> u32 {
    if data.is_empty() {
        return 0;
    }
    let newlines = data.iter().filter(|&&b| b == b'\n').count() as u32;
    newlines + u32::from(*data.last().unwrap_or(&b'\n') != b'\n')
}
