//! Daily S3 backup of the whole SQLite database, plus restore.
//!
//! The server's state is one SQLite file, so a backup is a consistent copy of
//! that file. `VACUUM INTO` produces it: one statement, a standalone database
//! with no WAL sidecar, taken from a second connection so the live sync path is
//! never blocked.
//!
//! The archive is encrypted to an age recipient before it leaves the host, so
//! the bucket holds ciphertext even though the op bodies already are: the
//! snapshot still carries every account's token hash and the plaintext op
//! envelope (device, note id, kind, time, size). The recipient is a public key
//! kept in the configuration; the matching identity is nowhere on the server, so
//! only a machine that can unlock the vault can read the archive back (see
//! `restore`).
//!
//! Objects rotate through a fixed ring of slots. Each pass fills the first empty
//! slot, or overwrites the oldest object once the ring is full, so the bucket
//! keeps the last `slots` successful passes and nothing has to be deleted. `PUT`
//! is atomic, so the ring is not there to survive a torn upload: it is there so a
//! pass that uploads a complete but unusable snapshot — or a corruption noticed a
//! day later — still leaves an intact earlier copy.
//!
//! A restore only recovers the log to the newest object plus whatever a
//! surviving device re-pushes (`design/003`: a server head below the cursor makes
//! the client rewind and re-push). Data that lived only on the lost server since
//! the last pass — an account created entirely within that window — has no other
//! copy and is gone.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use age::x25519;
use futures::StreamExt;
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, PutPayload};

/// Suffix every uploaded object carries, so the bucket says by itself that an
/// object is ciphertext and restore never has to guess.
const SUFFIX: &str = ".age";

/// Where the snapshot lands before it is encrypted and uploaded. Same volume as
/// the database, so a large copy is not a surprise, and removed after every pass.
const SNAPSHOT: &str = ".backup-snapshot.sqlite";

/// Daily archive configuration. Credentials are read from the standard
/// `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` variables and are deliberately
/// not stored here, so this struct is safe to log.
#[derive(Clone, Debug)]
pub struct BackupOptions {
    pub enabled: bool,
    pub bucket: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub prefix: String,
    /// UTC hour and minute of the daily pass.
    pub hour: u32,
    pub minute: u32,
    /// How many objects the ring keeps before it starts overwriting the oldest.
    pub slots: u32,
    pub allow_http: bool,
    /// The age recipient every object is encrypted to. A public key: it can only
    /// encrypt, so it is logged with the rest of the target. The matching identity
    /// is not on the server at all, and is read only by `restore`.
    pub recipient: Option<x25519::Recipient>,
}

