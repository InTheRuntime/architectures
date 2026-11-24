# Architecture Design: WebSocket Gateway & Connection Lifecycle

- **Architecture Domain**: Real-Time & Messaging
- **System Layer**: Persistent Bi-Directional Transport
- **Status**: Implemented & Tested
- **Package**: `@intheruntime/service-websocket-gateway`

---

## 1. System Overview & The Core Problem

HTTP is inherently request-driven: a client opens a connection, asks for data, and closes the connection. In applications requiring instant updates (chat, financial tick-by-tick tickers, live ride tracking, collaboration), HTTP polling produces catastrophic overhead:
- Periodic polling requests send 1KB+ HTTP headers repeatedly for empty payloads.
- High connection establishment latency ($3\text{x}$ TCP + TLS handshakes).
- Rapid battery and mobile bandwidth drain.

The **WebSocket Gateway** provides a single persistent, full-duplex TCP channel over port 80/443:
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

- When a client sends a message to room `general`, the connection manager retrieves the room's set of active connection IDs in **$O(1)$** time.
- It iterates through the set and pushes the message frame directly to their socket buffers.
- When a client disconnects, it is automatically unlinked from all subscribed rooms with zero memory leaks.
