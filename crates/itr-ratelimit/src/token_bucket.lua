-- token_bucket.lua
-- Atomic Token Bucket Rate Limiter for Redis
-- Keys:
--   KEYS[1]: Rate limit state key (e.g., "rl:{bucket_id}")
-- Arguments:
--   ARGV[1]: Max bucket capacity (burst limit, e.g. 10)
--   ARGV[2]: Refill rate per second (tokens/sec, e.g. 2.0)
--   ARGV[3]: Cost in tokens for this request (usually 1)
--   ARGV[4]: Current Unix timestamp in seconds (floating point or integer, e.g. 1700000000.5)

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

-- Retrieve current bucket state: [tokens, last_updated]
local data = redis.call("HMGET", key, "tokens", "last_updated")
local tokens = tonumber(data[1])
local last_updated = tonumber(data[2])

if not tokens or not last_updated then
    -- Cold start: First request initializes the bucket at full capacity
    tokens = capacity
    last_updated = now
else
    -- Compute continuous fractional refill based on elapsed time
    local delta = math.max(0, now - last_updated)
    tokens = math.min(capacity, tokens + (delta * refill_rate))
    last_updated = now
end

local allowed = 0
local remaining = 0
local reset_after = 0
local retry_after = 0

if tokens >= cost then
    -- Request is allowed: deduct cost
    allowed = 1
    tokens = tokens - cost
    remaining = math.floor(tokens)
    -- Seconds until fully refilled to capacity
    reset_after = math.ceil((capacity - tokens) / refill_rate)
    retry_after = 0
else
    -- Request is rejected: tokens remain unchanged
    allowed = 0
    remaining = 0
    -- Seconds until fully refilled to capacity
    reset_after = math.ceil((capacity - tokens) / refill_rate)
    -- Seconds until at least 'cost' tokens are available
    retry_after = math.ceil((cost - tokens) / refill_rate)
end

-- Save state back to Redis
redis.call("HMSET", key, "tokens", tokens, "last_updated", last_updated)

-- Auto-expire key after bucket has had time to fully refill (plus safety buffer)
local ttl = math.ceil((capacity / refill_rate) * 2)
redis.call("EXPIRE", key, math.max(60, ttl))

-- Return array: [allowed (0 or 1), remaining, reset_after, retry_after]
return { allowed, remaining, reset_after, retry_after }
