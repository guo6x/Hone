// Hone Scheduler — Cron-based task execution engine.
//
// Runs as a background tokio task within the Tauri app.  Every 30 seconds it
// loads schedules from disk, evaluates their cron expressions, and when a
// schedule fires it:
//   1. Spawns `node <hone_path>/dist/cli.js -p "<task>"` (the hone CLI)
//   2. Writes an execution log entry
//   3. Updates the schedule's last_run / next_run timestamps
//
// The CLI process output is captured and stored in-schedule so the frontend
// can display history.

use crate::windows_git_bash;
use crate::windows_proxy;
use chrono::{DateTime, Datelike, Local, Timelike, Utc};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tokio::process::Command;
use tokio::time::{interval, Duration};

// ── Schedule types (mirrors frontend ScheduleInfo) ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleInfo {
    pub id: String,
    pub title: String,
    pub desc: String,
    pub trigger: String, // "cron" | "interval" | "once"
    pub cron: String,
    #[serde(rename = "triggerLabel")]
    pub trigger_label: String,
    #[serde(rename = "nextRun")]
    pub next_run: String,
    pub enabled: bool,
    #[serde(rename = "lastRun")]
    pub last_run: Option<String>,
    #[serde(rename = "lastStatus")]
    pub last_status: Option<String>, // "success" | "fail" | null
    pub delivery: String, // "desktop" | "cli" | "session"
}

// ── Cron parser ────────────────────────────────────────────────────────────

/// Parsed 5-field cron expression: minute hour dom month dow
struct CronExpr {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    dom: Vec<u32>,    // day of month (1-31)
    months: Vec<u32>, // 1-12
    dow: Vec<u32>,    // day of week (0=Sun..6=Sat)
}

impl CronExpr {
    fn parse(raw: &str) -> Option<Self> {
        let fields: Vec<&str> = raw.trim().split_whitespace().collect();
        if fields.len() != 5 {
            // Also accept 6-field (with seconds), ignore leading field
            if fields.len() == 6 {
                return Self::parse_from(&fields[1..]);
            }
            return None;
        }
        Self::parse_from(&fields)
    }

    fn parse_from(fields: &[&str]) -> Option<Self> {
        Some(Self {
            minutes: parse_field(fields[0], 0, 59)?,
            hours: parse_field(fields[1], 0, 23)?,
            dom: parse_field(fields[2], 1, 31)?,
            months: parse_field(fields[3], 1, 12)?,
            dow: parse_field(fields[4], 0, 6)?,
        })
    }

    /// Check if this cron expression matches the given UTC time.
    fn matches(&self, dt: &DateTime<Utc>) -> bool {
        self.minutes.contains(&dt.minute())
            && self.hours.contains(&dt.hour())
            && self.dom.contains(&dt.day())
            && self.months.contains(&dt.month())
            && self.dow.contains(&dt.weekday().num_days_from_sunday())
    }
}

/// Parse a single cron field.  Supports:
///   *         → wildcard (all values)
///   N         → literal value
///   N,M,O     → comma-separated list
///   N-M       → inclusive range
///   */N       → step (every N)
fn parse_field(raw: &str, min: u32, max: u32) -> Option<Vec<u32>> {
    if raw == "*" {
        return Some((min..=max).collect());
    }

    let mut values = Vec::new();

    // Step syntax: */5
    if let Some(step_str) = raw.strip_prefix("*/") {
        let step: u32 = step_str.parse().ok()?;
        let mut v = min;
        while v <= max {
            values.push(v);
            v += step;
        }
        return Some(values);
    }

    // Comma-separated
    for part in raw.split(',') {
        let part = part.trim();
        if part.contains('-') {
            let range: Vec<&str> = part.split('-').collect();
            if range.len() != 2 {
                return None;
            }
            let lo: u32 = range[0].parse().ok()?;
            let hi: u32 = range[1].parse().ok()?;
            if lo < min || hi > max || lo > hi {
                return None;
            }
            for v in lo..=hi {
                values.push(v);
            }
        } else {
            let v: u32 = part.parse().ok()?;
            if v < min || v > max {
                return None;
            }
            values.push(v);
        }
    }

    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

// ── Execution log ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionLog {
    pub schedule_id: String,
    pub triggered_at: String,
    pub status: String, // "success" | "fail"
    pub output: String,
    pub duration_ms: u64,
}

// ── Scheduler state (shared via Arc<Mutex<>>) ─────────────────────────────

#[derive(Default)]
struct SchedulerState {
    /// Last-run timestamps per schedule ID, to prevent double-fires within
    /// the same minute.
    last_fire: HashMap<String, DateTime<Utc>>,
    /// Recent execution logs (ring buffer, capped at 200).
    execution_log: Vec<ExecutionLog>,
}

