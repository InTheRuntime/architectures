# TypeScript Shared Packages (`packages/`)

This directory contains reusable TypeScript workspace libraries published internally under the `@intheruntime/*` namespace.

---

## Package Index

| Package | Path | Status | Description | Docs |
| :--- | :--- | :--- | :--- | :--- |
| **`@intheruntime/cache`** | `packages/cache` | Active | $O(1)$ In-Memory LRU Cache (Hash Map + Doubly Linked List) with lazy TTL expiration and hit-ratio telemetry. | [README](./cache/README.md) |
| **`@intheruntime/rbac`** | `packages/rbac` | Active | 64-bit `BigInt` bitmask matrix manipulation, role aggregation, and constant-time permission checks. | [README](./rbac/README.md) |
| **`@intheruntime/contracts`** | `packages/contracts` | Planned | TypeScript client/server bindings generated from `specs/contracts/` via `buf`. | - |
| **`@intheruntime/config`** | `packages/config` | Planned | Shared TypeScript configuration presets (`tsconfig`, Biome presets). | - |
