# WebSocket Gateway Service (`services/websocket-gateway`)

A production-minded WebSocket Gateway featuring **persistent bi-directional communication**, **room channel multiplexing**, **active heartbeat zombie detection**, and **connection observability**.

---

## Features

- ⚡ **Ultra-Low Latency**: Bi-directional messaging with $< 5\text{ms}$ delivery overhead.
- 👥 **Room & Channel Multiplexing**: Publish-subscribe room isolation (`join_room`, `leave_room`, `send_message`).
- 🩺 **Zombie Connection Scavenger**: Heartbeat `ping`/`pong` watchdog automatically detects dead sockets and terminates orphaned connections.
- 📊 **Live Telemetry & Diagnostics**: Exposes `GET /stats` and `GET /health` over HTTP alongside WebSocket connections.

---

## Quickstart

### 1. Start the Gateway

```bash
# From repository root:
pnpm --filter @intheruntime/service-websocket-gateway start
```
*Listens on `ws://localhost:8083` and `http://localhost:8083`.*

---

## Client Protocol Guide

Connect any standard WebSocket client (browser, Node.js, Python, or CLI tools like `wscat`):

```bash
# Using wscat:
npx wscat -c ws://localhost:8083
```

### 1. Join a Room
Send:
```json
{ "type": "join_room", "room": "engineering" }
```
Receive:
```json
{ "type": "joined", "room": "engineering" }
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
All other clients in room `engineering` instantly receive:
```json
{
  "type": "message",
  "room": "engineering",
  "sender": "conn_9a81b2c4",
  "payload": { "text": "Deployment to staging complete!" },
  "timestamp_ms": 1732450000000
}
```

### 3. Check Gateway Observability (via HTTP)
```bash
curl http://localhost:8083/stats
```
Response:
```json
{
  "total_connections": 142,
  "total_rooms": 12,
  "rooms": [
    { "name": "engineering", "subscribers": 8 },
    { "name": "general", "subscribers": 134 }
  ]
}
```
