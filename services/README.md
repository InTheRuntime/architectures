# Architecture Services (`services/`)

This directory contains standalone, runnable backend system reference implementations.

Each service includes:
- `README.md` — Scope, quickstart commands, API/protocol recipes, and telemetry examples.
- `DESIGN.md` — Deep dive into data flow, algorithms, failure modes, and scaling trade-offs.
- `src/` and `test/` — Implementation and automated test suite.

---

## Service Index

| Service | Domain | Port | Description | Status | Docs |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`services/gateway`** | Core Infrastructure | `8000` | Unified Production API Gateway integrating Rate Limiting, Bitwise RBAC, In-Memory Caching, and Load Balancing. | Active | [README](./gateway/README.md), [DESIGN](./gateway/DESIGN.md) |
| **`services/load-balancer`** | Core Infrastructure | `8080` | HTTP Reverse Proxy & Load Balancer with Round-Robin, Least-Connections, and Active Health Checking. | Active | [README](./load-balancer/README.md), [DESIGN](./load-balancer/DESIGN.md) |
| **`services/rate-limiter`** | Core Infrastructure | `8081` | Standalone HTTP Rate Limiter with continuous Token Bucket, atomic Redis Lua script, and IETF headers. | Active | [README](./rate-limiter/README.md), [DESIGN](./rate-limiter/DESIGN.md) |
| **`services/cache-engine`** | Data & Storage | `8082` | High-performance In-Memory LRU Cache Microservice with TTL expiration and hit-ratio telemetry. | Active | [README](./cache-engine/README.md), [DESIGN](./cache-engine/DESIGN.md) |
| **`services/websocket-gateway`** | Real-Time & Messaging | `8083` | Clustered WebSocket Gateway with rooms, zombie heartbeat watchdog, Redis Pub/Sub fan-out, sliding-window presence, and stream replay buffers. | Active | [README](./websocket-gateway/README.md), [DESIGN](./websocket-gateway/DESIGN.md) |
