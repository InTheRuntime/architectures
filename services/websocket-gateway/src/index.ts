import { createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { ConnectionManager } from "./connection-manager.js";
import type { ClientMessage } from "./types.js";

const manager = new ConnectionManager();
manager.startHeartbeatWatchdog(15_000);

// Create HTTP server for health, observability, and WebSocket upgrade handling
const server = createServer((req, res) => {
  const url = req.url || "/";

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "websocket-gateway" }));
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
  ws.on("message", (data) => {
    try {
      const msg: ClientMessage = JSON.parse(data.toString());

      switch (msg.type) {
        case "join_room": {
          manager.joinRoom(managed.id, msg.room);
          manager.sendTo(managed.id, { type: "joined", room: msg.room });
          break;
        }

        case "leave_room": {
          manager.leaveRoom(managed.id, msg.room);
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

          manager.broadcastToRoom(
            msg.room,
            {
              type: "message",
              room: msg.room,
              sender: managed.id,
              payload: msg.payload,
              timestamp_ms: Date.now(),
            },
            managed.id, // Skip echo to sender
          );
          break;
        }

        case "ping": {
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

  ws.on("close", () => {
    manager.removeSocket(managed.id);
  });

  ws.on("error", () => {
    manager.removeSocket(managed.id);
  });
});

const port = Number(process.env.PORT) || 8083;
server.listen(port, () => {
  console.log(
    `🚀 WebSocket Gateway listening on ws://localhost:${port} and http://localhost:${port}`,
  );
});
