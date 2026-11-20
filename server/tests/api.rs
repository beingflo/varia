// The interesting logic is the log, not the HTML: cursors, duplicate pushes, the cap, the limits.
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use varia::{AppState, Config, Store, router};

fn app_with(cfg: Config) -> Router {
    let state = Arc::new(AppState::new(Store::open_in_memory().unwrap(), cfg));
    router(state, None)
}

fn app() -> Router {
    app_with(Config::default())
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
    (status, headers, body)
}

async fn signup(app: &Router, ip: &str) -> String {
    let request = Request::post("/api/signup")
        .header("x-forwarded-for", ip)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let (status, _, body) = send(app, request).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["token"].as_str().unwrap().to_owned()
}

fn op(seq: i64, payload: &[u8]) -> Value {
    json!({
        "id": format!("op-{seq}"),
        "device": "device-a",
        "kind": "note_body",
        "note_id": "note-1",
        "created": 1_700_000_000 + seq,
        "ciphertext": B64.encode(payload),
    })
}

fn sync_request(token: &str, cursor: i64, ops: Vec<Value>) -> Request<Body> {
    Request::post("/api/sync")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "device": "device-a", "cursor": cursor, "ops": ops }).to_string()))
        .unwrap()
}

/// 28 bytes is the smallest real payload: 12-byte nonce plus a 16-byte tag.
fn payload(tag: u8) -> Vec<u8> {
    vec![tag; 28]
}

#[tokio::test]
async fn healthz_is_open() {
    let request = Request::get("/healthz").body(Body::empty()).unwrap();
    let (status, _, _) = send(&app(), request).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn signup_is_rate_limited_per_ip() {
    let app = app();
    signup(&app, "10.0.0.1").await;

    let again = Request::post("/api/signup")
        .header("x-forwarded-for", "10.0.0.1")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let (status, headers, _) = send(&app, again).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(headers.get(header::RETRY_AFTER).unwrap(), "60");

    signup(&app, "10.0.0.2").await; // a different ip is a different bucket
}

#[tokio::test]
async fn rejects_a_missing_or_wrong_token() {
    let app = app();
    let without = Request::post("/api/sync")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "cursor": 0, "ops": [] }).to_string()))
        .unwrap();
    let (status, _, _) = send(&app, without).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, _) = send(&app, sync_request("nonsense", 0, vec![])).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn pushes_are_ordered_and_pulled_once_per_cursor() {
    let app = app();
    let token = signup(&app, "10.0.0.1").await;

    // A push does not hand its own ops back: the client already has them.
    let (status, _, body) = send(&app, sync_request(&token, 0, vec![op(0, &payload(1)), op(1, &payload(2))])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["cursor"], 2);
    assert_eq!(body["ops"].as_array().unwrap().len(), 0);
    assert_eq!(body["more"], false);

    // Another request pulls them in server order.
    let (status, _, body) = send(&app, sync_request(&token, 0, vec![])).await;
    assert_eq!(status, StatusCode::OK);
    let ops = body["ops"].as_array().unwrap();
    assert_eq!(ops.len(), 2);
    assert_eq!(ops[0]["server_seq"], 1);
    assert_eq!(ops[0]["id"], "op-0");
    assert_eq!(ops[1]["server_seq"], 2);

    // Cursored: nothing new, and the cursor stays put.
    let (_, _, body) = send(&app, sync_request(&token, 2, vec![])).await;
    assert_eq!(body["ops"].as_array().unwrap().len(), 0);
    assert_eq!(body["cursor"], 2);
}

#[tokio::test]
async fn a_push_from_behind_still_gets_the_ops_in_between() {
    let app = app();
    let token = signup(&app, "10.0.0.1").await;

    // Device A pushes two ops; device B has never pulled and now pushes one of its own.
    send(&app, sync_request(&token, 0, vec![op(0, &payload(1)), op(1, &payload(2))])).await;
    let (_, _, body) = send(&app, sync_request(&token, 0, vec![op(2, &payload(3))])).await;

    let ids: Vec<&str> = body["ops"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"op-0"), "ops below this device's own push must come back: {ids:?}");
    assert!(ids.contains(&"op-1"), "ops below this device's own push must come back: {ids:?}");
    assert!(body["cursor"].as_i64().unwrap() >= 3);
}

#[tokio::test]
async fn a_retried_push_is_ignored() {
    let app = app();
    let token = signup(&app, "10.0.0.1").await;

    send(&app, sync_request(&token, 0, vec![op(0, &payload(1))])).await;
    let (status, _, _) = send(&app, sync_request(&token, 0, vec![op(0, &payload(1))])).await;
    assert_eq!(status, StatusCode::OK);

    let (_, _, body) = send(&app, sync_request(&token, 0, vec![])).await;
    assert_eq!(body["ops"].as_array().unwrap().len(), 1, "the duplicate must not add a row");
    assert_eq!(body["usage_bytes"], 28);
}