/// Spawn the background scheduler task.  It will run until the Tauri app exits
/// (the tokio runtime shuts down).
///
/// `hone_path` is the absolute path to the Hone project root (where
/// `dist/cli.js` lives).
///
/// `relay_url` is optional — if provided the scheduler will also attempt
/// to notify the relay when a task completes.
pub fn spawn(
    app_handle: tauri::AppHandle,
    node_path: String,
    hone_path: String,
    _relay_url: Option<String>,
) -> tauri::async_runtime::JoinHandle<()> {
    let state = Arc::new(Mutex::new(SchedulerState::default()));

    tauri::async_runtime::spawn(async move {
        let mut tick = interval(Duration::from_secs(30));

        // Give the app a moment to fully launch before the first check.
        tokio::time::sleep(Duration::from_secs(5)).await;

        loop {
            tick.tick().await;

            let schedules = match load_schedules(&app_handle) {
                Ok(s) => s,
                Err(e) => {
                    warn!("Scheduler: failed to load schedules: {}", e);
                    continue;
                }
            };

            let now = Utc::now();
            for sched in &schedules {
                if !sched.enabled {
                    continue;
                }
                if sched.cron.is_empty() {
                    continue;
                }

                // Determine if schedule should fire based on trigger type.
                // The frontend stores trigger-specific data in the `cron` field:
                //   - cron:     cron expression (e.g. "0 9 * * *")
                //   - interval: minutes as string (e.g. "30")
                //   - once:     datetime-local string (e.g. "2026-07-09T09:00")
                let trigger_matches = if sched.trigger == "cron" {
                    let expr = match CronExpr::parse(&sched.cron) {
                        Some(e) => e,
                        None => {
                            warn!(
                                "Scheduler: invalid cron '{}' for schedule {}",
                                sched.cron, sched.id
                            );
                            continue;
                        }
                    };
                    expr.matches(&now)
                } else if sched.trigger == "interval" {
                    let interval_min: i64 = match sched.cron.trim().parse() {
                        Ok(n) => n,
                        Err(_) => {
                            warn!(
                                "Scheduler: invalid interval '{}' for schedule {}",
                                sched.cron, sched.id
                            );
                            continue;
                        }
                    };
                    interval_min > 0 // actual timing check done in mutex below
                } else if sched.trigger == "once" {
                    let at = match chrono::NaiveDateTime::parse_from_str(
                        &sched.cron,
                        "%Y-%m-%dT%H:%M",
                    ) {
                        Ok(dt) => dt,
                        Err(_) => {
                            warn!(
                                "Scheduler: invalid once datetime '{}' for schedule {}",
                                sched.cron, sched.id
                            );
                            continue;
                        }
                    };
                    // datetime-local gives local time; compare with local now
                    Local::now().naive_local() >= at
                } else {
                    continue;
                };

                if !trigger_matches {
                    continue;
                }

                // Prevent double-fire / check interval timing
                {
                    // Use unwrap_or_else(into_inner) so a poisoned mutex doesn't
                    // kill the scheduler permanently — we'd rather keep firing
                    // tasks with possibly-stale last_fire data than silently
                    // stop all scheduled work.
                    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(last) = st.last_fire.get(&sched.id) {
                        if sched.trigger == "cron" {
                            let delta = (now - *last).num_seconds();
                            if delta < 60 {
                                continue; // already fired this minute
                            }
                        } else if sched.trigger == "interval" {
                            let interval_sec: i64 =
                                sched.cron.trim().parse::<i64>().unwrap_or(0) * 60;
                            let delta = (now - *last).num_seconds();
                            if delta < interval_sec {
                                continue;
                            }
                        } else if sched.trigger == "once" {
                            // Once schedules should never fire twice
                            continue;
                        }
                    }
                    st.last_fire.insert(sched.id.clone(), now);
                }

                info!(
                    "Scheduler: firing schedule '{}' ({}) — cron: {}",
                    sched.title, sched.id, sched.cron
                );

                // Execute the task
                let task = if !sched.desc.is_empty() {
                    sched.desc.clone()
                } else {
                    sched.title.clone()
                };

                let start = std::time::Instant::now();
                // Run the CLI execution with a 5-minute timeout. Because
                // execute_task uses tokio::process::Command with kill_on_drop,
                // a timeout actually kills the child process instead of
                // orphaning it on a leaked spawn_blocking thread.
                let result = match tokio::time::timeout(
                    Duration::from_secs(300),
                    execute_task(&node_path, &hone_path, &task),
                ).await {
                    Ok(r) => r,
                    Err(_) => Err("CLI task timed out (5 min)".into()),
                };
                let duration_ms = start.elapsed().as_millis() as u64;

                // Record the log entry
                {
                    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
                    let entry = ExecutionLog {
                        schedule_id: sched.id.clone(),
                        triggered_at: now.to_rfc3339(),
                        status: if result.is_ok() {
                            "success".into()
                        } else {
                            "fail".into()
                        },
                        output: result.clone().unwrap_or_else(|e| e),
                        duration_ms,
                    };
                    st.execution_log.push(entry);
                    if st.execution_log.len() > 200 {
                        st.execution_log.remove(0);
                    }
                }

                // Update schedule last_run / last_status / next_run on disk
                update_schedule_run(&app_handle, &sched.id, &now, result.is_ok());

                // Persist execution log
                if let Err(e) = save_execution_log(&app_handle, &state) {
                    warn!("Scheduler: failed to save execution log: {}", e);
                }
            }
        }
    })
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn schedules_path(app: &tauri::AppHandle) -> PathBuf {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    data_dir.join("schedules.json")
}

fn execution_log_path(app: &tauri::AppHandle) -> PathBuf {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    data_dir.join("execution_log.json")
}

fn load_schedules(app: &tauri::AppHandle) -> Result<Vec<ScheduleInfo>, String> {
    let path = schedules_path(app);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
    let schedules: Vec<ScheduleInfo> = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("Scheduler: schedules JSON parse failed ({}), backing up and resetting", e);
            let backup = path.with_extension(format!("json.corrupt-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()));
            let _ = std::fs::rename(&path, &backup);
            Vec::new()
        }
    };
    Ok(schedules)
}

/// Execute a task by calling the hone CLI.
///
/// Runs `node <hone_path>/dist/cli.js -p "<task>"` in non-interactive mode.
///
/// Uses `tokio::process::Command` with `kill_on_drop(true)` so that when the
/// caller drops the future (e.g. on timeout or app shutdown), the CLI child
/// process is killed instead of being orphaned and continuing to run in the
/// background after the desktop app exits.
async fn execute_task(node_path: &str, hone_path: &str, task: &str) -> Result<String, String> {
    let cli_js = format!("{}/dist/cli.js", hone_path);

    info!(
        "Scheduler: executing '{} {} -p \"{}\"'",
        node_path, cli_js, task
    );

    // Build a std::process::Command first so the existing
    // windows_git_bash / windows_proxy helpers (which take &mut
    // std::process::Command) can apply env/proxy settings.
    let mut std_cmd = StdCommand::new(node_path);
    std_cmd.arg(&cli_js).arg("-p").arg(task);
    windows_git_bash::apply_to_command(&mut std_cmd);
    windows_proxy::apply_to_command(&mut std_cmd);

    // Hide the console window on Windows — scheduler runs in the background
    // and should never pop up a cmd.exe window for each scheduled task.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut cmd = Command::from(std_cmd);
    // Critical: kill the child if this future is dropped (timeout / app exit).
    cmd.kill_on_drop(true);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to spawn CLI: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        let combined = if stdout.is_empty() {
            "Task completed (no output).".into()
        } else {
            stdout.trim().to_string()
        };
        Ok(combined)
    } else {
        let err_msg = if stderr.is_empty() {
            format!("CLI exited with status: {}", output.status)
        } else {
            stderr.trim().to_string()
        };
        Err(err_msg)
    }
}

