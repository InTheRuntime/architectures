# System Architecture Specifications (`specs/`)

This directory houses all **language-agnostic blueprints, contracts, decision records, and topology diagrams** for architectures cataloged in this repository.

Every production architecture adheres to the repository's core tenet: **Blueprints before implementation**. Design decisions, data contracts, and diagrams are defined here alongside reference implementations.

---

## Directory Hierarchy

```text
specs/
├── adr/                  # Architecture Decision Records
│   ├── 0000-template.md
│   ├── 0001-polyglot-monorepo-foundation.md
│   ├── 0002-api-gateway-data-control-split.md
│   ├── 0003-bitwise-rbac-matrix.md
│   ├── 0004-distributed-token-bucket-rate-limiting.md
│   ├── 0005-lsm-tree-storage-engine.md
│   └── 0006-sstable-bloom-filters.md
├── contracts/            # Canonical Protobuf schemas managed with Buf
│   ├── buf.yaml
│   ├── buf.gen.yaml
│   ├── auth/v1/
│   │   └── permissions.proto
│   └── gateway/v1/
│       └── routes.proto
└── diagrams/             # Visual topology and hot-path sequence flows (Mermaid)
    ├── architecture-topology.md
    └── gateway-hot-path.md
```

---

## Architecture Decision Records (`adr/`)

| ID | Title | Domain | Status |
| :--- | :--- | :--- | :--- |
| [ADR-0001](./adr/0001-polyglot-monorepo-foundation.md) | Polyglot Monorepo Foundation | Platform | Accepted |
| [ADR-0002](./adr/0002-api-gateway-data-control-split.md) | API Gateway Data/Control Split | Core Infrastructure | Accepted |
| [ADR-0003](./adr/0003-bitwise-rbac-matrix.md) | Bitwise RBAC Matrix | Core Infrastructure | Accepted |
| [ADR-0004](./adr/0004-distributed-token-bucket-rate-limiting.md) | Distributed Token Bucket Rate Limiting | Core Infrastructure | Accepted |
| [ADR-0005](./adr/0005-lsm-tree-storage-engine.md) | Log-Structured Merge-Tree (LSM-Tree) Storage Engine | Data & Storage | Accepted |
| [ADR-0006](./adr/0006-sstable-bloom-filters.md) | Probabilistic Bloom Filters for SSTables | Data & Storage | Accepted |

---

## Standards & Conventions

### 1. Architecture Decision Records (`adr/`)
- Sequential, immutable markdown files formatted using [`0000-template.md`](./adr/0000-template.md).
- Status values: `Proposed`, `Accepted`, `Superseded`, `Deprecated`.

### 2. Service Contracts (`contracts/`)
- Inter-service RPCs and shared entities are defined in **Protobuf 3** managed via the **Buf CLI**.
- Lint schemas with `pnpm buf:lint` and generate bindings with `pnpm buf:generate`.

### 3. Diagramming (`diagrams/`)
- System topologies, state machines, and sequence interactions use native **Mermaid** code blocks embedded directly in Markdown.
