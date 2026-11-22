use axum::{
    extract::{ConnectInfo, Json, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use itr_ratelimit::{InMemoryRateLimiter, RateLimitPolicy, RateLimitResult, RedisRateLimiter};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Clone)]
enum LimiterBackend {
    Redis(RedisRateLimiter),
    Memory(InMemoryRateLimiter),
}

impl LimiterBackend {
    async fn check(&self, key: &str, policy: RateLimitPolicy, cost: u32) -> RateLimitResult {
        match self {
            Self::Redis(limiter) => limiter.check(key, policy, cost).await,
            Self::Memory(limiter) => limiter.check(key, policy, cost),
        }
    }
}

#[derive(Clone)]
struct AppState {
    limiter: Arc<LimiterBackend>,
}

#[derive(Debug, Deserialize)]
struct CheckRequest {
    key: String,
    capacity: u32,
    refill_rate: f64,
    #[serde(default = "default_cost")]
    cost: u32,
}

fn default_cost() -> u32 {
    1
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
    message: String,
    retry_after_secs: u64,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    
    let limiter_backend = match RedisRateLimiter::new(&redis_url) {
        Ok(redis_limiter) => {
            info!("Connected to Redis at {}", redis_url);
            LimiterBackend::Redis(redis_limiter)
        }
        Err(err) => {
            warn!("Failed to initialize Redis ({}), falling back to in-memory mode", err);
            LimiterBackend::Memory(InMemoryRateLimiter::new())
        }
    };

    let state = AppState {
        limiter: Arc::new(limiter_backend),
    };

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/v1/rate-limit/check", post(check_rate_limit))
        .route("/v1/demo/protected", get(demo_protected))
        .with_state(state);

    let port = std::env::var("PORT").unwrap_or_else(|_| "8081".to_string());
    let addr: SocketAddr = format!("0.0.0.0:{}", port).parse().expect("Invalid address");

    info!("🚀 Rate Limiter service listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind port");

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .expect("Server error");
}

async fn health_check() -> &'static str {
    "OK"
}

/// Dedicated rate limit evaluation endpoint for external proxies or gateways
async fn check_rate_limit(
    State(state): State<AppState>,
    Json(payload): Json<CheckRequest>,
) -> Response {
    let policy = RateLimitPolicy::new(payload.capacity, payload.refill_rate);
    let result = state.limiter.check(&payload.key, policy, payload.cost).await;

    let mut headers = HeaderMap::new();
    inject_ietf_headers(&mut headers, &result);

    if result.allowed {
        (StatusCode::OK, headers, Json(result)).into_response()
    } else {
        let err_body = ErrorResponse {
            error: "too_many_requests".into(),
            message: format!(
                "Rate limit exceeded. Retry after {} seconds.",
                result.retry_after_secs
            ),
            retry_after_secs: result.retry_after_secs,
        };
        (StatusCode::TOO_MANY_REQUESTS, headers, Json(err_body)).into_response()
    }
}

/// Interactive protected demo endpoint: 5 burst capacity, refills 1 token per second
async fn demo_protected(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let client_ip = addr.ip().to_string();
    let demo_policy = RateLimitPolicy::new(5, 1.0); // 5 tokens burst, 1 token/sec refill
    let key = format!("demo:ip:{}", client_ip);

    let result = state.limiter.check(&key, demo_policy, 1).await;

    let mut headers = HeaderMap::new();
    inject_ietf_headers(&mut headers, &result);

    if result.allowed {
        let body = serde_json::json!({
            "message": "Access granted! Welcome to the protected resource.",
            "client_ip": client_ip,
            "rate_limit": {
                "remaining_tokens": result.remaining,
                "burst_capacity": result.limit,
                "refill_rate": "1 token/sec"
            }
        });
        (StatusCode::OK, headers, Json(body)).into_response()
    } else {
        let body = serde_json::json!({
            "error": "too_many_requests",
            "message": format!("Rate limit exceeded. Retry after {} seconds.", result.retry_after_secs),
            "client_ip": client_ip,
            "retry_after_secs": result.retry_after_secs
        });
        (StatusCode::TOO_MANY_REQUESTS, headers, Json(body)).into_response()
    }
}

/// Injects standard IETF RateLimit headers
fn inject_ietf_headers(headers: &mut HeaderMap, result: &RateLimitResult) {
    if let Ok(limit_val) = HeaderValue::from_str(&result.limit.to_string()) {
        headers.insert("RateLimit-Limit", limit_val);
    }
    if let Ok(rem_val) = HeaderValue::from_str(&result.remaining.to_string()) {
        headers.insert("RateLimit-Remaining", rem_val);
    }
    if let Ok(reset_val) = HeaderValue::from_str(&result.reset_after_secs.to_string()) {
        headers.insert("RateLimit-Reset", reset_val);
    }
    if !result.allowed {
        if let Ok(retry_val) = HeaderValue::from_str(&result.retry_after_secs.to_string()) {
            headers.insert("Retry-After", retry_val);
        }
    }
}
