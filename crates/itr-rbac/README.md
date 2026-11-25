# `itr-rbac` (`crates/itr-rbac`)

Zero-allocation, constant-time $O(1)$ 64-bit (`u64`) bitmask Role-Based Access Control (RBAC) evaluation engine in pure Rust. Specified in [ADR-0003](../../specs/adr/0003-bitwise-rbac-matrix.md).

---

## Features

- **Zero Heap Allocations**: Wraps a `Copy` `u64` tuple struct (`PermissionMask(pub u64)`).
- **`const fn` Evaluation**: Bitwise `has_permission`, `missing_permissions`, `union`, `intersect`, and `remove` execute in a single CPU instruction (`#[inline(always)]`).
- **Optional `serde` Support**: Enable the `serde` feature flag for JSON/wire serialization.

---

## Usage

```rust
use itr_rbac::PermissionMask;

const PERM_READ: PermissionMask = PermissionMask::from_shift(0);
const PERM_WRITE: PermissionMask = PermissionMask::from_shift(1);
const PERM_ADMIN: PermissionMask = PermissionMask::from_shift(3);

let editor = PERM_READ.union(PERM_WRITE);
assert!(editor.has_permission(PERM_READ));
assert!(editor.verify(PERM_ADMIN).is_err());
```

---

## Running Tests

```bash
cargo test -p itr-rbac
```
