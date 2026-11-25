# Distributed Rate Limiter Service (`services/rate-limiter`)

A standalone, high-performance HTTP Rate Limiter built with **Rust**, **Axum**, and **Redis Lua**, adhering to modern **IETF standard RateLimit headers**.

---

## Features

- **Sub-millisecond Latency**: Continuous Token Bucket algorithm evaluated in Redis Lua (or local in-memory fallback).
- **Zero Race Conditions**: Atomic token evaluation across multi-replica gateway clusters.
- **IETF Standards**: Returns `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After`.
- **Graceful Degradation**: Automatically falls back to thread-safe in-memory rate limiting if Redis is down.

---

## Quickstart

### 1. Start Infrastructure (Redis)

```bash
# From the repository root:
pnpm docker:up
```

### 2. Run the Service

```bash
# Run in debug mode (listening on http://127.0.0.1:8081)
cargo run -p service-rate-limiter
```

---

## API Endpoints

### 1. Health Check
```bash
curl http://127.0.0.1:8081/health
```

### 2. Dedicated Check API (Used by Proxies & Gateways)
```bash
curl -X POST http://127.0.0.1:8081/v1/rate-limit/check \
  -H "Content-Type: application/json" \
  -d '{
    "key": "user_api_key_123",
    "capacity": 5,
    "refill_rate": 1.0,
    "cost": 1
  }'
```

Response:
```json
{
  "allowed": true,
  "limit": 5,
  "remaining": 4,
  "reset_after_secs": 1,
  "retry_after_secs": 0
}
```

### 3. Interactive Protected Demo Endpoint
Hit this endpoint rapidly to watch the tokens deplete and trigger `429 Too Many Requests`:

```bash
curl -i http://127.0.0.1:8081/v1/demo/protected
```

Inspect the returned headers:
```http
HTTP/1.1 200 OK
RateLimit-Limit: 5
RateLimit-Remaining: 4
RateLimit-Reset: 1
```
