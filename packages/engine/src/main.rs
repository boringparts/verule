use std::{env, ffi::OsStr, process::ExitCode};

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    if args.next().as_deref() == Some(OsStr::new("--version")) && args.next().is_none() {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    eprintln!("Usage: verule-engine --version");
    ExitCode::from(2)
}
