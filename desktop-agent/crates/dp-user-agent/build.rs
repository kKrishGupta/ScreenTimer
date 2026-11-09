use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:rerun-if-changed=../../../.git/HEAD");
    let git_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.git");
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok();
    let revision = head
        .as_deref()
        .and_then(|value| value.trim().strip_prefix("ref: "))
        .and_then(|reference| {
            println!("cargo:rerun-if-changed=../../../.git/{reference}");
            std::fs::read_to_string(git_dir.join(reference)).ok()
        })
        .or(head)
        .map(|value| value.trim().to_owned())
        .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .unwrap_or_else(|| "unavailable".into());
    let timestamp = std::env::var("SOURCE_DATE_EPOCH").unwrap_or_else(|_| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string()
    });
    println!("cargo:rustc-env=DP_BUILD_REVISION={revision}");
    println!("cargo:rustc-env=DP_BUILD_TIMESTAMP_EPOCH={timestamp}");
    println!(
        "cargo:rustc-env=DP_BUILD_PROFILE={}",
        std::env::var("PROFILE").unwrap_or_else(|_| "unknown".into())
    );
    println!(
        "cargo:rustc-env=DP_BUILD_TARGET={}",
        std::env::var("TARGET").unwrap_or_else(|_| "unknown".into())
    );
}
