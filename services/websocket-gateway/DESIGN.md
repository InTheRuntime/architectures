# Architecture Design: WebSocket Gateway & Clustered Pub/Sub Backplane

- **Architecture Domain**: Real-Time & Messaging
- **System Layer**: Persistent Bi-Directional Transport & Clustered Fan-Out
- **Status**: Implemented & Tested
- **Package**: `@intheruntime/service-websocket-gateway`

---

## 1. System Overview & The Core Problem

HTTP is inherently request-driven: a client opens a connection, asks for data, and closes the connection. In applications requiring instant updates (chat, financial tick-by-tick tickers, live ride tracking, collaboration), HTTP polling produces catastrophic overhead:
- Periodic polling requests send 1KB+ HTTP headers repeatedly for empty payloads.
- High connection establishment latency ($3\text{x}$ TCP + TLS handshakes).
- Rapid battery and mobile bandwidth drain.

The **WebSocket Gateway** provides a persistent, full-duplex TCP channel over port 80/443:
- Messages travel in both directions with only a **2-byte framing overhead**.
- Latency drops from seconds to **sub-5-milliseconds**.
- Server can push events spontaneously to 100,000+ connected clients without waiting to be asked.

---

## 2. The Connection Handshake (101 Switching Protocols)

WebSockets piggyback on HTTP port 80/443 so they pass through firewalls and corporate proxies transparently:

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant Gateway as WebSocket Gateway<br/>(Port 8083)

    Client->>Gateway: GET /ws HTTP/1.1<br/>Upgrade: websocket<br/>Connection: Upgrade<br/>Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==<br/>Sec-WebSocket-Version: 13
    
    Note over Gateway: Gateway computes SHA-1 hash of key + GUID
    Gateway-->>Client: HTTP/1.1 101 Switching Protocols<br/>Upgrade: websocket<br/>Connection: Upgrade<br/>Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=

    Note over Client,Gateway: Connection is now upgraded to persistent binary/text TCP stream!
    Client->>Gateway: Frame 1: {"type": "join_room", "room": "lobby"}
    Gateway-->>Client: Frame 2: {"type": "joined", "room": "lobby"}
```

---

## 3. The "Zombie Connection" Problem & Heartbeat Protocol

### The TCP Half-Open Nightmare
In mobile networks, a client device often drives into a tunnel, switches from Wi-Fi to 5G, or runs out of battery. The client drops off the face of the earth **without sending a TCP FIN or RST packet**.
- The server believes the client is still connected.
- Default OS TCP keep-alive can take **up to 2 hours** to notice the connection is dead!
- Result: Servers accumulate tens of thousands of "ghost" sockets, leaking file descriptors and memory.

### The Heartbeat State Machine

```mermaid
stateDiagram-v2
    [*] --> ALIVE: Socket Connected (isAlive = true)

    ALIVE --> PROBING: Server sends PING (isAlive = false)
    PROBING --> ALIVE: Client responds with PONG (isAlive = true)
    PROBING --> TERMINATED: Next check arrives and isAlive is STILL false!

    TERMINATED --> [*]: socket.terminate() called.<br/>File descriptor and memory reclaimed!
```

1. Every 15 seconds, the Gateway sweeps all connections and sends a `PING`.
2. It sets `isAlive = false` on each socket.
3. If the client is alive, its network stack responds with `PONG`, resetting `isAlive = true`.
4. If the next 15-second sweep arrives and `isAlive` is still `false`, the client has died silently. The Gateway calls `socket.terminate()`, instantly freeing memory.

---

## 4. Room & Channel Architecture

Clients do not just talk to the server; they participate in specific topics (e.g. `room:general`, `game:lobby_42`).

```mermaid
flowchart TD
    subgraph RoomsRegistry ["In-Memory Channel Matrix"]
        R1["Room: 'general'"]
        R2["Room: 'dev-team'"]
    end

    subgraph ConnectedClients ["Active Socket Descriptors"]
        C1["Alice (Socket 1)"]
        C2["Bob (Socket 2)"]
        C3["Charlie (Socket 3)"]
    end

    R1 --> C1
    R1 --> C2
    R2 --> C2
    R2 --> C3

    Msg["Alice sends message to 'general'"] --> R1
    R1 -->|"Deliver"| C2
    R1 -.->|"Skip Sender"| C1
```

---

## 5. Horizontal Scaling & The Multi-Node Partitioning Trap

When scaling horizontally behind a load balancer, persistent TCP sockets cannot be shared across physical machine boundaries.

If **Alice** connects to **Gateway Node 1** and **Bob** connects to **Gateway Node 2**, both in room `"trading"`:
- Alice sends a message to Gateway Node 1.
- Node 1 only checks its local connection table and sees Alice.
- **Node 2 never receives the message, and Bob hears complete silence.**

### Topology Comparison: P2P Mesh vs. Pub/Sub Backplane

| Property | Full-Mesh Peer-to-Peer | Centralized Pub/Sub Backplane (Redis) |
| :--- | :--- | :--- |
| **Connection Complexity** | $\mathcal{O}(N^2)$ connections between $N$ nodes | $\mathcal{O}(N)$ connections (each node connects to broker) |
| **Cluster Churn** | Node joining/leaving triggers $N-1$ reconnections | Nodes connect/disconnect independently from Redis |
| **Bandwidth Amplification** | Severe: every node replicates to all peers | Managed: broker filters subscriptions by channel |
| **Industry Usage** | P2P audio/video (WebRTC mesh) | Slack, Discord, Pusher, Phoenix Channels |

---

## 6. The Redis Pub/Sub Backplane Architecture

```mermaid
sequenceDiagram
    autonumber
    actor Alice as Alice (Client A)
    participant GW1 as Gateway Node 1
    participant Redis as Redis Pub/Sub Backplane
    participant GW2 as Gateway Node 2
    actor Bob as Bob (Client B)

    Note over GW1,GW2: Both Gateway nodes connected to Redis broker
    Alice->>GW1: join_room: "crypto"
    Note over GW1: First local subscriber!<br/>GW1 subscribes to Redis "ws:cluster:room:crypto"
    
    Bob->>GW2: join_room: "crypto"
    Note over GW2: First local subscriber!<br/>GW2 subscribes to Redis "ws:cluster:room:crypto"

    Alice->>GW1: send_message: {"room": "crypto", "payload": "BTC at $98k!"}
    
    par Local Delivery & Cluster Publish
        GW1->>GW1: Deliver to any other local sockets in "crypto" (skipping Alice)
        GW1->>Redis: PUBLISH ws:cluster:room:crypto <Envelope>
    end

    Redis-->>GW1: Message dispatched to subscribers
    Note over GW1: senderNodeId == GW1 (Echo suppressed!)

    Redis-->>GW2: Message dispatched to subscribers
    Note over GW2: senderNodeId != GW2 (Valid remote event!)
    GW2->>Bob: Forward payload over local WebSocket
```

### Dynamic Topic Ref-Counting ($\mathcal{O}(\text{Active Local Rooms})$)

To prevent gateway nodes from being overwhelmed by global cluster traffic across thousands of idle rooms:
1. **Dynamic Subscribe**: A gateway node executes `redis.subscribe(room)` **only when the local subscriber count transitions from 0 to 1**.
2. **Dynamic Unsubscribe**: When the last local socket leaves a room or disconnects (local subscribers drop from 1 to 0), the gateway executes `redis.unsubscribe(room)`.
3. **Echo Suppression**: Envelopes carry `senderNodeId`. When Redis broadcasts a message back to the originating node, the node verifies `msg.senderNodeId === this.nodeId` and silently drops it to prevent duplicate local delivery.
