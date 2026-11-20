// Routes: signup, one sync endpoint, health, and the bundled UI. No admin surface on purpose.
use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::limits::Limiter;
use crate::store::{NewOp, Store};

pub struct Config {
    pub cap_bytes: i64,
    pub pull_limit: usize,
    pub max_op_bytes: usize,
    pub max_request_bytes: usize,
    pub sync_burst: f64,
    pub sync_per_min: f64,
    pub signup_per_min: f64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            cap_bytes: 500 * 1024 * 1024,
            pull_limit: 500,
            max_op_bytes: 4 * 1024 * 1024,
            max_request_bytes: 16 * 1024 * 1024,
            sync_burst: 10.0,
            sync_per_min: 30.0,
            signup_per_min: 1.0,
        }
    }
}

pub struct AppState {
    pub store: Store,
    pub cfg: Config,
    sync: Limiter,
    signup: Limiter,
}

impl AppState {
    pub fn new(store: Store, cfg: Config) -> Self {
        let sync = Limiter::new(cfg.sync_burst, cfg.sync_per_min);
        let signup = Limiter::new(1.0, cfg.signup_per_min);
        Self { store, cfg, sync, signup }
    }
}

pub fn router(state: Arc<AppState>, ui_dir: Option<PathBuf>) -> Router {
    let api = Router::new().route("/signup", post(signup)).route("/sync", post(sync));
    let mut app = Router::new().route("/healthz", get(|| async { "ok" })).nest("/api", api);
    if let Some(dir) = ui_dir {
        // SPA fallback: a deep link like /note/<id> must serve the shell, not a 404.
        let index = dir.join("index.html");
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }
    let isolation = [
        ("cross-origin-opener-policy", "same-origin"),
        ("cross-origin-embedder-policy", "require-corp"),
        ("cross-origin-resource-policy", "same-origin"),
    ];
    let limit = state.cfg.max_request_bytes;
    let mut app = app.with_state(state).layer(DefaultBodyLimit::max(limit));
    for (name, value) in isolation {
        app = app.layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static(name),
            HeaderValue::from_static(value),
        ));
    }
    app
}

// ---------------------------------------------------------------- accounts

#[derive(Serialize)]
struct SignupResponse {
    token: String,
}

async fn signup(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<SignupResponse>, ApiError> {
    if let Err(wait) = state.signup.check(&client_ip(&headers)) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited").retry_after(wait));
    }
    let token = state.store.signup()?;
    Ok(Json(SignupResponse { token }))
}

// ---------------------------------------------------------------- sync

#[derive(Deserialize)]
struct SyncRequest {
    #[serde(default)]
    cursor: i64,
    #[serde(default)]
    ops: Vec<WireOp>,
}

#[derive(Deserialize)]
struct WireOp {
    /// Random op id from the client; the server only uses it to ignore duplicates.
    id: String,
    device: String,
    kind: String,
    note_id: String,
    created: i64,
    /// JSON → gzip → AES-GCM, base64 for the wire: the server never looks inside.
    ciphertext: String,
}

#[derive(Serialize)]
struct SyncResponse {
    ops: Vec<PulledOp>,
    cursor: i64,
    more: bool,
    usage_bytes: i64,
    cap_bytes: i64,
}

#[derive(Serialize)]
struct PulledOp {
    server_seq: i64,
    id: String,
    device: String,
    kind: String,
    note_id: String,
    created: i64,
    ciphertext: String,
}

async fn sync(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, ApiError> {
    let token = bearer(&headers)?;
    if let Err(wait) = state.sync.check(&token) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited").retry_after(wait));
    }
    let owner = state.store.owner_for(&token)?.ok_or_else(|| ApiError::unauthorized())?;

    let mut incoming = Vec::with_capacity(request.ops.len());
    let mut payloads: Vec<Bytes> = Vec::with_capacity(request.ops.len());
    for op in &request.ops {
        check_label("id", &op.id, 64)?;
        check_label("device", &op.device, 64)?;
        check_label("note_id", &op.note_id, 64)?;
        check_label("kind", &op.kind, 32)?;
        if op.created <= 0 {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad_op"));
        }
        let payload = B64.decode(&op.ciphertext).map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "bad_op"))?;
        // 12-byte nonce plus a 16-byte GCM tag is the smallest payload that can be real.
        if payload.len() < 28 || payload.len() > state.cfg.max_op_bytes {
            return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "op_too_large"));
        }
        payloads.push(Bytes::from(payload));
    }
    for (op, payload) in request.ops.iter().zip(&payloads) {
        incoming.push(NewOp {
            id: &op.id,
            device: &op.device,
            kind: &op.kind,
            note_id: &op.note_id,
            created: op.created,
            ciphertext: payload,
        });
    }

    let pushed = state.store.push(&owner, &incoming, state.cfg.cap_bytes)?;

    // Pull what the client is missing. Always allowed, even over the cap: a full account must be
    // able to rescue its data.
    let limit = state.cfg.pull_limit;
    // Do not hand back what this very request just wrote.
    let floor = request.cursor.max(0).max(pushed.written);
    let mut ops = state.store.pull(&owner, floor, limit + 1)?;
    let more = ops.len() > limit;
    ops.truncate(limit);
    let cursor = ops.last().map(|op| op.server_seq).unwrap_or(floor);
    let usage = state.store.usage(&owner)?;

    let response = SyncResponse {
        ops: ops
            .into_iter()
            .map(|op| PulledOp {
                server_seq: op.server_seq,
                id: op.id,
                device: op.device,
                kind: op.kind,
                note_id: op.note_id,
                created: op.created,
                ciphertext: B64.encode(op.ciphertext),
            })
            .collect(),
        cursor,
        more,
        usage_bytes: usage,
        cap_bytes: state.cfg.cap_bytes,
    };
    if pushed.cap_reached {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "storage_cap"));
    }
    Ok(Json(response))
}

fn check_label(field: &'static str, value: &str, max: usize) -> Result<(), ApiError> {
    if value.is_empty() || value.len() > max || value.chars().any(|c| c.is_control()) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, field));
    }
    Ok(())
}

fn bearer(headers: &HeaderMap) -> Result<String, ApiError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned)
        .ok_or_else(ApiError::unauthorized)
}

/// Rate limiting key. The service is published on loopback behind Caddy, which sets the header, so
/// nothing off-host can forge it.
fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "direct".to_owned())
}

// ---------------------------------------------------------------- errors

/// Boring on purpose: a status and a machine-readable code, never a detail an attacker can use.
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    retry_after: Option<u64>,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code, retry_after: None }
    }

    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized")
    }

    fn retry_after(mut self, seconds: u64) -> Self {
        self.retry_after = Some(seconds.max(1));
        self
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(err: rusqlite::Error) -> Self {
        eprintln!("storage error: {err}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "storage")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.status, Json(json!({ "error": self.code }))).into_response();
        if let Some(seconds) = self.retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(seconds as u32));
        }
        response
    }
}
