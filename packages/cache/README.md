# `@intheruntime/cache` (`packages/cache`)

An in-memory Least Recently Used (LRU) cache engine delivering strict $O(1)$ reads, writes, promotions, and evictions with per-entry Time-To-Live (TTL) expiration and telemetry.

Used directly by [`services/cache-engine`](../../services/cache-engine/README.md) and [`services/gateway`](../../services/gateway/README.md).

---

## Architecture Overview

- **Hash Map (`Map<K, CacheNode<K, V>>`)**: $O(1)$ direct node lookup by key.
- **Doubly Linked List (`head` MRU to `tail` LRU)**: $O(1)$ detachment, head promotion on access, and tail eviction on capacity overflow.
- **Hybrid Expiration**:
  - **Lazy expiration** during `get()` and `has()` checks avoids background timer churn on expired keys.
  - **Active sweep** via `purgeExpired()` reclaims memory on demand.

---

## API Usage

```ts
import { LruCache } from "@intheruntime/cache";

const cache = new LruCache<string, { role: string }>({
  capacity: 1000,
  defaultTtlMs: 30_000,
});

cache.set("session:42", { role: "admin" });
cache.set("session:99", { role: "viewer" }, 5_000); // Custom 5s TTL

const user = cache.get("session:42"); // Promotes node to MRU head
const stats = cache.getStats();       // { size, capacity, hits, misses, evictions, expirations, hitRatio }
```

### Methods

- `get(key)`: Returns value in $O(1)$ and moves node to MRU head, or purges if expired.
- `set(key, value, ttlMs?)`: Inserts or updates entry in $O(1)$, evicting the LRU tail if `size > capacity`.
- `has(key)`: Checks unexpired presence in $O(1)$ without promoting recency.
- `delete(key)`: Unlinks node and removes entry in $O(1)$.
- `purgeExpired()`: Actively sweeps all expired entries and returns the count purged.
- `getStats()` / `clear()` / `size`.

---

## Commands

```bash
pnpm --filter @intheruntime/cache build
pnpm --filter @intheruntime/cache test
```