impl BackupOptions {
    pub fn from_env() -> Result<Self, String> {
        let enabled = env_bool("VARIA_BACKUP", false)?;
        let bucket = env_str("VARIA_S3_BUCKET", "");
        let allow_http = env_bool("VARIA_S3_ALLOW_HTTP", false)?;
        let endpoint = env_option("VARIA_S3_ENDPOINT")
            .map(|value| s3_endpoint(&value, allow_http))
            .transpose()?;
        // A Backblaze endpoint names its own region (`s3.<region>.backblazeb2.com`),
        // so bucket plus endpoint is enough there. Any other provider sets the
        // region explicitly, or gets the AWS default.
        let region = match env_str("VARIA_S3_REGION", "") {
            region if !region.is_empty() => region,
            _ => endpoint
                .as_deref()
                .and_then(region_from_endpoint)
                .unwrap_or_else(|| "us-east-1".to_string()),
        };
        let prefix = env_str("VARIA_S3_PREFIX", "");
        let hour = env_parse("VARIA_BACKUP_HOUR", 3u32)?;
        let minute = env_parse("VARIA_BACKUP_MINUTE", 30u32)?;
        let slots = env_parse("VARIA_BACKUP_SLOTS", 7u32)?;

        // The heartbeat URL is a credential (whoever holds it can fake a ping),
        // so it is read by the loop itself where it is used, never carried here.
        if let Some(url) = env_option("VARIA_BACKUP_PING_URL")
            && !(url.starts_with("https://") || url.starts_with("http://"))
        {
            return Err("VARIA_BACKUP_PING_URL must be a full http(s) URL".into());
        }

        if hour > 23 {
            return Err("VARIA_BACKUP_HOUR must be between 0 and 23".into());
        }
        if minute > 59 {
            return Err("VARIA_BACKUP_MINUTE must be between 0 and 59".into());
        }
        if slots == 0 {
            return Err("VARIA_BACKUP_SLOTS must be at least 1".into());
        }

        // The archive is never plaintext, so an enabled backup without a usable
        // recipient is a startup error: a typo must fail the deploy, not quietly
        // produce an archive that nobody can open.
        let recipient = if enabled {
            let value = env_option("VARIA_BACKUP_AGE_RECIPIENT")
                .ok_or("VARIA_BACKUP is on but VARIA_BACKUP_AGE_RECIPIENT is empty")?;
            Some(value.parse().map_err(|e| format!("VARIA_BACKUP_AGE_RECIPIENT: {e}"))?)
        } else {
            None
        };

        if enabled {
            if bucket.is_empty() {
                return Err("VARIA_BACKUP is on but VARIA_S3_BUCKET is empty".into());
            }
            for key in ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] {
                if std::env::var(key).is_err() {
                    return Err(format!("VARIA_BACKUP is on but {key} is not set"));
                }
            }
        }

        Ok(Self {
            enabled,
            bucket,
            region,
            endpoint,
            prefix,
            hour,
            minute,
            slots,
            allow_http,
            recipient,
        })
    }
}

/// Run one pass at startup, then one per day at `hour:minute` UTC.
///
/// A pass that cannot build its client fails like any other and is retried the
/// next day, rather than ending the loop: a backup that stopped for the life of
/// the process would leave everything else looking healthy.
pub async fn run(db_path: PathBuf, opts: BackupOptions) {
    loop {
        let started = Instant::now();
        let result = pass(&db_path, &opts).await;
        let elapsed = started.elapsed();
        match &result {
            Ok(()) => eprintln!(
                "backup: uploaded in {} ms",
                elapsed.as_millis() as u64
            ),
            Err(err) => eprintln!("backup failed: {err}"),
        }
        if result.is_ok() {
            heartbeat().await;
        }
        let wait = until_next_run(opts.hour, opts.minute);
        eprintln!("backup: next pass in {} s", wait.as_secs());
        tokio::time::sleep(wait).await;
    }
}

/// Build a client and run one pass. The client is built per pass — it costs no
/// request — so a provider change takes effect without a restart.
async fn pass(db_path: &Path, opts: &BackupOptions) -> Result<(), String> {
    let store = client(opts)?;
    run_once(&store, db_path, opts).await
}

fn client(opts: &BackupOptions) -> Result<AmazonS3, String> {
    let key = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID is not set".to_string())?;
    let secret = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY is not set".to_string())?;

    // Logged once so a deploy can be checked against the provider's console. The
    // recipient is public, so it is logged in full; a wrong key has no other
    // symptom before a restore is attempted.
    static ANNOUNCED: std::sync::Once = std::sync::Once::new();
    ANNOUNCED.call_once(|| {
        eprintln!(
            "backup target: bucket={} region={} endpoint={} prefix={} recipient={}",
            opts.bucket,
            opts.region,
            opts.endpoint.as_deref().unwrap_or("aws"),
            opts.prefix,
            opts.recipient.as_ref().map_or_else(|| "none".to_string(), ToString::to_string),
        );
    });

    let mut builder = AmazonS3Builder::new()
        .with_bucket_name(&opts.bucket)
        .with_region(&opts.region)
        .with_access_key_id(key)
        .with_secret_access_key(secret)
        .with_allow_http(opts.allow_http);
    if let Some(endpoint) = &opts.endpoint {
        builder = builder.with_endpoint(endpoint);
    }
    builder.build().map_err(|e| format!("s3 client: {e}"))
}

