# Architecture Services (`services/`)

This directory contains standalone, production-grade backend system reference implementations.

Every service contains:
- `README.md` — Scope, architectural trade-offs, and local setup instructions.
- `DESIGN.md` — Deep dive into data flow, failure modes, and scaling bottlenecks.
- Decoupled implementations (e.g. `data-plane/` in Rust and `control-plane/` in TypeScript).

---

## Service Index

| Service | Architecture Domain | Description | Status |
| :--- | :--- | :--- | :--- |
| **`services/rate-limiter`** | Core Infrastructure | Standalone HTTP Rate Limiter with continuous Token Bucket, atomic Redis Lua script, and IETF headers. | Active |
| **`services/cache-engine`** | Data & Storage | High-performance In-Memory LRU Cache Microservice with TTL expiration and hit-ratio telemetry. | Active |
| **`services/load-balancer`** | Core Infrastructure | HTTP Reverse Proxy & Load Balancer with dynamic Round-Robin, Least-Connections, and Active Health Checking. | Active |
| **`services/gateway`** | Core Infrastructure | Unified Production API Gateway integrating Rate Limiting, Bitwise RBAC, In-Memory Caching, and Load Balancing. | Active |
| **`services/websocket-gateway`** | Real-Time & Messaging | High-performance WebSocket Gateway with room channels, heartbeat zombie watchdog, and clustered Redis Pub/Sub fan-out. | Active |
