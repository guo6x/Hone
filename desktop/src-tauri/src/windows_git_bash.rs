use std::process::Command;

#[cfg(windows)]
use std::path::{Path, PathBuf};

pub fn apply_to_command(cmd: &mut Command) {
    apply_to_command_impl(cmd);
}

#[cfg(windows)]
fn apply_to_command_impl(cmd: &mut Command) {
    if let Some(existing) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH") {
        let existing = PathBuf::from(existing);
        if existing.is_file() {
            return;
        }
    }

    if let Some(path) = find_git_bash_path() {
        cmd.env("CLAUDE_CODE_GIT_BASH_PATH", path);
    }
}

#[cfg(not(windows))]
fn apply_to_command_impl(_cmd: &mut Command) {}

#[cfg(windows)]
fn find_git_bash_path() -> Option<PathBuf> {
    for path in common_git_bash_paths() {
        if path.is_file() {
            return Some(path);
        }
    }

    find_git_bash_from_git()
}

#[cfg(windows)]
fn common_git_bash_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        paths.push(
            PathBuf::from(program_files)
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        paths.push(
            PathBuf::from(program_files_x86)
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        paths.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }

    paths
}

#[cfg(windows)]
fn find_git_bash_from_git() -> Option<PathBuf> {
    let mut cmd = Command::new("where.exe");
    cmd.arg("git");
    // Hide console window — this runs on every gateway/CLI spawn path.
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let git_path = PathBuf::from(line);
        if is_current_dir_candidate(&git_path) {
            continue;
        }

        let Some(git_root) = git_path.parent().and_then(|parent| parent.parent()) else {
            continue;
        };
        let bash_path = git_root.join("bin").join("bash.exe");
        if bash_path.is_file() {
            return Some(bash_path);
        }
    }

    None
}

#[cfg(windows)]
fn is_current_dir_candidate(path: &Path) -> bool {
    let Ok(cwd) = std::env::current_dir() else {
        return false;
    };
    let Ok(candidate) = path.canonicalize() else {
        return false;
    };
    let cwd = cwd.canonicalize().unwrap_or(cwd);

    candidate == cwd || candidate.starts_with(cwd)
}
