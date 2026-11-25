import { createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { ClusteredConnectionManager } from "./clustered-connection-manager.js";
import type { PresenceAdapter } from "./presence/adapter.js";
import { InMemoryPresenceAdapter } from "./presence/in-memory-adapter.js";
import { RedisPresenceAdapter } from "./presence/redis-adapter.js";
import type { PubSubAdapter } from "./pubsub/adapter.js";
import { InMemoryPubSubAdapter, InMemoryPubSubHub } from "./pubsub/in-memory-adapter.js";
import { RedisPubSubAdapter } from "./pubsub/redis-adapter.js";
import type { ReplayBufferAdapter } from "./replay/adapter.js";
import { InMemoryReplayBuffer } from "./replay/in-memory-replay-buffer.js";
import { RedisStreamReplayBuffer } from "./replay/redis-stream-replay-buffer.js";
import type { ClientMessage } from "./types.js";

const nodeId = process.env.NODE_ID || `node_${process.pid}`;
const redisUrl = process.env.REDIS_URL;
const useRedis = Boolean(redisUrl || process.env.REDIS_HOST);

let pubsub: PubSubAdapter;
let presence: PresenceAdapter;
let replay: ReplayBufferAdapter;

if (useRedis) {
  const redisAdapter = new RedisPubSubAdapter(nodeId, { redisUrl });
  const redisPresence = new RedisPresenceAdapter({ redisUrl });
  const redisReplay = new RedisStreamReplayBuffer({ redisUrl });
  try {
    await Promise.all([redisAdapter.connect(), redisPresence.connect(), redisReplay.connect()]);
    pubsub = redisAdapter;
    presence = redisPresence;
    replay = redisReplay;
    console.log(`[${nodeId}] Connected to Redis Pub/Sub, Presence & Stream Replay backplane`);
  } catch (err) {
    console.warn(`[${nodeId}] Redis connection failed, falling back to in-memory:`, err);
    pubsub = new InMemoryPubSubAdapter(nodeId, new InMemoryPubSubHub());
    presence = new InMemoryPresenceAdapter();
    replay = new InMemoryReplayBuffer();
  }
} else {
  pubsub = new InMemoryPubSubAdapter(nodeId, new InMemoryPubSubHub());
  presence = new InMemoryPresenceAdapter();
  replay = new InMemoryReplayBuffer();
}

const manager = new ClusteredConnectionManager({ nodeId, pubsub, presence, replay });
manager.startHeartbeatWatchdog(15_000);

// Create HTTP server for health, cluster observability, and WebSocket upgrade handling
const server = createServer((req, res) => {
  const url = req.url || "/";

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "websocket-gateway", node_id: nodeId }));
    return;
  }

  if (url === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(manager.getStats()));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found", message: "Use ws:// to connect via WebSockets" }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket) => {
  const managed = manager.registerSocket(ws);

  // Send welcome handshake confirmation
  manager.sendTo(managed.id, {
    type: "welcome",
    connection_id: managed.id,
  });

  // Client responds to ping
  ws.on("pong", () => {
    managed.isAlive = true;
  });

  // Message dispatcher
  ws.on("message", async (data) => {
    try {
      const msg: ClientMessage = JSON.parse(data.toString());

      switch (msg.type) {
        case "join_room": {
          const joinResult = await manager.joinRoom(
            managed.id,
            msg.room,
            msg.user_id,
            msg.last_received_seq,
          );

          manager.sendTo(managed.id, { type: "joined", room: msg.room });
          manager.sendTo(managed.id, {
            type: "presence_sync",
            room: msg.room,
            users: joinResult.onlineUsers,
          });

          // Disconnect Recovery: Handle missed message catchup
          if (joinResult.isExpired) {
            manager.sendTo(managed.id, {
              type: "replay_expired",
              room: msg.room,
              oldest_available_seq: joinResult.oldestAvailableSeq ?? 0,
              current_seq: joinResult.currentSeq ?? 0,
              message:
                "Requested sequence offset has expired from stream buffer. Full state refresh required.",
            });
          } else if (joinResult.replayedMessages && joinResult.replayedMessages.length > 0) {
            manager.sendTo(managed.id, {
              type: "replay_messages",
              room: msg.room,
              messages: joinResult.replayedMessages,
              current_seq: joinResult.currentSeq ?? 0,
            });
          }
          break;
        }

        case "leave_room": {
          await manager.leaveRoom(managed.id, msg.room);
          manager.sendTo(managed.id, { type: "left", room: msg.room });
          break;
        }

        case "send_message": {
          if (!managed.rooms.has(msg.room)) {
            manager.sendTo(managed.id, {
              type: "error",
              message: `Must join room '${msg.room}' before broadcasting messages`,
            });
            return;
          }

          // Broadcast across cluster (local delivery + backplane publication + replay buffer)
          await manager.broadcast(msg.room, msg.payload, managed.id);
          break;
        }

        case "typing": {
          if (!managed.rooms.has(msg.room)) {
            manager.sendTo(managed.id, {
              type: "error",
              message: `Must join room '${msg.room}' before emitting typing status`,
            });
            return;
          }

          await manager.setTyping(managed.id, msg.room, msg.is_typing);
          break;
        }

        case "ping": {
          await manager.refreshPresence(managed.id);
          manager.sendTo(managed.id, { type: "pong" });
          break;
        }

        default:
          manager.sendTo(managed.id, { type: "error", message: "Unknown message type" });
      }
    } catch {
      manager.sendTo(managed.id, { type: "error", message: "Invalid JSON format" });
    }
  });

  ws.on("close", async () => {
    await manager.removeSocket(managed.id);
  });

  ws.on("error", async () => {
    await manager.removeSocket(managed.id);
  });
});

const port = Number(process.env.PORT) || 8083;
server.listen(port, () => {
  console.log(
    `WebSocket Gateway [${nodeId}] listening on ws://localhost:${port} and http://localhost:${port}`,
  );
});