#[tokio::test]
async fn pull_reports_the_head_so_a_client_can_notice_a_lost_log() {
    let app = app();
    let token = signup(&app, "10.0.0.1").await;
    let (_, _, body) = send(&app, sync_request(&token, 0, vec![])).await;
    assert_eq!(body["head"], 0);

    send(&app, sync_request(&token, 0, vec![op(0, &payload(1)), op(1, &payload(2))])).await;
    let (_, _, body) = send(&app, sync_request(&token, 0, vec![])).await;
    assert_eq!(body["head"], 2);

    // A full pull does not move the head: the head is the log, not the page.
    let (_, _, body) = send(&app, sync_request(&token, 2, vec![])).await;
    assert_eq!(body["head"], 2);
    assert_eq!(body["ops"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn identity_is_the_op_id_and_never_the_device() {
    let app = app();
    let token = signup(&app, "10.0.0.1").await;

    // Two ops from the same device with different ids: both stored. A counter used to be the
    // identity, so a token holder could squat a device's next sequence number and swallow its op.
    let (status, _, _) = send(&app, sync_request(&token, 0, vec![op(0, &payload(1)), op(1, &payload(2))])).await;
    assert_eq!(status, StatusCode::OK);

    // The same id under a different device is a duplicate too: identity is the id alone.
    let mut copy = op(0, &payload(9));
    copy["device"] = json!("device-b");
    send(&app, sync_request(&token, 0, vec![copy])).await;

    let (_, _, body) = send(&app, sync_request(&token, 0, vec![])).await;
    let ops = body["ops"].as_array().unwrap();
    assert_eq!(ops.len(), 2);
    assert_eq!(ops[0]["id"], "op-0");
    assert_eq!(ops[1]["id"], "op-1");
}

#[tokio::test]
async fn pull_reports_more_and_pages_by_cursor() {
    let app = app_with(Config { pull_limit: 2, ..Config::default() });
    let token = signup(&app, "10.0.0.1").await;
    let ops: Vec<Value> = (0..3).map(|seq| op(seq, &payload(seq as u8))).collect();
    send(&app, sync_request(&token, 0, ops)).await;

    let (_, _, first) = send(&app, sync_request(&token, 0, vec![])).await;
    assert_eq!(first["ops"].as_array().unwrap().len(), 2);
    assert_eq!(first["more"], true);
    assert_eq!(first["cursor"], 2);

    let (_, _, second) = send(&app, sync_request(&token, 2, vec![])).await;
    assert_eq!(second["ops"].as_array().unwrap().len(), 1);
    assert_eq!(second["more"], false);
    assert_eq!(second["cursor"], 3);
}

#[tokio::test]
async fn a_full_account_accepts_a_prefix_and_still_pulls() {
    let app = app_with(Config { cap_bytes: 40, ..Config::default() }); // room for one 28-byte op
    let token = signup(&app, "10.0.0.1").await;

    // The op that fits is kept, the one that does not stays with the client: no error, and the
    // response says exactly how much of the push the account took.
    let (status, _, body) = send(&app, sync_request(&token, 0, vec![op(0, &payload(1)), op(1, &payload(2))])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["accepted"], 1);

    // A retried op counts as accepted even though the account is full, so the client can mark
    // the duplicate as pushed and stop re-sending it.
    let (status, _, body) = send(&app, sync_request(&token, 1, vec![op(0, &payload(1))])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["accepted"], 1);

    // A full account always pulls: a device with pending writes must never be split off.
    let (status, _, body) = send(&app, sync_request(&token, 0, vec![])).await;
    assert_eq!(status, StatusCode::OK, "a full account can still pull");
    assert_eq!(body["ops"].as_array().unwrap().len(), 1);
    assert_eq!(body["usage_bytes"], 28);
}

#[tokio::test]
async fn sync_is_rate_limited_per_token() {
    let app = app_with(Config { sync_burst: 2.0, sync_per_min: 0.0, ..Config::default() });
    let token = signup(&app, "10.0.0.1").await;

    for _ in 0..2 {
        let (status, _, _) = send(&app, sync_request(&token, 0, vec![])).await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, headers, body) = send(&app, sync_request(&token, 0, vec![])).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(headers.contains_key(header::RETRY_AFTER));
    assert_eq!(body["error"], "rate_limited");
}

#[tokio::test]
async fn validates_the_envelope_before_storing_anything() {
    let app = app_with(Config { max_op_bytes: 40, ..Config::default() });
    let token = signup(&app, "10.0.0.1").await;

    let mut broken = op(0, &payload(1));
    broken["ciphertext"] = json!("not base64!!");
    let (status, _, body) = send(&app, sync_request(&token, 0, vec![broken])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "bad_op");

    let mut empty = op(0, &payload(1));
    empty["device"] = json!("");
    let (status, _, body) = send(&app, sync_request(&token, 0, vec![empty])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "device");

    let (status, _, body) = send(&app, sync_request(&token, 0, vec![op(0, &vec![7u8; 64])])).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"], "op_too_large");

    // Nothing was written by any of it.
    let (_, _, body) = send(&app, sync_request(&token, 0, vec![])).await;
    assert_eq!(body["usage_bytes"], 0);
}

#[tokio::test]
async fn serves_the_ui_with_the_isolation_headers_and_an_spa_fallback() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<!doctype html><title>varia</title>").unwrap();
    let state = Arc::new(AppState::new(Store::open_in_memory().unwrap(), Config::default()));
    let app = router(state, Some(dir.path().to_path_buf()));

    for path in ["/", "/note/abc"] {
        let request = Request::get(path).body(Body::empty()).unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["cross-origin-opener-policy"], "same-origin");
        assert_eq!(response.headers()["cross-origin-embedder-policy"], "require-corp");
        assert_eq!(response.headers()["cross-origin-resource-policy"], "same-origin");
    }
}
