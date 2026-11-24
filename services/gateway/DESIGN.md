# Architecture Design: The Unified API Gateway Platform

- **Architecture Domain**: Core Infrastructure
- **System Layer**: Edge Ingress, Security, Traffic Shaping & Caching
- **Status**: Implemented & Tested
- **Package**: `@intheruntime/service-gateway`

---

## 1. System Overview & The Master Architecture

The **Unified API Gateway** is the single entry point (the "Front Door") for all incoming client traffic. It orchestrates the four fundamental pillars built across Levels 0 through 3 into a high-performance, resilient request pipeline:

```text
                                [ Inbound Client Request ]
                                            │
                                            ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                UNIFIED API GATEWAY PIPELINE                            │
│                                                                                       │
│   1. TRACE ID INJECTION    ─► Generates X-Request-Id (UUID) for distributed tracing.  │
│                                                                                       │
│   2. RATE LIMITER (Level 1)─► Continuous Token Bucket via Redis Lua / In-Memory.      │
│                               Is client quota exhausted?                              │
│                               ├── YES ──► Return 429 Too Many Requests (Halt)         │
│                               └── NO  ──► Inject RateLimit-* headers & proceed.       │
│                                                                                       │
│   3. BITWISE RBAC (Level 0)─► O(1) CPU Constant-Time Bitmask Authorization.           │
│                               Does client token satisfy required_mask?                │
│                               ├── NO  ──► Return 403 Forbidden (Halt)                 │
│                               └── YES ──► Proceed.                                    │
│                                                                                       │
│   4. CACHE ENGINE (Level 2)─► O(1) LRU Cache with TTL.                                │
│                               Is response already in memory?                          │
│                               ├── YES ──► Return 200 OK (X-Cache: HIT in < 1ms)       │
│                               └── NO  ──► X-Cache: MISS (Proceed to Upstream).        │
│                                                                                       │
│   5. LOAD BALANCER(Level 3)─► Round-Robin / Least-Connections Target Selection.      │
│                               Are healthy backends available?                         │
│                               ├── NO  ──► Return 502 Bad Gateway                      │
│                               └── YES ──► Forward request & stream response.          │
│                                                                                       │
│   6. RESPONSE CACHE STORE  ─► Cache HTTP 200 GET responses for next time.            │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │
                                            ▼
                              [ Decorated Client Response ]
```

---

## 2. End-to-End Latency Budget

| Pipeline Stage | Technology | Time Spent | Purpose |
| :--- | :--- | :--- | :--- |
| **1. Trace ID** | `crypto.randomUUID()` | $< 1\,\mu\text{s}$ | Traceability |
| **2. Rate Limiting** | Continuous Token Bucket | $5\,\mu\text{s}$ (RAM) / $0.4\,\text{ms}$ (Redis) | Perimeter defense |
| **3. Bitwise RBAC** | 64-bit Bitmask AND check | $< 10\,\text{ns}$ ($O(1)$) | Access control |
| **4. In-Memory Cache** | Doubly Linked List + Map | $2\,\mu\text{s}$ ($O(1)$) | Fast data retrieval |
| **5. Load Balancer** | Round-Robin Pool | $1\,\mu\text{s}$ ($O(1)$) | Upstream selection |
| **Overall Cache HIT** | Gateway RAM | **$< 0.5\,\text{ms}$ total** | **$100\times$ faster than DB** |

---

## 3. Route Configuration Schema

Each route in the gateway is defined declaratively:

```typescript
export interface GatewayRoute {
  id: string;
  pathPrefix: string;
  upstreams: string[];
  rateLimit: {
    capacity: number;     // Maximum burst limit
    refillRate: number;   // Tokens refilled per second
  };
  auth: {
    required: boolean;
    requiredMask: bigint; // 64-bit permission bitmask
  };
  cache: {
    enabled: boolean;
    ttlMs: number;        // Time-To-Live in milliseconds
  };
}
```

---

## 4. Response Header Standards

Every response emitted by the gateway contains complete observability headers:

```http
HTTP/1.1 200 OK
X-Request-Id: req_9a81b2c4e610
RateLimit-Limit: 10
RateLimit-Remaining: 9
RateLimit-Reset: 1
X-Cache: HIT
X-Cache-Hit-Ratio: 0.85
X-Served-By-Backend: http://127.0.0.1:8081
```

If rate limit is breached:
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 2
RateLimit-Remaining: 0
RateLimit-Reset: 5
```

If authorization bitmask is insufficient:
```http
HTTP/1.1 403 Forbidden
X-Required-Permission: 0x0000000000000008
X-Provided-Permission: 0x0000000000000003
```
