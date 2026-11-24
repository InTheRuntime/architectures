# Unified Production API Gateway (`services/gateway`)

The flagship Core Infrastructure platform integrating **Rate Limiting (Level 1)**, **Bitwise RBAC (Level 0)**, **In-Memory Caching (Level 2)**, and **Reverse Proxy Load Balancing (Level 3)** into a unified edge pipeline.

---

## Quickstart

### 1. Start the API Gateway

```bash
# From repository root:
pnpm --filter @intheruntime/service-gateway start
```
*Listens on `http://localhost:8000`.*

---

## Pre-Configured Showcase Routes

| Route | Security & Rules | Upstream Target | Behavior |
| :--- | :--- | :--- | :--- |
| **`/api/public`** | Public, Rate-limited (10 burst), Cached (10s TTL) | Mock Upstream | Responses cached in RAM for 10s. Subsequent calls return in $< 1\text{ms}$. |
| **`/api/admin`** | Requires `PERM_ADMIN` (`0x08`), Rate-limited (5 burst) | Mock Upstream | Blocks unauthorized requests with `403 Forbidden`. |

---

## Interactive Walkthrough Recipes

### 1. Test Public Route & Caching
```bash
# Request 1 (Cache MISS):
curl -i http://localhost:8000/api/public

# Request 2 (Cache HIT - instant!):
curl -i http://localhost:8000/api/public
```
Inspect the headers:
```http
X-Cache: HIT
RateLimit-Remaining: 9
X-Request-Id: req_...
```

### 2. Test Rate Limiting Protection
Send rapid requests to exceed the bucket limit:
```bash
for i in {1..12}; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/api/public; done
```
You will see `200`s followed immediately by `429 Too Many Requests`!

### 3. Test Bitwise RBAC Access Control
```bash
# Without token -> 401 Unauthorized
curl -i http://localhost:8000/api/admin

# With insufficient token (READ + WRITE = 0x03, but ADMIN = 0x08 required) -> 403 Forbidden
curl -i -H "Authorization: Bearer 0x0000000000000003" http://localhost:8000/api/admin

# With Admin token (0x08) -> 200 OK!
curl -i -H "Authorization: Bearer 0x0000000000000008" http://localhost:8000/api/admin
```

### 4. Inspect Gateway Telemetry
```bash
curl http://localhost:8000/_gateway/stats
```
Response:
```json
{
  "total_requests": 45,
  "cache_hits": 28,
  "cache_misses": 17,
  "rate_limited_requests": 6,
  "auth_rejected_requests": 3,
  "active_routes": 2
}
```