async fn run_once(store: &dyn ObjectStore, db_path: &Path, opts: &BackupOptions) -> Result<(), String> {
    // The bucket is listed on every pass, even one with nothing new: it is the
    // only step that talks to the provider, and it is what picks the slot.
    let mut existing: Vec<(u32, i64)> = Vec::new();
    let mut listing = store.list(prefix(opts).as_ref());
    while let Some(item) = listing.next().await {
        let meta = item.map_err(|e| format!("list: {e}"))?;
        if let Some(slot) = meta.location.filename().and_then(slot_of) {
            existing.push((slot, meta.last_modified.timestamp_millis()));
        }
    }
    let slot = choose_slot(opts.slots, &existing);
    let key = slot_key(opts, slot);

    let snapshot = snapshot_path(db_path);
    let result = upload(store, db_path, &snapshot, opts, &key).await;
    // Whatever happened, the plaintext snapshot does not stay on disk.
    let _ = tokio::fs::remove_file(&snapshot).await;
    result
}

async fn upload(
    store: &dyn ObjectStore,
    db_path: &Path,
    snapshot: &Path,
    opts: &BackupOptions,
    key: &ObjectPath,
) -> Result<(), String> {
    snapshot_db(db_path, snapshot).await?;
    // shortcut: the whole snapshot is held in memory for age and for the PUT;
    // move to age's streaming writer and put_multipart when the database reaches
    // a few hundred MB.
    let bytes = tokio::fs::read(snapshot)
        .await
        .map_err(|e| format!("{}: {e}", snapshot.display()))?;

    // Present whenever backup is enabled: `from_env` refuses to start otherwise.
    let recipient = opts.recipient.as_ref().ok_or("VARIA_BACKUP_AGE_RECIPIENT is not set")?;
    let recipient = recipient.clone();
    let plaintext = bytes.clone();
    let ciphertext = tokio::task::spawn_blocking(move || age::encrypt(&recipient, &plaintext))
        .await
        .map_err(|e| format!("encrypt task: {e}"))?
        .map_err(|e| format!("encrypt: {e}"))?;

    store
        .put(key, PutPayload::from(ciphertext))
        .await
        .map_err(|e| format!("put {key}: {e}"))?;
    Ok(())
}

