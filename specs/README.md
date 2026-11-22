# System Architecture Specifications (`specs/`)

This directory houses all **language-agnostic blueprints, contracts, decision records, and topology diagrams** for architectures cataloged in this repository.

Every production architecture adheres to the repository's core tenet: **Blueprints before implementation**. Code is only written once the corresponding ADRs, data contracts, and diagrams have been defined and accepted.

---

## Directory Hierarchy

```text
specs/
├── adr/              # Architecture Decision Records (RFC-style historical records)
│   ├── 0000-template.md
│   ├── 0001-polyglot-monorepo-foundation.md
│   ├── 0002-api-gateway-data-control-split.md
│   ├── 0003-bitwise-rbac-matrix.md
│   └── 0004-distributed-token-bucket-rate-limiting.md
├── contracts/        # Canonical API schemas and RPC contracts (Protobuf & OpenAPI)
│   ├── buf.yaml
│   ├── buf.gen.yaml
│   ├── auth/v1/
│   │   └── permissions.proto
│   └── gateway/v1/
│       └── routes.proto
└── diagrams/         # Visual topology and sequence flows (Mermaid in Markdown)
    ├── architecture-topology.md
    └── gateway-hot-path.md
```

---

## Standards & Conventions

### 1. Architecture Decision Records (`adr/`)
- All architectural decisions are documented in sequential, immutable markdown files formatted using `0000-template.md`.
- Status values: `Proposed`, `Accepted`, `Superseded`, `Deprecated`.
- Once `Accepted`, the record remains as an immutable history of technical trade-offs.

### 2. Service Contracts (`contracts/`)
- Inter-service RPCs, message envelopes, and shared data entities are defined in **Protobuf 3** managed via the **Buf CLI**.
- Contracts are linted using `pnpm buf:lint` and compiled to TypeScript (`@intheruntime/contracts`) and Rust (`itr-contracts`) using `pnpm buf:generate`.
- Public HTTP surfaces are documented via OpenAPI v3 specifications.

### 3. Diagramming (`diagrams/`)
- All topology graphs, state machines, and sequence interactions are expressed as native **Mermaid.js** blocks embedded directly in Markdown files.
- This ensures zero external rendering dependencies and instant rendering in GitHub, GitLab, and IDE Markdown previews.
