use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use varia::{AppState, BackupOptions, Config, Store, router};

#[tokio::main]
async fn main() {
    // Loopback unless exposure is asked for in so many words: plaintext HTTP plus a trusted
    // X-Forwarded-For are only safe behind the reverse proxy on the host.
    let addr: SocketAddr =
        std::env::var("VARIA_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into()).parse().expect("VARIA_ADDR");
    let db = std::env::var("VARIA_DB").unwrap_or_else(|_| "/data/varia.sqlite".into());
    let ui = std::env::var("VARIA_UI_DIR").ok().map(PathBuf::from);

    // Read before anything is served, so a backup misconfiguration fails the start rather than
    // quietly running with no archive. The identity that reads it back is not on this host.
    let backup = BackupOptions::from_env().expect("invalid backup configuration");

    // `varia restore [--force]`: decrypt the newest archive object into VARIA_DB. Run with the
    // service stopped; a restore is not a hot operation.
    if std::env::args().nth(1).as_deref() == Some("restore") {
        let force = std::env::args().any(|arg| arg == "--force");
        if let Err(err) = varia::restore(&PathBuf::from(&db), &backup, force).await {
            eprintln!("restore failed: {err}");
            std::process::exit(1);
        }
        return;
    }

    let store = Store::open(&db).expect("cannot open the database");
    let state = Arc::new(AppState::new(store, Config::default()));
    let app = router(state, ui);

    if backup.enabled {
        tokio::spawn(varia::run(PathBuf::from(&db), backup));
    }

    let listener = tokio::net::TcpListener::bind(addr).await.expect("cannot bind");
    eprintln!("varia listening on {addr}");
    // Ctrl-C in dev, SIGTERM from `systemctl stop`: both stop accepting requests and let the
    // Store drop, which checkpoints the WAL on close. Without the SIGTERM arm the process is
    // killed by default action, exit 143, and systemd marks the unit failed on every stop.
    let shutdown = async {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("cannot install the SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    };
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await.expect("server failed");
}
