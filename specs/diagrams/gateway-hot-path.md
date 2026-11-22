# API Gateway Hot-Path Request Flow

This document details the exact sequence of operations executed by the Rust Data Plane on the high-throughput request hot path.

---

## Sequence Flow Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant Proxy as Rust Data Plane<br/>(Axum/Tokio)
    participant Cache as In-Memory Table<br/>(ArcSwap)
    participant Redis as Redis Cluster<br/>(Token Bucket)
    participant Target as Upstream Service

    Client->>Proxy: Inbound HTTP Request<br/>(Method, Path, Authorization)
    
    rect rgb(240, 248, 255)
        Note over Proxy,Cache: Step 1: Route Matching
        Proxy->>Cache: Match path prefix & HTTP method
        alt Route Not Found
            Proxy-->>Client: 404 Not Found (JSON error)
        end
    end

    rect rgb(255, 250, 240)
        Note over Proxy,Redis: Step 2: Rate Limiting Evaluation
        Proxy->>Proxy: Resolve bucket key (API Key > User ID > Client IP)
        Proxy->>Redis: EVALSHA token_bucket.lua (Key, Capacity, RefillRate)
        alt Bucket Depleted (Tokens < 1)
            Redis-->>Proxy: { allowed: false, remaining: 0, reset_s: 14 }
            Proxy-->>Client: 429 Too Many Requests<br/>(RateLimit-* headers & Retry-After)
        else Tokens Available
            Redis-->>Proxy: { allowed: true, remaining: 49, reset_s: 0 }
        end
    end

    rect rgb(245, 255, 245)
        Note over Proxy: Step 3: Hot-Path Authentication & Bitwise RBAC
        alt Route Requires Auth
            alt Bearer JWT Provided
                Proxy->>Proxy: Verify Ed25519/RS256 signature in-memory
                Proxy->>Proxy: Extract domain bitmask (e.g. gateway=0x0F)
            else API Key Provided
                Proxy->>Proxy: Compute SHA-256 hash & check local LRU cache
            else No Auth Header
                Proxy-->>Client: 401 Unauthorized
            end
            
            Note over Proxy: Bitwise Check: (user_mask & req_mask) == req_mask
            alt Missing Required Bits
                Proxy-->>Client: 403 Forbidden (Missing permissions)
            end
        end
    end

    rect rgb(240, 255, 255)
        Note over Proxy,Target: Step 4: Reverse Proxy & Response Decoration
        Proxy->>Target: Forward Request (Stripped prefix, added proxy headers)
        Target-->>Proxy: Upstream Response (Status, Body, Headers)
        Proxy->>Proxy: Inject RateLimit-* & X-Runtime headers
        Proxy-->>Client: Decorated HTTP Response
    end
```

---

## Latency Budgets on Hot Path

| Pipeline Phase | Mechanism | Target Latency |
| :--- | :--- | :--- |
| **Route Lookup** | In-Memory `ArcSwap<RouteTable>` prefix tree | $< 5\,\mu\text{s}$ |
| **Rate Limit Check** | Redis connection pool + single atomic Lua `EVALSHA` | $0.2 - 0.6\,\text{ms}$ |
| **Auth Verification** | Local cryptographic JWT check or cached key hash | $< 25\,\mu\text{s}$ |
| **Bitwise RBAC Check** | Single CPU bitwise AND operation (`AND` + `CMP`) | $< 10\,\text{ns}$ |
| **Reverse Proxy I/O** | Hyper connection-pooled async client | Network bound ($< 1\,\text{ms}$ local) |
