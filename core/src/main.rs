//! The extension's git read path, answered in-process with gix instead of one
//! `git` child process per question.
//!
//! The extension starts this once and keeps it running. Each request is one
//! line of JSON on stdin, `{"id": 1, "method": "...", "params": {...}}`, and
//! each answer one line on stdout, `{"id": 1, "result": ...}` or
//! `{"id": 1, "error": "..."}`. Requests run on their own threads, so a slow
//! diff for one worktree doesn't hold up a quick lookup for another, and
//! answers arrive in whatever order they finish.
//!
//! Only reads live here. Checkouts, branch creation and fetches stay with the
//! `git` CLI, which owns the safety checks around moving a worktree.

mod diff;
mod ops;
mod patch;
mod repos;

use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

#[derive(Deserialize)]
struct Request {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

fn main() {
    let repos = Arc::new(repos::Repos::default());
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let stdin = std::io::stdin();
    let mut running = Vec::new();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("wt-core: unreadable request: {e}");
                continue;
            }
        };
        let repos = Arc::clone(&repos);
        let stdout = Arc::clone(&stdout);
        // Finished threads are dropped as we go so a long session doesn't
        // accumulate handles.
        running.retain(|h: &std::thread::JoinHandle<()>| !h.is_finished());
        running.push(std::thread::spawn(move || {
            let id = request.id;
            let answer = match ops::dispatch(&repos, &request.method, request.params) {
                Ok(result) => json!({ "id": id, "result": result }),
                Err(e) => json!({ "id": id, "error": format!("{e:#}") }),
            };
            let mut text = answer.to_string();
            text.push('\n');
            let mut out = stdout.lock().unwrap_or_else(|p| p.into_inner());
            // A closed pipe means the extension host went away; nothing to tell.
            let _ = out.write_all(text.as_bytes()).and_then(|()| out.flush());
        }));
    }
    // Stdin closed: answer what was already asked before exiting.
    for handle in running {
        let _ = handle.join();
    }
}
