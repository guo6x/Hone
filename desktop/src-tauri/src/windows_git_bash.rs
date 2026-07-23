use std::process::Command;

#[cfg(windows)]
use std::path::{Path, PathBuf};

pub fn apply_to_command(cmd: &mut Command) {
    apply_to_command_impl(cmd);
}

#[cfg(windows)]
fn apply_to_command_impl(cmd: &mut Command) {
    // 优先使用 hone 自己的 env var，向后兼容旧的 CLAUDE_CODE_GIT_BASH_PATH
    // （claude-code 项目残留品牌，但 CLI 侧仍读取，保留兼容避免破坏既有用户配置）
    let existing = std::env::var_os("HONE_GIT_BASH_PATH")
        .or_else(|| std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH"));
    if let Some(existing) = existing {
        let existing = PathBuf::from(existing);
        if existing.is_file() {
            return;
        }
    }

    if let Some(path) = find_git_bash_path() {
        // 同时设置两个 env var，确保 CLI（仍读 CLAUDE_CODE_*）和未来 hone 版本都能用
        // 使用 &path 引用避免 PathBuf move：Command::env 接受 AsRef<OsStr>，&PathBuf 满足约束
        cmd.env("HONE_GIT_BASH_PATH", &path);
        cmd.env("CLAUDE_CODE_GIT_BASH_PATH", &path);
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

    // 收集可信目录前缀（Program Files / Program Files (x86) / LOCALAPPDATA\Programs）。
    // where.exe 会返回 PATH 中所有 git.exe，包括用户当前目录或恶意注入 PATH 上的假 git。
    // 只接受位于可信系统安装目录下的 git，防止 PATH 劫持拿到一个伪造的 bash.exe 路径。
    let trusted_roots = trusted_git_directories();
    if trusted_roots.is_empty() {
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

        // 校验 git_path 是否位于可信目录下（canonicalize 后比较，避免 ../ 等绕过）
        let canon = match git_path.canonicalize() {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !trusted_roots.iter().any(|root| {
            let root_canon = match root.canonicalize() {
                Ok(rc) => rc,
                Err(_) => return false,
            };
            canon.starts_with(&root_canon)
        }) {
            // 不在可信目录下：可能是 PATH 劫持的伪造 git，跳过
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

/// 返回可信的 Git 安装目录前缀（Program Files\Git、Program Files (x86)\Git、
/// LOCALAPPDATA\Programs\Git）。where.exe 返回的 git 路径必须位于这些目录下
/// 才会被采纳，防止 PATH 劫持。
#[cfg(windows)]
fn trusted_git_directories() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("Git"));
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files_x86).join("Git"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local_app_data).join("Programs").join("Git"));
    }
    roots
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
