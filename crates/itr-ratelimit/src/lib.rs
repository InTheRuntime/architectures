//! # itr-ratelimit
//! Distributed Token Bucket Rate Limiter with atomic Redis Lua and thread-safe in-memory fallback.

use dashmap::DashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use thiserror::Error;

/// Lua script embedded for atomic Redis execution.
pub const TOKEN_BUCKET_LUA: &str = include_str!("token_bucket.lua");

#[derive(Debug, Error)]
pub enum RateLimitError {
    #[error("Redis operation failed: {0}")]
    Redis(#[from] redis::RedisError),
    #[error("Internal rate limiter error: {0}")]
    Internal(String),
}

/// Rate limit policy definition.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RateLimitPolicy {
    /// Maximum burst capacity in tokens (e.g. 10).
    pub capacity: u32,
    /// Refill rate in tokens per second (e.g. 2.0).
    pub refill_rate: f64,
}

impl RateLimitPolicy {
    pub const fn new(capacity: u32, refill_rate: f64) -> Self {
        Self {
            capacity,
            refill_rate,
        }
    }
}

/// The result returned after evaluating a rate limit request.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RateLimitResult {
    /// Whether the request is permitted.
    pub allowed: bool,
    /// Maximum burst capacity for this policy.
    pub limit: u32,
    /// Tokens remaining in the bucket.
    pub remaining: u32,
    /// Seconds until the bucket refills back to full capacity.
    pub reset_after_secs: u64,
    /// Seconds until at least 1 token is available (only relevant if allowed == false).
    pub retry_after_secs: u64,
}

/// Internal state stored per bucket in the in-memory fallback.
#[derive(Debug, Clone)]
struct InMemoryBucket {
    tokens: f64,
    last_updated: Instant,
}

/// In-memory token bucket rate limiter (thread-safe fallback without Redis).
#[derive(Debug, Clone)]
pub struct InMemoryRateLimiter {
    buckets: Arc<DashMap<String, InMemoryBucket>>,
}

impl Default for InMemoryRateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryRateLimiter {
    pub fn new() -> Self {
        Self {
            buckets: Arc::new(DashMap::new()),
        }
    }

    /// Evaluates rate limit for a key against a policy in memory.
    pub fn check(&self, key: &str, policy: RateLimitPolicy, cost: u32) -> RateLimitResult {
        let now = Instant::now();
        let capacity_f64 = policy.capacity as f64;
        let cost_f64 = cost as f64;

        let mut entry = self.buckets.entry(key.to_string()).or_insert_with(|| InMemoryBucket {
            tokens: capacity_f64,
            last_updated: now,
        });

        // 1. Calculate elapsed time delta in seconds
        let elapsed = now.duration_since(entry.last_updated).as_secs_f64();
        
        // 2. Continuous refill math: tokens = min(capacity, current + delta * rate)
        let refilled = entry.tokens + (elapsed * policy.refill_rate);
        let current_tokens = refilled.min(capacity_f64);

        if current_tokens >= cost_f64 {
            let new_tokens = current_tokens - cost_f64;
            entry.tokens = new_tokens;
            entry.last_updated = now;

            let reset_after = ((capacity_f64 - new_tokens) / policy.refill_rate).ceil() as u64;

            RateLimitResult {
                allowed: true,
                limit: policy.capacity,
                remaining: new_tokens.floor() as u32,
                reset_after_secs: reset_after,
                retry_after_secs: 0,
            }
        } else {
            // Rejected
            let reset_after = ((capacity_f64 - current_tokens) / policy.refill_rate).ceil() as u64;
            let retry_after = ((cost_f64 - current_tokens) / policy.refill_rate).ceil() as u64;

            RateLimitResult {
                allowed: false,
                limit: policy.capacity,
                remaining: 0,
                reset_after_secs: reset_after,
                retry_after_secs: retry_after.max(1),
            }
        }
    }
}

/// Distributed Redis-backed Token Bucket Rate Limiter.
#[derive(Clone)]
pub struct RedisRateLimiter {
    client: redis::Client,
    script: redis::Script,
    fallback: InMemoryRateLimiter,
}

impl RedisRateLimiter {
    pub fn new(redis_url: &str) -> Result<Self, RateLimitError> {
        let client = redis::Client::open(redis_url)?;
        let script = redis::Script::new(TOKEN_BUCKET_LUA);
        Ok(Self {
            client,
            script,
            fallback: InMemoryRateLimiter::new(),
        })
    }

    /// Evaluates rate limit against Redis with automatic in-memory fallback on connection failure.
    pub async fn check(&self, key: &str, policy: RateLimitPolicy, cost: u32) -> RateLimitResult {
        match self.check_redis(key, policy, cost).await {
            Ok(result) => result,
            Err(err) => {
                tracing::warn!(error = %err, "Redis rate-limiter unavailable, using in-memory fallback");
                self.fallback.check(key, policy, cost)
            }
        }
    }

    async fn check_redis(&self, key: &str, policy: RateLimitPolicy, cost: u32) -> Result<RateLimitResult, RateLimitError> {
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        
        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_secs_f64();

        let redis_key = format!("rl:{}", key);

        // Execute atomic Lua script
        let result: Vec<i64> = self
            .script
            .key(&redis_key)
            .arg(policy.capacity)
            .arg(policy.refill_rate)
            .arg(cost)
            .arg(now_unix)
            .invoke_async(&mut conn)
            .await?;

        if result.len() < 4 {
            return Err(RateLimitError::Internal("Malformed Lua script response".into()));
        }

        let allowed = result[0] == 1;
        let remaining = result[1] as u32;
        let reset_after_secs = result[2] as u64;
        let retry_after_secs = result[3] as u64;

        Ok(RateLimitResult {
            allowed,
            limit: policy.capacity,
            remaining,
            reset_after_secs,
            retry_after_secs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn test_in_memory_token_bucket_exhaustion_and_refill() {
        let limiter = InMemoryRateLimiter::new();
        // Capacity: 3 tokens, Refills 1 token every second
        let policy = RateLimitPolicy::new(3, 1.0);
        let key = "test_user_1";

        // Request 1: allowed, remaining = 2
        let r1 = limiter.check(key, policy, 1);
        assert!(r1.allowed);
        assert_eq!(r1.remaining, 2);

        // Request 2: allowed, remaining = 1
        let r2 = limiter.check(key, policy, 1);
        assert!(r2.allowed);
        assert_eq!(r2.remaining, 1);

        // Request 3: allowed, remaining = 0
        let r3 = limiter.check(key, policy, 1);
        assert!(r3.allowed);
        assert_eq!(r3.remaining, 0);

        // Request 4: REJECTED (bucket depleted)
        let r4 = limiter.check(key, policy, 1);
        assert!(!r4.allowed);
        assert_eq!(r4.remaining, 0);
        assert!(r4.retry_after_secs >= 1);

        // Wait 1.1 seconds for 1 token to refill
        sleep(Duration::from_millis(1100));

        // Request 5: should now be ALLOWED!
        let r5 = limiter.check(key, policy, 1);
        assert!(r5.allowed);
        assert_eq!(r5.remaining, 0);
    }
}
