# `itr-ratelimit` (`crates/itr-ratelimit`)

Draft Rust crate implementing a continuous Token Bucket rate limiter with an atomic Redis Lua script (`src/token_bucket.lua`) and thread-safe in-memory `DashMap` fallback (`InMemoryRateLimiter`), returning IETF `RateLimit-*` calculation metadata.

Specified in [ADR-0004](../../specs/adr/0004-distributed-token-bucket-rate-limiting.md).

---

## Status Note

This crate is retained as a **draft library implementation** and is intentionally excluded from root `Cargo.toml` workspace members on hosts lacking MSVC `link.exe` or GNU `dlltool.exe` native C-linking support (because `redis` and full `tokio` networking depend on `windows-sys` / `socket2` native imports on Windows).

For the active, cross-platform HTTP Rate Limiting microservice and test suite, see [`services/rate-limiter`](../../services/rate-limiter/README.md).
