# architectures

A polyglot monorepo of reusable system architecture blueprints, Architecture Decision Records (ADRs), and production-minded reference implementations maintained by **InTheRuntime**.

---

## Core Principles

1. **Blueprints Before Implementation**: Major systems begin as language-agnostic ADRs in `specs/adr/`, topology diagrams in `specs/diagrams/`, and contracts in `specs/contracts/` before production code is written.
2. **Polyglot by Design**: Match the runtime to the problem. **Rust** for zero-allocation hot paths and disk storage engines (`itr-rbac`, `itr-lsm`); **TypeScript** (Node.js / Hono / `ws`) for control planes, reverse proxies, caches, and clustered real-time gateways.
3. **Modular & Composable**: Each crate, package, and service owns a clean boundary, its own `DESIGN.md` (trade-offs, math, failure modes) and `README.md` (quickstart & usage), and an automated test suite.

---

## Architecture Catalog

### Domain 1: Core Infrastructure & API Gateway

| Level | Component | Path | Language | Description |
| :--- | :--- | :--- | :--- | :--- |
| Level 0 | Bitwise RBAC Engine | [`crates/itr-rbac`](./crates/itr-rbac/README.md), [`packages/rbac`](./packages/rbac/README.md) | Rust, TypeScript | Constant-time $O(1)$ 64-bit permission bitmask verification ([ADR-0003](./specs/adr/0003-bitwise-rbac-matrix.md)). |
| Level 1 | Distributed Rate Limiter | [`services/rate-limiter`](./services/rate-limiter/README.md) | TypeScript, Rust (draft) | Continuous Token Bucket with atomic Redis Lua script, in-memory fallback, and IETF `RateLimit-*` headers ([ADR-0004](./specs/adr/0004-distributed-token-bucket-rate-limiting.md)). |
| Level 3 | Reverse Proxy & Load Balancer | [`services/load-balancer`](./services/load-balancer/README.md) | TypeScript | Round-Robin & Least-Connections pooling, active background health checking, and dynamic admin pool API. |
| Crown Jewel | Unified Production API Gateway | [`services/gateway`](./services/gateway/README.md) | TypeScript | Full ingress pipeline chaining Rate Limiting, Bitwise RBAC, In-Memory LRU Caching, and Upstream Load Balancing ([ADR-0002](./specs/adr/0002-api-gateway-data-control-split.md)). |

### Domain 2: Real-Time & Messaging

| Level | Component | Path | Language | Description |
| :--- | :--- | :--- | :--- | :--- |
| Levels 1-4 | Clustered WebSocket Gateway | [`services/websocket-gateway`](./services/websocket-gateway/README.md) | TypeScript | Room multiplexing, ping/pong zombie watchdog (L1); Redis Pub/Sub cross-node fan-out with dynamic ref-counting (L2); sliding-window presence & typing indicators (L3); monotonic sequence replay buffers (L4). |

### Domain 3: Data & Storage Engines

| Level | Component | Path | Language | Description |
| :--- | :--- | :--- | :--- | :--- |
| Gateway L2 | In-Memory LRU Cache | [`packages/cache`](./packages/cache/README.md), [`services/cache-engine`](./services/cache-engine/README.md) | TypeScript | $O(1)$ Hash Map + Doubly Linked List cache with lazy TTL expiration and HTTP microservice wrapper. |
| Level 0-1 | LSM-Tree Disk Storage Engine | [`crates/itr-lsm`](./crates/itr-lsm/README.md) | Rust | CRC32 Write-Ahead Log with torn-tail recovery, sorted `BTreeMap` MemTable, sparse-indexed v2 SSTables with Kirsch-Mitzenmacher Bloom filters, range scans, and compaction ([ADR-0005](./specs/adr/0005-lsm-tree-storage-engine.md), [ADR-0006](./specs/adr/0006-sstable-bloom-filters.md)). |

### Planned Domains

- **Media & Streaming**: Chunked/resumable uploads, adaptive HLS/DASH transcoding pipelines, WebRTC signaling.
- **AI & Automation**: Agent execution harnesses, RAG indexing pipelines, durable async workflow engines.

---

## Repository Structure

