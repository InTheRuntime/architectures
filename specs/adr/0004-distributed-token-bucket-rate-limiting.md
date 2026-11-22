# [ADR-0004] Distributed Token Bucket Rate Limiting with IETF Headers

- **Status**: Accepted
- **Date**: 2026-11-22
- **Authors**: InTheRuntime Team
- **Deciders**: Repository Maintainers

---

## Context and Problem Statement

To protect upstream backend services from cascading overload and enforce commercial API consumption quotas, the API Gateway requires a high-precision, low-latency rate limiting engine capable of operating across clustered gateway replicas.

We must prevent race conditions without introducing distributed lock contention, support multi-tiered quota keys (API Key, User ID, and IP), and return standardized response headers.

---

## Decision Drivers

1. **Clustered Consistency**: Accurate token depletion across multiple gateway instances.
2. **Zero Locking Contention**: Avoiding distributed locks that degrade throughput.
3. **Standardized Client Contract**: Conforming to modern IETF RateLimit specification.
4. **Local Developer Ergonomics**: Seamless local development without mandatory external dependencies.

---

## Decision Outcome

We adopt a **Redis Lua Distributed Token Bucket Engine** with a local in-memory fallback:

1. **Algorithm**:
   - Continuous Token Bucket with fractional refill based on elapsed time:
     $$\text{tokens} = \min(\text{capacity}, \ \text{current\_tokens} + \text{delta\_seconds} \times \text{refill\_rate})$$
   - Executed atomically in Redis via a preloaded Lua script in a single round-trip.

2. **Multi-Tier Resolution Precedence**:
   - Tier 1: **Authenticated API Key** (e.g. `rl:apikey:itr_live_...` -> 10,000 req/min)
   - Tier 2: **Authenticated User ID** (e.g. `rl:user:usr_...` -> 1,000 req/min)
   - Tier 3: **Anonymous Client IP** (e.g. `rl:ip:203.0.113.1` -> 60 req/min)

3. **Response Headers**:
   Conforms to modern IETF draft specifications alongside legacy compatibility headers:
   - `RateLimit-Limit`: Maximum tokens available in window.
   - `RateLimit-Remaining`: Remaining available tokens.
   - `RateLimit-Reset`: Seconds until bucket refills to capacity.
   - `Retry-After`: Returned with `429 Too Many Requests` when depleted.

4. **In-Memory Fallback**:
   An atomic in-memory implementation (`dashmap` + atomic integers) is provided for local unit tests and standalone development when Redis is disabled.

---

## Consequences

### Positive
- Sub-millisecond atomic rate evaluation without distributed locks.
- Seamless multi-tier customer quotas.
- Modern, transparent client feedback via standard headers.

### Trade-offs & Mitigations
- Redis latency on the hot path (~0.5ms).
- *Mitigation*: Redis connection pooling in Rust (`bb8` or `deadpool-redis`) and connection multiplexing over TCP keep-alive.