fn update_schedule_run(
    app: &tauri::AppHandle,
    schedule_id: &str,
    fired_at: &DateTime<Utc>,
    success: bool,
) {
    let path = schedules_path(app);
    if !path.exists() {
        return;
    }

    let data = match std::fs::read_to_string(&path) {
        Ok(d) => d,
        Err(e) => {
            warn!("Scheduler: failed to read schedules for update: {}", e);
            return;
        }
    };

    let mut schedules: Vec<ScheduleInfo> = match serde_json::from_str(&data) {
        Ok(s) => s,
        Err(e) => {
            warn!("Scheduler: failed to parse schedules: {}", e);
            return;
        }
    };

    for s in &mut schedules {
        if s.id == schedule_id {
            s.last_run = Some(fired_at.to_rfc3339());
            s.last_status = Some(if success {
                "success".into()
            } else {
                "fail".into()
            });

            // Compute next run by advancing 1 minute past the current fire
            // (simplistic — a production scheduler would compute the next
            //  matching cron time, but this avoids double-fires).
            let next = *fired_at + chrono::Duration::minutes(1);
            s.next_run = next.to_rfc3339();
            break;
        }
    }

    // Serialize; on failure abort the write so we don't truncate the file
    // with an empty string (which would silently wipe all schedules).
    let json = match serde_json::to_string_pretty(&schedules) {
        Ok(j) => j,
        Err(e) => {
            warn!("Scheduler: failed to serialize schedules: {}", e);
            return;
        }
    };
    // Atomic write: tmp + rename, so a crash mid-write can't corrupt the file.
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, &json) {
        warn!("Scheduler: failed to write schedules tmp file: {}", e);
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        warn!("Scheduler: failed to rename schedules tmp file: {}", e);
        let _ = std::fs::remove_file(&tmp);
    }
}

fn save_execution_log(
    app: &tauri::AppHandle,
    state: &Arc<Mutex<SchedulerState>>,
) -> Result<(), String> {
    let path = execution_log_path(app);
    let st = state.lock().map_err(|e| format!("lock error: {}", e))?;
    let json = serde_json::to_string_pretty(&st.execution_log)
        .map_err(|e| format!("serialize error: {}", e))?;
    // Atomic write: tmp + rename, so a crash mid-write can't corrupt the file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("write error: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename error: {}", e)
    })?;
    Ok(())
}