```text
architectures/
├── specs/                        # Language-agnostic blueprints, ADRs, Protobuf & Mermaid diagrams
│   ├── adr/                      # Architecture Decision Records (0000..0006)
│   ├── contracts/                # Canonical Protobuf (.proto) contracts & Buf config
│   └── diagrams/                 # System topology & request flow diagrams
├── services/                     # Runnable HTTP & WebSocket backend services
│   ├── gateway/                  # Port 8000 - Unified API Gateway
│   ├── load-balancer/            # Port 8080 - Reverse Proxy & Load Balancer
│   ├── rate-limiter/             # Port 8081 - Token Bucket Rate Limiter
│   ├── cache-engine/             # Port 8082 - In-Memory LRU Cache Service
│   └── websocket-gateway/        # Port 8083 - Clustered WebSocket Gateway
├── packages/                     # Shared TypeScript workspace libraries (@intheruntime/*)
│   ├── cache/                    # @intheruntime/cache
│   └── rbac/                     # @intheruntime/rbac
├── crates/                       # Rust libraries (itr-*)
│   ├── itr-lsm/                  # Active workspace crate - LSM-Tree storage engine
│   ├── itr-rbac/                 # Active workspace crate - 64-bit RBAC bitmask engine
│   └── itr-ratelimit/            # Draft crate (Redis Lua + DashMap)
├── Cargo.toml                    # Rust Cargo workspace root
├── pnpm-workspace.yaml           # pnpm workspace root
├── turbo.json                    # Turborepo task pipeline configuration
├── biome.json                    # TypeScript formatter & linter rules
├── docker-compose.yml            # Local Postgres 16, Redis 7, and mock HTTP upstream
└── CONTRIBUTING.md               # Contribution & ADR workflow guide
```

---

## Getting Started

### Prerequisites

- **Node.js** `>= 22` and **pnpm** `>= 9`
- **Rust** (stable toolchain via `rustup`)
- **Docker** (optional; required for local Redis/PostgreSQL integration)

### Installation & Verification

```bash
git clone https://github.com/InTheRuntime/architectures.git
cd architectures

# Install TypeScript workspace dependencies
pnpm install

# Build all TypeScript packages and services
pnpm build

# Run all TypeScript and Rust tests
pnpm test

# Lint and format checks across TypeScript and Rust
pnpm lint
cargo clippy --workspace --all-targets -- -D warnings
```

### Local Infrastructure (Docker)

[`docker-compose.yml`](./docker-compose.yml) provisions local backing services for integration testing:

| Container | Image | Port | Purpose |
| :--- | :--- | :--- | :--- |
| `architectures-postgres` | `postgres:16-alpine` | `5432` | Relational store (`postgres` / `postgrespassword`, DB: `architectures`) |
| `architectures-redis` | `redis:7-alpine` | `6379` | Token Bucket Lua store, WebSocket Pub/Sub backplane, Presence & Streams |
| `architectures-mock-upstream` | `mendhak/http-https-echo:34` | `8080` | HTTP echo upstream target for Load Balancer and API Gateway demos |

```bash
pnpm docker:up
pnpm docker:down
```

*Note: `services/load-balancer` and `docker-compose.yml`'s `mock-upstream` both default to port `8080`. Override `PORT` (e.g., `PORT=8090 pnpm --filter @intheruntime/service-load-balancer start`) when running both simultaneously on the host.*

### Service Port Map

| Service | Default Port | Start Command |
| :--- | :--- | :--- |
| Unified API Gateway | `8000` | `pnpm --filter @intheruntime/service-gateway start` |
| Reverse Proxy & Load Balancer | `8080` | `pnpm --filter @intheruntime/service-load-balancer start` |
| Distributed Rate Limiter | `8081` | `pnpm --filter @intheruntime/service-rate-limiter start` |
| In-Memory Cache Engine | `8082` | `pnpm --filter @intheruntime/service-cache-engine start` |
| Clustered WebSocket Gateway | `8083` | `pnpm --filter @intheruntime/service-websocket-gateway start` |

---

## Workspace Scripts

| Command | Description |
| :--- | :--- |
| `pnpm build` | Build all TypeScript workspaces via Turborepo |
| `pnpm test` | Execute all TypeScript unit/integration tests and `cargo test --workspace` |
| `pnpm check` | Type-check all TypeScript packages (`tsc --noEmit`) and run `cargo check --workspace` |
| `pnpm lint` | Run Biome checks across TypeScript/JSON files |
| `pnpm format` | Format workspace files with Biome |
| `pnpm clippy` | Run Cargo Clippy across workspace crates with warnings denied |
| `pnpm buf:lint` | Lint Protobuf definitions in `specs/contracts/` |
| `pnpm buf:generate` | Generate Protobuf bindings using Buf |

---

## Contributing & License

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the ADR-first design workflow, module structure requirements, and quality checks.

Licensed under [MIT](./LICENSE).
