# [ADR-0003] Bitwise RBAC Matrix for Zero-Allocation Edge Authorization

- **Status**: Accepted
- **Date**: 2026-11-22
- **Authors**: InTheRuntime Team
- **Deciders**: Repository Maintainers

---

## Context and Problem Statement

Traditional Role-Based Access Control (RBAC) often requires parsing complex permission strings (e.g., `["users:read", "billing:invoice:create"]`) or performing multiple database joins on every inbound request. On a high-throughput API gateway processing tens of thousands of requests per second, string parsing and heap allocations introduce CPU bottlenecks and latency jitter.

---

## Decision Drivers

1. **Constant-Time Verification**: Authorization checks must complete in $O(1)$ time with zero memory allocations on the hot path.
2. **Compact Token Payloads**: Authorization scopes embedded in JWTs or session tokens must remain tiny.
3. **Database Efficiency**: Permissions and roles must map directly to native integer columns in relational databases.

---

## Decision Outcome

We adopt a **64-bit Unsigned Integer (`u64` / `BigInt`) Bitmask Matrix** evaluated per resource domain:

1. **Granular Permissions as Bits**:
   Each action in a resource domain is assigned a single bit power of two ($1 \ll 0, 1 \ll 1, \dots, 1 \ll 63$):
   - `READ_METRICS` = $1 \ll 0$ (`0x01`)
   - `CREATE_ROUTE` = $1 \ll 1$ (`0x02`)
   - `UPDATE_ROUTE` = $1 \ll 2$ (`0x04`)
   - `DELETE_ROUTE` = $1 \ll 3$ (`0x08`)

2. **Roles as Bitmask Aggregates**:
   Roles are bitwise OR combinations of permissions:
   $$\text{ROLE\_ADMIN} = \text{READ} \mid \text{CREATE} \mid \text{UPDATE} \mid \text{DELETE}$$

3. **O(1) Authorization Check**:
   The gateway verifies authorization using a single CPU bitwise AND operation:
   $$\text{is\_authorized} = (\text{user\_mask} \ \& \ \text{required\_mask}) == \text{required\_mask}$$

4. **Multi-Domain Support**:
   When permissions span distinct domains (e.g., `gateway`, `billing`, `analytics`), tokens carry a domain-keyed map of bitmasks:
   ```json
   {
     "sub": "usr_9981",
     "perms": {
       "gateway": "0x000000000000000F",
       "billing": "0x0000000000000001"
     }
   }
   ```

---

## Consequences

### Positive
- Bitwise check compiles to 1–2 CPU assembly instructions (`AND` / `CMP`). Zero heap allocations.
- Extremely compact serialization (hex string or 64-bit integer in JWT claims).
- Fully compatible with database native `BIGINT` columns and bitwise SQL operators (`&`, `|`).

### Trade-offs & Mitigations
- Maximum of 64 granular operations per individual resource domain.
- *Mitigation*: 64 operations is more than sufficient for fine-grained resource actions; additional scopes are namespaced into distinct domain keys.
