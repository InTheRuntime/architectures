import assert from "node:assert";
import test from "node:test";
import { WebSocket } from "ws";
import { ConnectionManager } from "../dist/connection-manager.js";

test("WebSocket ConnectionManager - Room Isolation & Selective Broadcast", () => {
  const manager = new ConnectionManager();

  // Create mock sockets
  const clientA = { readyState: 1, send: (data) => sentA.push(JSON.parse(data)) };
  const clientB = { readyState: 1, send: (data) => sentB.push(JSON.parse(data)) };
  const clientC = { readyState: 1, send: (data) => sentC.push(JSON.parse(data)) };

  const sentA = [];
  const sentB = [];
  const sentC = [];

  const connA = manager.registerSocket(clientA);
  const connB = manager.registerSocket(clientB);
  const connC = manager.registerSocket(clientC);

  // A and B join room "general"
  manager.joinRoom(connA.id, "general");
  manager.joinRoom(connB.id, "general");

  // C joins room "random"
  manager.joinRoom(connC.id, "random");

  // A broadcasts message to "general" (skipping sender A)
  const delivered = manager.broadcastToRoom(
    "general",
    {
      type: "message",
      room: "general",
      sender: connA.id,
      payload: "Hello General!",
      timestamp_ms: Date.now(),
    },
    connA.id,
  );

  assert.strictEqual(delivered, 1);
  assert.strictEqual(sentA.length, 0); // Sender skipped
  assert.strictEqual(sentB.length, 1); // Recipient in room received it!
  assert.strictEqual(sentB[0].payload, "Hello General!");
  assert.strictEqual(sentC.length, 0); // Client C in "random" did NOT receive it!
});

test("WebSocket ConnectionManager - Zombie Socket Heartbeat Watchdog", () => {
  const manager = new ConnectionManager();

  let terminated = false;
  let pinged = false;

  const mockDeadSocket = {
    readyState: 1,
    ping: () => {
      pinged = true;
    },
    terminate: () => {
      terminated = true;
    },
  };

  manager.registerSocket(mockDeadSocket);

  // Sweep 1: Marks isAlive = false and sends ping
  manager.sweepHeartbeats();
  assert.strictEqual(pinged, true);
  assert.strictEqual(terminated, false);

  // Simulate dead client that NEVER responds with pong (isAlive stays false)

  // Sweep 2: Should detect as zombie and call socket.terminate()!
  const zombiesKilled = manager.sweepHeartbeats();
  assert.strictEqual(zombiesKilled, 1);
  assert.strictEqual(terminated, true);

  // Socket must be cleaned up from connections map
  assert.strictEqual(manager.getStats().total_connections, 0);
});
