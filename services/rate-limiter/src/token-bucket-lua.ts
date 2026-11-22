/**
 * Atomic Token Bucket Lua Script for Redis.
 *
 * Keys:
 *   KEYS[1]: Rate limit hash key (e.g. "rl:{bucket_id}")
 * Arguments:
 *   ARGV[1]: Maximum burst capacity (e.g. 10)
 *   ARGV[2]: Refill rate in tokens per second (e.g. 2.0)
 *   ARGV[3]: Token cost for this request (e.g. 1)
 *   ARGV[4]: Current timestamp in seconds (e.g. 1700000000.5)
 *
 * Returns:
 *   [allowed (1 or 0), remaining, reset_after_secs, retry_after_secs]
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

-- Retrieve current state: [tokens, last_updated]
local data = redis.call("HMGET", key, "tokens", "last_updated")
local tokens = tonumber(data[1])
local last_updated = tonumber(data[2])

if not tokens or not last_updated then
    -- Cold start: initialize bucket at full burst capacity
    tokens = capacity
    last_updated = now
else
    -- Continuous refill based on elapsed time: delta * refill_rate
    local delta = math.max(0, now - last_updated)
    tokens = math.min(capacity, tokens + (delta * refill_rate))
    last_updated = now
end

local allowed = 0
local remaining = 0
local reset_after = 0
local retry_after = 0

if tokens >= cost then
    -- Allowed: deduct cost
    allowed = 1
    tokens = tokens - cost
    remaining = math.floor(tokens)
    reset_after = math.ceil((capacity - tokens) / refill_rate)
    retry_after = 0
else
    -- Rejected: bucket empty
    allowed = 0
    remaining = 0
    reset_after = math.ceil((capacity - tokens) / refill_rate)
    retry_after = math.ceil((cost - tokens) / refill_rate)
end

-- Save updated state
redis.call("HMSET", key, "tokens", tokens, "last_updated", last_updated)

-- Auto-expire after full refill duration to prevent key accumulation
local ttl = math.ceil((capacity / refill_rate) * 2)
redis.call("EXPIRE", key, math.max(60, ttl))

return { allowed, remaining, reset_after, retry_after }
`;
