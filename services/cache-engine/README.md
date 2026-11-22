# In-Memory LRU Cache Microservice (`services/cache-engine`)

A high-performance in-memory caching microservice featuring **$O(1)$ LRU eviction**, **TTL expiration**, and **real-time telemetry headers**.

---

## Quickstart

### 1. Run the Service

```bash
# From repository root:
pnpm --filter @intheruntime/service-cache-engine start
```
*Listens on `http://localhost:8082`.*

---

## API Endpoints

### 1. Store a Value (With Optional TTL)
```bash
curl -X POST http://localhost:8082/v1/cache/user_123 \
  -H "Content-Type: application/json" \
  -d '{
    "value": { "name": "Alice", "plan": "enterprise" },
    "ttl_ms": 10000
  }'
```

### 2. Retrieve a Value
```bash
curl -i http://localhost:8082/v1/cache/user_123
```

Response headers indicate whether the item came from RAM:
```http
HTTP/1.1 200 OK
X-Cache: HIT
X-Cache-Hits: 1
Content-Type: application/json

{"name":"Alice","plan":"enterprise"}
```

If the item was missing or expired:
```http
HTTP/1.1 404 Not Found
X-Cache: MISS
```

### 3. Real-Time Telemetry & Hit Ratio
```bash
curl http://localhost:8082/v1/cache/stats
```
Response:
```json
{
  "size": 42,
  "capacity": 1000,
  "hits": 180,
  "misses": 20,
  "evictions": 0,
  "expirations": 4,
  "hitRatio": 0.9
}
```

### 4. Interactive Slow Query Demo
This endpoint simulates an expensive, slow database query (taking 300ms). The first request is slow (`X-Cache: MISS`), and all subsequent requests return in $< 1\text{ms}$ (`X-Cache: HIT`):

```bash
# First request (slow):
curl -i http://localhost:8082/v1/demo/expensive-query?id=product_99

# Subsequent requests (instant):
curl -i http://localhost:8082/v1/demo/expensive-query?id=product_99
```
