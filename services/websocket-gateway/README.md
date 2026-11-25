# WebSocket Gateway Service (`services/websocket-gateway`)

A production-minded WebSocket Gateway featuring **persistent bi-directional communication**, **room channel multiplexing**, **active heartbeat zombie detection**, and **clustered Pub/Sub backplane scaling**.

---

## Features

- **Ultra-Low Latency**: Bi-directional messaging with $< 5\text{ms}$ delivery overhead.
- **Room & Channel Multiplexing**: Publish-subscribe room isolation (`join_room`, `leave_room`, `send_message`).
- **Clustered Multi-Node Fan-Out**: Backplane pub/sub synchronization (Redis or in-memory hub) for seamless horizontal scaling across gateway instances.
- **Ephemeral Presence & Roster Sync**: Sliding-window heartbeat leases (Redis Sorted Sets) maintain active online member lists with zero ghost-user leakage.
- **Ephemeral Typing Indicators**: High-frequency typing notifications with 3-second auto-expiration without requiring explicit "stopped typing" packets.
- **Disconnect Replay Buffers**: Ring buffers (in-memory) & Redis Streams track monotonic sequence IDs per room to replay missed messages after network disconnects.
- **Dynamic Topic Ref-Counting**: Gateway nodes dynamically subscribe to broker channels only when local clients exist, eliminating cluster broadcast storms.
- **Zombie Connection Scavenger**: Heartbeat `ping`/`pong` watchdog automatically detects dead sockets and terminates orphaned connections.
- **Live Telemetry & Diagnostics**: Exposes `GET /stats` and `GET /health` with cluster node state and channel subscriptions.

---

## Quickstart

### 1. Start a Single Gateway (Standalone Mode)

```bash
# Starts in standalone mode with an in-memory pub/sub adapter:
pnpm --filter @intheruntime/service-websocket-gateway start
```
*Listens on `ws://localhost:8083` and `http://localhost:8083`.*

---

### 2. Run a Multi-Node Cluster with Redis Backplane

Run multiple instances connected to a shared Redis broker:

```bash
# Node 1 on port 8083
PORT=8083 NODE_ID=gateway-1 REDIS_URL=redis://localhost:6379 pnpm --filter @intheruntime/service-websocket-gateway start

# Node 2 on port 8084
PORT=8084 NODE_ID=gateway-2 REDIS_URL=redis://localhost:6379 pnpm --filter @intheruntime/service-websocket-gateway start
```

When Client A connects to Node 1 (`ws://localhost:8083`) and Client B connects to Node 2 (`ws://localhost:8084`):
- Both clients join room `crypto-feed`.
- Client A publishes a price tick to Node 1.
- Node 1 delivers locally and publishes to Redis `ws:cluster:room:crypto-feed`.
- Node 2 receives the Redis broadcast and instantly forwards the message to Client B!

---

## Client Protocol Guide

Connect any standard WebSocket client (browser, Node.js, Python, or CLI tools like `wscat`):

```bash
# Using wscat:
npx wscat -c ws://localhost:8083
```

### 1. Join a Room with User Identity
Send:
```json
{ "type": "join_room", "room": "engineering", "user_id": "alice" }
```
Receive:
```json
{ "type": "joined", "room": "engineering" }
{ "type": "presence_sync", "room": "engineering", "users": ["alice", "bob"] }
```
All existing peers in `engineering` receive:
```json
{ "type": "user_joined", "room": "engineering", "user_id": "alice" }
```

### 2. Broadcast a Message to the Room
Send:
```json
{
  "type": "send_message",
  "room": "engineering",
  "payload": { "text": "Deployment to staging complete!" }
}
```
All other clients in room `engineering` (across **all** cluster nodes) instantly receive:
```json
{
  "type": "message",
  "room": "engineering",
  "sender": "conn_9a81b2c4",
  "payload": { "text": "Deployment to staging complete!" },
  "timestamp_ms": 1732450000000,
  "seq": 42
}
```

### 3. Reconnect & Catch Up on Missed Messages
If a client temporarily disconnects (e.g. mobile elevator drop), reconnect with the last sequence offset received:
Send:
```json
{
  "type": "join_room",
  "room": "engineering",
  "user_id": "alice",
  "last_received_seq": 42
}
```
Receive immediate replay of all missed frames in sequence:
```json
{
  "type": "replay_messages",
  "room": "engineering",
  "messages": [
    { "seq": 43, "sender": "conn_1", "payload": "...", "timestamp_ms": 1732450001000 },
    { "seq": 44, "sender": "conn_2", "payload": "...", "timestamp_ms": 1732450002000 }
  ],
  "current_seq": 44
}
```

### 4. Ephemeral Typing Indicator
Send:
```json
{ "type": "typing", "room": "engineering", "is_typing": true }
```
All peers in room receive:
```json
{ "type": "user_typing", "room": "engineering", "user_id": "alice", "is_typing": true }
```
*(Auto-expires on peers after 3 seconds if no further typing events are received).*

### 4. Check Gateway & Cluster Observability (via HTTP)
```bash
curl http://localhost:8083/stats
```
Response:
```json
{
  "node_id": "gateway-1",
  "local_connections": 142,
  "local_rooms": 2,
  "cluster_subscribed_rooms": ["engineering", "crypto-feed"],
  "rooms": [
    { "name": "engineering", "local_subscribers": 8 },
    { "name": "crypto-feed", "local_subscribers": 134 }
  ]
}
```