/// A consistent copy of the database, taken from its own connection so the sync
/// path's mutex is not held for the duration. `VACUUM INTO` writes a standalone
/// file: no `-wal`/`-shm` sidecar has to travel with it.
async fn snapshot_db(db_path: &Path, out: &Path) -> Result<(), String> {
    let db = db_path.to_path_buf();
    let out = out.to_path_buf();
    tokio::task::spawn_blocking(move || {
        // VACUUM INTO refuses an existing target.
        let _ = std::fs::remove_file(&out);
        let conn = rusqlite::Connection::open(&db)
            .map_err(|e| format!("open {}: {e}", db.display()))?;
        conn.execute("VACUUM INTO ?1", rusqlite::params![out.to_string_lossy()])
            .map_err(|e| format!("vacuum into {}: {e}", out.display()))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("snapshot task: {e}"))?
}

/// Download the newest object, decrypt it and write it to `db_path`. The service
/// must be stopped first; existing files are kept unless `force` is set.
pub async fn restore(db_path: &Path, opts: &BackupOptions, force: bool) -> Result<(), String> {
    if opts.bucket.is_empty() {
        return Err("VARIA_S3_BUCKET is empty; nothing to restore from".into());
    }
    let store = client(opts)?;
    let identity = identity()?;
    pull_latest(&store, &identity, db_path, prefix(opts).as_ref(), force).await
}

/// The testable half of `restore`, with the client and identity handed in.
async fn pull_latest(
    store: &dyn ObjectStore,
    identity: &x25519::Identity,
    db_path: &Path,
    prefix: Option<&ObjectPath>,
    force: bool,
) -> Result<(), String> {
    let mut newest: Option<(ObjectPath, i64)> = None;
    let mut listing = store.list(prefix);
    while let Some(item) = listing.next().await {
        let meta = item.map_err(|e| format!("list: {e}"))?;
        if meta.location.filename().and_then(slot_of).is_none() {
            continue;
        }
        let at = meta.last_modified.timestamp_millis();
        if newest.as_ref().is_none_or(|(_, seen)| at > *seen) {
            newest = Some((meta.location, at));
        }
    }
    let (object, at) = newest.ok_or("the bucket holds no backup object")?;
    eprintln!("restore: newest object {object} ({} s old)", (now_ms() - at).max(0) / 1000);

    if db_path.exists() && !force {
        return Err(format!(
            "{} exists; stop the service and pass --force to replace it",
            db_path.display()
        ));
    }
    let ciphertext = store
        .get(&object)
        .await
        .map_err(|e| format!("get {object}: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("read {object}: {e}"))?
        .to_vec();
    let identity = identity.clone();
    let bytes = tokio::task::spawn_blocking(move || age::decrypt(&identity, &ciphertext))
        .await
        .map_err(|e| format!("decrypt task: {e}"))?
        .map_err(|e| format!("decrypt: {e}"))?;

    let tmp = tmp_path(db_path);
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    // A restored file is standalone: a stale WAL beside it could shadow the data.
    for sidecar in [sidecar(db_path, "-wal"), sidecar(db_path, "-shm")] {
        let _ = tokio::fs::remove_file(&sidecar).await;
    }
    tokio::fs::rename(&tmp, db_path)
        .await
        .map_err(|e| format!("{}: {e}", db_path.display()))?;
    eprintln!("restore: wrote {}", db_path.display());
    Ok(())
}

/// The backup's age identity, read where it is used and never carried in
/// `BackupOptions`, which is logged: it is the one secret that makes the archive
/// readable, and it is deliberately not installed on the server. Restore is
/// therefore something only a machine with the vault can do.
fn identity() -> Result<x25519::Identity, String> {
    let value = env_option("VARIA_BACKUP_AGE_IDENTITY").ok_or(
        "VARIA_BACKUP_AGE_IDENTITY is not set; the archive can only be read with the backup's age \
         identity",
    )?;
    value.parse().map_err(|e| format!("VARIA_BACKUP_AGE_IDENTITY: {e}"))
}

/// Ping the dead-man's switch after an error-free pass, if one is configured.
///
/// The URL is the credential — anyone holding it can fake a heartbeat — so it is
/// read from the environment where it is used, never carried in `BackupOptions`.
async fn heartbeat() {
    let Some(url) = env_option("VARIA_BACKUP_PING_URL") else {
        return;
    };
    let response = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => eprintln!("backup heartbeat was refused: {}", response.status().as_u16()),
        Err(err) => eprintln!("backup heartbeat failed: {err}"),
    }
}

/// Time until the next `hour:minute` UTC.
fn until_next_run(hour: u32, minute: u32) -> Duration {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let target = u64::from(hour) * 3600 + u64::from(minute) * 60;
    let into_day = now % 86_400;
    let wait = if target > into_day { target - into_day } else { 86_400 - into_day + target };
    Duration::from_secs(wait)
}

/// The slot a pass writes: the first empty one, else the oldest object in the
/// ring. `existing` holds each object's slot and last-modified millis.
fn choose_slot(slots: u32, existing: &[(u32, i64)]) -> u32 {
    for n in 0..slots {
        if !existing.iter().any(|(slot, _)| *slot == n) {
            return n;
        }
    }
    existing.iter().min_by_key(|(_, at)| *at).map_or(0, |(slot, _)| *slot)
}

/// Slot of an object file name, or `None` for anything the ring does not own.
fn slot_of(name: &str) -> Option<u32> {
    name.strip_suffix(SUFFIX)?
        .strip_prefix("varia-")?
        .strip_suffix(".sqlite")?
        .parse()
        .ok()
}

fn slot_key(opts: &BackupOptions, slot: u32) -> ObjectPath {
    object_key(opts, &format!("varia-{slot}.sqlite{SUFFIX}"))
}

fn object_key(opts: &BackupOptions, name: &str) -> ObjectPath {
    if opts.prefix.is_empty() {
        ObjectPath::from(name)
    } else {
        ObjectPath::from(format!("{}/{}", opts.prefix.trim_end_matches('/'), name))
    }
}

fn prefix(opts: &BackupOptions) -> Option<ObjectPath> {
    if opts.prefix.is_empty() {
        None
    } else {
        Some(ObjectPath::from(opts.prefix.trim_end_matches('/')))
    }
}

fn snapshot_path(db_path: &Path) -> PathBuf {
    db_path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new(".")).join(SNAPSHOT)
}

fn tmp_path(db_path: &Path) -> PathBuf {
    sidecar(db_path, ".tmp")
}

fn sidecar(db_path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", db_path.display()))
}

/// The S3 client parses this as a URL and panics on a value it cannot read, so
/// an unusable endpoint has to stop startup instead. The scheme is required:
/// providers print the bare host, and prefixing it silently hides a mistake.
fn s3_endpoint(endpoint: &str, allow_http: bool) -> Result<String, String> {
    let endpoint = endpoint.trim();
    let (scheme, rest) = match endpoint.strip_prefix("https://") {
        Some(rest) => ("https", rest),
        None => match endpoint.strip_prefix("http://") {
            Some(rest) => ("http", rest),
            None => return Err("VARIA_S3_ENDPOINT must start with http:// or https://".into()),
        },
    };
    if scheme == "http" && !allow_http {
        return Err("VARIA_S3_ENDPOINT is plain HTTP; set VARIA_S3_ALLOW_HTTP=on to allow it".into());
    }
    let host = rest.trim_end_matches('/');
    if host.is_empty() {
        return Err("VARIA_S3_ENDPOINT has no host".into());
    }
    Ok(format!("{scheme}://{host}"))
}

fn region_from_endpoint(endpoint: &str) -> Option<String> {
    let rest = endpoint.split_once("://").map_or(endpoint, |(_, rest)| rest);
    let host = rest.split('/').next().unwrap_or(rest);
    let host = host.split(':').next().unwrap_or(host);
    let region = host.strip_prefix("s3.")?.strip_suffix(".backblazeb2.com")?;
    (!region.is_empty()).then(|| region.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn env_str(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// An optional string variable: unset, empty or blank is `None`.
fn env_option(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> Result<T, String>
where
    T::Err: std::fmt::Display,
{
    match std::env::var(key) {
        Ok(v) => v.parse().map_err(|e| format!("{key}: {e}")),
        Err(_) => Ok(default),
    }
}

fn env_bool(key: &str, default: bool) -> Result<bool, String> {
    match std::env::var(key) {
        Ok(value) => match value.as_str() {
            "1" | "true" | "on" | "yes" => Ok(true),
            "0" | "false" | "off" | "no" => Ok(false),
            other => Err(format!("{key}: expected a boolean, got {other:?}")),
        },
        Err(_) => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use object_store::ObjectStore;
    use object_store::memory::InMemory;

    use super::*;

    fn options(recipient: x25519::Recipient) -> BackupOptions {
        BackupOptions {
            enabled: true,
            bucket: "test".into(),
            region: "us-east-1".into(),
            endpoint: None,
            prefix: "varia".into(),
            hour: 3,
            minute: 30,
            slots: 3,
            allow_http: false,
            recipient: Some(recipient),
        }
    }

    #[test]
    fn the_ring_fills_empty_slots_then_overwrites_the_oldest() {
        assert_eq!(choose_slot(3, &[]), 0);
        assert_eq!(choose_slot(3, &[(0, 10)]), 1);
        assert_eq!(choose_slot(3, &[(2, 10), (0, 20)]), 1);
        // Full: the oldest last-modified goes, whatever its index.
        assert_eq!(choose_slot(3, &[(0, 30), (1, 10), (2, 20)]), 1);
    }

    #[test]
    fn only_objects_of_the_ring_are_recognised() {
        assert_eq!(slot_of("varia-4.sqlite.age"), Some(4));
        assert_eq!(slot_of("varia-4.sqlite"), None);
        assert_eq!(slot_of("varia-x.sqlite.age"), None);
        assert_eq!(slot_of("other.age"), None);
    }

    #[test]
    fn a_slot_key_round_trips_and_carries_the_prefix() {
        let id = x25519::Identity::generate();
        let opts = options(id.to_public());
        let key = slot_key(&opts, 2);
        assert_eq!(key.as_ref(), "varia/varia-2.sqlite.age");
        assert_eq!(slot_of(key.filename().unwrap()), Some(2));
    }

    #[test]
    fn the_next_pass_is_within_a_day() {
        for hour in [0, 3, 23] {
            for minute in [0, 30, 59] {
                let wait = until_next_run(hour, minute);
                assert!(wait.as_secs() > 0 && wait.as_secs() <= 86_400, "{}:{}", hour, minute);
            }
        }
    }

    #[test]
    fn an_endpoint_is_validated_before_the_client_can_panic() {
        assert_eq!(s3_endpoint("https://s3.example.com/", false).unwrap(), "https://s3.example.com");
        assert!(s3_endpoint("s3.example.com", false).is_err());
        assert!(s3_endpoint("http://s3.example.com", false).is_err());
        assert!(s3_endpoint("http://s3.example.com", true).is_ok());
        assert_eq!(
            region_from_endpoint("https://s3.eu-central-003.backblazeb2.com"),
            Some("eu-central-003".to_string())
        );
        assert_eq!(region_from_endpoint("https://s3.example.com"), None);
    }

    #[tokio::test]
    async fn a_pass_writes_an_encrypted_sqlite_that_restores() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("varia.sqlite");
        {
            let conn = rusqlite::Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE op(id TEXT); INSERT INTO op VALUES ('a');")
                .unwrap();
        }

        let identity = x25519::Identity::generate();
        let opts = options(identity.to_public());
        let store = InMemory::new();

        run_once(&store, &db, &opts).await.expect("pass");
        // The snapshot is gone and exactly one ring object exists.
        let mut names = HashSet::new();
        let mut listing = store.list(None);
        while let Some(item) = listing.next().await {
            names.insert(item.unwrap().location.to_string());
        }
        assert_eq!(names, HashSet::from(["varia/varia-0.sqlite.age".to_string()]));
        assert!(!snapshot_path(&db).exists(), "the plaintext snapshot must not stay");

        // A second pass rotates to the next empty slot.
        run_once(&store, &db, &opts).await.expect("pass");
        let mut listing = store.list(None);
        let mut names = HashSet::new();
        while let Some(item) = listing.next().await {
            names.insert(item.unwrap().location.to_string());
        }
        assert!(names.contains("varia/varia-1.sqlite.age"), "{names:?}");

        // Restore the newest object and read the restored database back.
        let restored = dir.path().join("restored.sqlite");
        pull_latest(&store, &identity, &restored, prefix(&opts).as_ref(), false).await.expect("restore");
        let conn = rusqlite::Connection::open(&restored).unwrap();
        let id: String = conn.query_row("SELECT id FROM op", [], |row| row.get(0)).unwrap();
        assert_eq!(id, "a");
    }
}
