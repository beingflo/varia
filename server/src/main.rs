use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use varia::{AppState, Config, Store, router};

#[tokio::main]
async fn main() {
    let addr: SocketAddr = std::env::var("VARIA_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into()).parse().expect("VARIA_ADDR");
    let db = std::env::var("VARIA_DB").unwrap_or_else(|_| "/data/varia.sqlite".into());
    let ui = std::env::var("VARIA_UI_DIR").ok().map(PathBuf::from);

    let store = Store::open(&db).expect("cannot open the database");
    let state = Arc::new(AppState::new(store, Config::default()));
    let app = router(state, ui);

    let listener = tokio::net::TcpListener::bind(addr).await.expect("cannot bind");
    eprintln!("varia listening on {addr}");
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    axum::serve(listener, app).with_graceful_shutdown(shutdown).await.expect("server failed");
}
