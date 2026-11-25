# `@intheruntime/rbac` (`packages/rbac`)

Constant-time $O(1)$ Role-Based Access Control (RBAC) engine using 64-bit `BigInt` permission bitmasks. Paired with the Rust crate [`itr-rbac`](../../crates/itr-rbac/README.md) and specified in [ADR-0003](../../specs/adr/0003-bitwise-rbac-matrix.md).

Used by [`services/gateway`](../../services/gateway/README.md) for zero-database edge authorization checks.

---

## Core Mechanism

Up to 64 granular permissions map to single bit positions (`0..63`) in an unsigned 64-bit integer mask:

- **Permission Check ($O(1)$)**: `(userMask & requiredMask) === requiredMask`
- **Role Composition ($O(1)$)**: `roleA.union(roleB)` via bitwise `OR` (`|`)
- **Missing Permissions ($O(1)$)**: `requiredMask & ~userMask`

---

## API Usage

```ts
import { PermissionMask } from "@intheruntime/rbac";

const PERM_READ = PermissionMask.fromShift(0);   // 0x0000000000000001
const PERM_WRITE = PermissionMask.fromShift(1);  // 0x0000000000000002
const PERM_ADMIN = PermissionMask.fromShift(3);  // 0x0000000000000008

const editorRole = PERM_READ.union(PERM_WRITE);

editorRole.hasPermission(PERM_READ); // true
editorRole.hasPermission(PERM_ADMIN); // false

// Throws descriptive hex error if any required bits are missing
editorRole.verify(PERM_READ.union(PERM_ADMIN));
```

---

## Commands

```bash
pnpm --filter @intheruntime/rbac build
pnpm --filter @intheruntime/rbac check
```
