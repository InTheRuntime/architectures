# Rust Crates (`crates/`)

This directory houses Rust systems libraries prefixed with `itr-*`.

---

## Crate Index

| Crate | Path | Cargo Workspace Member | Status | Description | Docs |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`itr-lsm`** | `crates/itr-lsm` | Yes | Active | Pure-Rust Log-Structured Merge-Tree (LSM-Tree) disk engine with CRC32 WAL, `BTreeMap` MemTable, sparse-indexed v2 SSTables, Bloom filters, and compaction. | [README](./itr-lsm/README.md), [DESIGN](./itr-lsm/DESIGN.md) |
| **`itr-rbac`** | `crates/itr-rbac` | Yes | Active | Zero-allocation $O(1)$ 64-bit (`u64`) bitmask permission evaluation engine. | [README](./itr-rbac/README.md) |
| **`itr-ratelimit`** | `crates/itr-ratelimit` | No (Draft) | Draft | Redis Lua and `DashMap` Token Bucket rate limiting library with IETF header calculations. Excluded from root `Cargo.toml` members on Windows GNU toolchains without native C build tools. | [README](./itr-ratelimit/README.md) |
| **`itr-contracts`** | `crates/itr-contracts` | No | Planned | Rust types and `prost`/`tonic` bindings generated from `specs/contracts/`. | - |
