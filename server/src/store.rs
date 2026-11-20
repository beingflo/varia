// The encrypted op log: two tables, no note schema, nothing readable.
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

/// An op on its way in. The server keeps `ciphertext` opaque and never touches the payload.
pub struct NewOp<'a> {
    /// Random, chosen by the client: the dedupe key, so a retried push is harmless.
    pub id: &'a str,
    pub device: &'a str,
    pub kind: &'a str,
    pub note_id: &'a str,
    pub created: i64,
    pub ciphertext: &'a [u8],
}

/// An op on its way out, with the sequence the server assigned to it.
pub struct StoredOp {
    pub server_seq: i64,
    pub id: String,
    pub device: String,
    pub kind: String,
    pub note_id: String,
    pub created: i64,
    pub ciphertext: Vec<u8>,
}

// One connection behind a mutex: writes are serialised anyway and pulls are small. A read pool
// would only matter once sync requests queue behind each other.
// shortcut: single connection for reads and writes, add a pool when pulls block pushes
/// What a token the server does not know looks like from the inside: a hash prefix (never the token)
/// and how many accounts the database holds. Zero means a fresh volume, not a forgotten token.
pub struct UnknownToken {
    pub hash_prefix: String,
    pub accounts: i64,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        // `CREATE TABLE IF NOT EXISTS` is not a migration: a database written by an older build
        // keeps its old columns, and every query naming a new one then fails per request instead of
        // at startup. There is nothing to bring forward — the schema has no live data worth keeping
        // — so a shape this build does not recognise refuses to serve and says so.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS user(
                 id TEXT PRIMARY KEY,
                 token_hash TEXT NOT NULL UNIQUE,
                 created INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS op(
                 owner TEXT NOT NULL,
                 server_seq INTEGER NOT NULL,
                 op_id TEXT NOT NULL,
                 device TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 note_id TEXT NOT NULL,
                 created INTEGER NOT NULL,
                 ciphertext BLOB NOT NULL,
                 PRIMARY KEY (owner, server_seq),
                 UNIQUE (owner, op_id)
             );",
        )?;
        require_columns(
            &conn,
            "op",
            &["owner", "server_seq", "op_id", "device", "kind", "note_id", "created", "ciphertext"],
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Creates an account and returns its token. Only the hash is kept.
    pub fn signup(&self) -> rusqlite::Result<String> {
        let token = random_hex(32);
        let owner = random_hex(16);
        self.conn.lock().unwrap().execute(
            "INSERT INTO user(id, token_hash, created) VALUES (?, ?, ?)",
            params![owner, random_hex_of(&token), now()],
        )?;
        Ok(token)
    }

    pub fn describe_unknown(&self, token: &str) -> rusqlite::Result<UnknownToken> {
        let hash = random_hex_of(token);
        let conn = self.conn.lock().expect("store lock");
        let accounts: i64 = conn.query_row("SELECT count(*) FROM user", [], |row| row.get(0))?;
        Ok(UnknownToken { hash_prefix: hash[..6.min(hash.len())].to_owned(), accounts })
    }

    pub fn owner_for(&self, token: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT id FROM user WHERE token_hash = ?", [random_hex_of(token)], |row| row.get(0))
            .optional()
    }

    /// Appends the ops it can, stopping at the storage cap. Duplicates are ignored, so a retried
    /// push is harmless.
    pub fn push(&self, owner: &str, ops: &[NewOp], cap: i64) -> rusqlite::Result<PushOutcome> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let mut usage: i64 = tx.query_row(
            "SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM op WHERE owner = ?",
            [owner],
            |row| row.get(0),
        )?;
        let base: i64 =
            tx.query_row("SELECT COALESCE(MAX(server_seq), 0) FROM op WHERE owner = ?", [owner], |row| row.get(0))?;
        let mut stored = 0;
        let mut accepted = 0usize;
        for op in ops {
            let known: Option<i64> = tx
                .query_row(
                    "SELECT server_seq FROM op WHERE owner = ?1 AND op_id = ?2",
                    params![owner, op.id],
                    |row| row.get(0),
                )
                .optional()?;
            if known.is_some() {
                accepted += 1; // already on the server: it never trips the cap
                continue;
            }
            if usage + op.ciphertext.len() as i64 > cap {
                break;
            }
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO op(owner, server_seq, op_id, device, kind, note_id, created, ciphertext)
                 VALUES (?1, (SELECT COALESCE(MAX(server_seq), 0) + 1 FROM op WHERE owner = ?1),
                         ?2, ?3, ?4, ?5, ?6, ?7)",
                params![owner, op.id, op.device, op.kind, op.note_id, op.created, op.ciphertext],
            )?;
            // A row the table refused (a stale constraint, a migrated schema) must not be counted
            // as stored: the client would mark it pushed and lose it.
            if inserted == 0 {
                break;
            }
            usage += op.ciphertext.len() as i64;
            stored += 1;
            accepted += 1;
        }
        tx.commit()?;
        // Sequences are handed out in insert order, so the highest one this call wrote is base + stored.
        Ok(PushOutcome {
            stored,
            accepted,
            usage,
            written: if stored > 0 { base + stored as i64 } else { 0 },
            base,
        })
    }

    /// Ops after `cursor`, in server order. `limit + 1` rows are fetched to learn whether more wait.
    pub fn pull(&self, owner: &str, cursor: i64, limit: usize) -> rusqlite::Result<Vec<StoredOp>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT server_seq, op_id, device, kind, note_id, created, ciphertext
             FROM op WHERE owner = ?1 AND server_seq > ?2
             ORDER BY server_seq LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![owner, cursor, limit as i64], |row| {
            Ok(StoredOp {
                server_seq: row.get(0)?,
                id: row.get(1)?,
                device: row.get(2)?,
                kind: row.get(3)?,
                note_id: row.get(4)?,
                created: row.get(5)?,
                ciphertext: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// The owner's highest sequence, or 0: the client compares it with its own cursor to notice that
    /// this log has lost ops (a restored backup, a wiped account).
    pub fn head(&self, owner: &str) -> rusqlite::Result<i64> {
        self.conn.lock().unwrap().query_row(
            "SELECT COALESCE(MAX(server_seq), 0) FROM op WHERE owner = ?1",
            params![owner],
            |row| row.get(0),
        )
    }

    pub fn usage(&self, owner: &str) -> rusqlite::Result<i64> {
        self.conn.lock().unwrap().query_row(
            "SELECT COALESCE(SUM(LENGTH(ciphertext)), 0) FROM op WHERE owner = ?",
            [owner],
            |row| row.get(0),
        )
    }
}

pub struct PushOutcome {
    pub stored: usize,
    /// How many of the request's ops (in order) the account now holds: a full account accepts a
    /// prefix, and the client marks exactly that much as pushed.
    pub accepted: usize,
    pub usage: i64,
    /// Highest sequence this call wrote, so the caller can pull only what it did not just send.
    pub written: i64,
    /// Highest sequence before this call. A client whose cursor is at or above it had seen every
    /// op that existed, so skipping past its own writes is safe.
    pub base: i64,
}

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect()
}

fn require_columns(conn: &Connection, table: &str, required: &[&str]) -> rusqlite::Result<()> {
    let present = columns(conn, table)?;
    let missing: Vec<&str> = required.iter().copied().filter(|name| !present.iter().any(|c| c == name)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(rusqlite::Error::InvalidParameterName(format!(
        "table {table} is missing {missing:?} — this database was written by another build; \
         delete it (the log is rebuildable from any device) and start a new one",
    )))
}

/// Hex, not base64: the token is compared by exact string in one column, and hex has no padding.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("no randomness");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_hex_of(secret: &str) -> String {
    Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_older_shape_is_refused_at_startup_rather_than_failing_every_request() {
        // The table this service wrote before ops had ids of their own.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE user(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
             CREATE TABLE op(
                 owner TEXT NOT NULL, server_seq INTEGER NOT NULL, device TEXT NOT NULL,
                 seq INTEGER NOT NULL, kind TEXT NOT NULL, note_id TEXT NOT NULL,
                 created INTEGER NOT NULL, ciphertext BLOB NOT NULL,
                 PRIMARY KEY (owner, server_seq), UNIQUE (owner, device, seq)
             );",
        )
        .unwrap();
        let err = match Store::init(conn) {
            Ok(_) => panic!("an unknown shape must not be served"),
            Err(err) => err.to_string(),
        };
        assert!(err.contains("op_id"), "{err}");
        assert!(err.contains("another build"), "{err}");
    }
}
