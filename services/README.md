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
| **`services/gateway`** | Core Infrastructure | High-performance API Gateway featuring Bitwise RBAC, Token Bucket Rate Limiting, and Decoupled Control Plane. | Planned |
