# architectures

A polyglot monorepo of reusable system architecture blueprints, specifications, and reference implementations maintained by **InTheRuntime**.

This repository is a growing catalog of production-minded system designs—covering everything from real-time communication and media pipelines to storage engines, distributed workflows, AI orchestration, and core backend infrastructure.

## Core Principles

- **Blueprints before implementation:** Every architecture starts with language-agnostic specs—diagrams (`Mermaid`/`D2`), service contracts (`Protobuf`/`OpenAPI`), and Architecture Decision Records (`ADRs`)—before any code is written.
- **Polyglot by design:** Use the right language for the layer. **TypeScript** for control planes, APIs, and clients; **Rust** (or other systems languages where needed) for high-concurrency networking, streaming I/O, and compute-heavy engines.
- **Modular & composable:** Every architecture lives as an independent, self-contained unit with clear boundaries so it can be studied, benchmarked, or dropped into real projects.

## Repository Structure

```text
architectures/
├── specs/                  # Language-agnostic blueprints & standards
│   ├── adr/                # Architecture Decision Records
│   ├── contracts/          # Shared Protobuf (.proto) & OpenAPI schemas
│   └── diagrams/           # System topologies & sequence diagrams
├── services/               # Standalone backend system implementations
├── apps/                   # Reference clients, demos, and test harnesses
├── packages/               # Shared TypeScript packages (types, utilities, UI)
├── crates/                 # Shared Rust crates (auth, errors, telemetry)
├── Cargo.toml              # Rust workspace root
└── pnpm-workspace.yaml     # pnpm workspace root
```

## Architecture Domains

*This catalog expands continuously as new systems are designed and implemented.*

| Domain | Examples | Status |
| :--- | :--- | :--- |
| **Real-Time & Messaging** | WebSocket gateways, pub/sub fan-out, presence, delivery guarantees | Planned |
| **Media & Streaming** | Chunked/resumable file uploads, adaptive video streaming (HLS/DASH), WebRTC | Planned |
| **Data & Storage** | Distributed caching, search indexing, event sourcing, storage engines | Planned |
| **Core Infrastructure** | API gateways, rate limiters, job queues, auth & bitwise RBAC | Planned |
| **AI & Automation** | Agent execution harnesses, RAG pipelines, async workflow engines | Planned |

## Standard Module Layout

Every system under `services/` follows the same structure:

- `README.md` — Scope, trade-offs, and local setup instructions
- `DESIGN.md` — Data flow, failure modes, and scaling bottlenecks
- `src/` — Reference implementation and tests

## Getting Started

### Prerequisites

- **Node.js** `>= 22` and **pnpm** `>= 9`
- **Rust** (stable toolchain via `rustup`)
- **Docker** (for local databases, queues, and object storage)

### Setup

```bash
git clone [https://github.com/InTheRuntime/architectures.git](https://github.com/InTheRuntime/architectures.git)
cd architectures

# Install TypeScript workspace dependencies
pnpm install

# Verify the Rust workspace compiles
cargo check --workspace
```

## Contributing

1. Open an issue or add a draft ADR in `specs/adr/` before proposing a new architecture.
2. Keep services decoupled—cross-service communication should go through `specs/contracts/`.
3. Run workspace checks (`pnpm lint`, `cargo clippy --workspace`) before opening a PR.

## License

The Complete Project is Licensed under [MIT](./LICENSE).
