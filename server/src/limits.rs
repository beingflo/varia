// Token buckets, in memory only: a restart empties them, which is fine for abuse control.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

struct Bucket {
    tokens: f64,
    last: Instant,
}

pub struct Limiter {
    buckets: Mutex<HashMap<String, Bucket>>,
    burst: f64,
    per_sec: f64,
}

impl Limiter {
    pub fn new(burst: f64, per_min: f64) -> Self {
        Self { buckets: Mutex::new(HashMap::new()), burst, per_sec: per_min / 60.0 }
    }

    /// Ok when the call fits the budget, Err with the seconds to wait before retrying.
    pub fn check(&self, key: &str) -> Result<(), u64> {
        let mut buckets = self.buckets.lock().unwrap();
        // Bounded memory: forget callers that have been idle for ten minutes, i.e. anyone whose
        // bucket would be full again anyway.
        if buckets.len() > 4096 {
            buckets.retain(|_, bucket| bucket.last.elapsed().as_secs() < 600);
        }
        let now = Instant::now();
        let bucket = buckets.entry(key.to_owned()).or_insert(Bucket { tokens: self.burst, last: now });
        let refill = now.saturating_duration_since(bucket.last).as_secs_f64() * self.per_sec;
        bucket.tokens = (bucket.tokens + refill).min(self.burst);
        bucket.last = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            Err(((1.0 - bucket.tokens) / self.per_sec).ceil() as u64)
        }
    }
}
