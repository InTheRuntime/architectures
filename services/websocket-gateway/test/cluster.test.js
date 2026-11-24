import assert from "node:assert";
import test from "node:test";
import { ClusteredConnectionManager } from "../dist/clustered-connection-manager.js";
import { InMemoryPubSubAdapter, InMemoryPubSubHub } from "../dist/pubsub/in-memory-adapter.js";

// Helper to wait for microtask queue to drain (pub/sub network emulation)
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("Clustered WebSocket - Cross-Node Broadcast Fan-Out", async () => {
  const sharedHub = new InMemoryPubSubHub();

  const node1PubSub = new InMemoryPubSubAdapter("node-1", sharedHub);
  const node2PubSub = new InMemoryPubSubAdapter("node-2", sharedHub);

  const gateway1 = new ClusteredConnectionManager({ nodeId: "node-1", pubsub: node1PubSub });
  const gateway2 = new ClusteredConnectionManager({ nodeId: "node-2", pubsub: node2PubSub });

  const clientA = { readyState: 1, send: (d) => sentA.push(JSON.parse(d)) };
  const clientB = { readyState: 1, send: (d) => sentB.push(JSON.parse(d)) };

  const sentA = [];
  const sentB = [];

  // Client A connects to Node 1
  const connA = gateway1.registerSocket(clientA);
  await gateway1.joinRoom(connA.id, "market-data");

  // Client B connects to Node 2
  const connB = gateway2.registerSocket(clientB);
  await gateway2.joinRoom(connB.id, "market-data");

  // Client A on Node 1 broadcasts a price tick
  const { localDelivered } = await gateway1.broadcast(
    "market-data",
    { symbol: "BTC-USD", price: 98500 },
    connA.id,
  );

  assert.strictEqual(localDelivered, 0); // No other clients on Node 1

  await tick(); // Allow backplane microtask dispatch

  // Verification:
  // 1. Sender Client A was NOT echoed
  assert.strictEqual(sentA.length, 0);

  // 2. Client B on Node 2 received the cross-node broadcast!
  assert.strictEqual(sentB.length, 1);
  assert.strictEqual(sentB[0].type, "message");
  assert.strictEqual(sentB[0].room, "market-data");
  assert.strictEqual(sentB[0].sender, connA.id);
  assert.strictEqual(sentB[0].payload.symbol, "BTC-USD");
  assert.strictEqual(sentB[0].payload.price, 98500);

  await gateway1.shutdown();
  await gateway2.shutdown();
});

test("Clustered WebSocket - Cross-Node Topic Isolation", async () => {
  const sharedHub = new InMemoryPubSubHub();

  const node1PubSub = new InMemoryPubSubAdapter("node-1", sharedHub);
  const node2PubSub = new InMemoryPubSubAdapter("node-2", sharedHub);

  const gateway1 = new ClusteredConnectionManager({ nodeId: "node-1", pubsub: node1PubSub });
  const gateway2 = new ClusteredConnectionManager({ nodeId: "node-2", pubsub: node2PubSub });

  const clientA = { readyState: 1, send: (d) => sentA.push(JSON.parse(d)) };
  const clientC = { readyState: 1, send: (d) => sentC.push(JSON.parse(d)) };

  const sentA = [];
  const sentC = [];

  // Client A on Node 1 joins "forex"
  const connA = gateway1.registerSocket(clientA);
  await gateway1.joinRoom(connA.id, "forex");

  // Client C on Node 2 joins "crypto"
  const connC = gateway2.registerSocket(clientC);
  await gateway2.joinRoom(connC.id, "crypto");

  // Client A broadcasts to "forex"
  await gateway1.broadcast("forex", { pair: "EUR/USD", rate: 1.05 }, connA.id);
  await tick();

  // Client C must NOT receive messages meant for a different room
  assert.strictEqual(sentC.length, 0);

  await gateway1.shutdown();
  await gateway2.shutdown();
});

test("Clustered WebSocket - Dynamic Topic Lifecycle & Unsubscribe Ref-Counting", async () => {
  const sharedHub = new InMemoryPubSubHub();
  const nodePubSub = new InMemoryPubSubAdapter("node-test", sharedHub);
  const gateway = new ClusteredConnectionManager({ nodeId: "node-test", pubsub: nodePubSub });

  const client1 = { readyState: 1, send: () => {} };
  const client2 = { readyState: 1, send: () => {} };

  const conn1 = gateway.registerSocket(client1);
  const conn2 = gateway.registerSocket(client2);

  // Initial state: not subscribed to "room-x" on broker
  assert.strictEqual(nodePubSub.isSubscribed("room-x"), false);
  assert.strictEqual(sharedHub.getChannelSubscriberCount("room-x"), 0);

  // Client 1 joins "room-x": Node should dynamically subscribe to backplane!
  await gateway.joinRoom(conn1.id, "room-x");
  assert.strictEqual(nodePubSub.isSubscribed("room-x"), true);
  assert.strictEqual(sharedHub.getChannelSubscriberCount("room-x"), 1);

  // Client 2 joins "room-x": Ref-count is 2, broker subscription remains 1
  await gateway.joinRoom(conn2.id, "room-x");
  assert.strictEqual(sharedHub.getChannelSubscriberCount("room-x"), 1);

  // Client 1 leaves "room-x": Ref-count is 1, broker subscription remains active
  await gateway.leaveRoom(conn1.id, "room-x");
  assert.strictEqual(nodePubSub.isSubscribed("room-x"), true);

  // Client 2 disconnects: Ref-count reaches 0 -> Node dynamically unsubscribes from backplane!
  await gateway.removeSocket(conn2.id);
  assert.strictEqual(nodePubSub.isSubscribed("room-x"), false);
  assert.strictEqual(sharedHub.getChannelSubscriberCount("room-x"), 0);

  await gateway.shutdown();
});

test("Clustered WebSocket - Mixed Local and Remote Fan-Out", async () => {
  const sharedHub = new InMemoryPubSubHub();

  const node1PubSub = new InMemoryPubSubAdapter("node-1", sharedHub);
  const node2PubSub = new InMemoryPubSubAdapter("node-2", sharedHub);

  const gateway1 = new ClusteredConnectionManager({ nodeId: "node-1", pubsub: node1PubSub });
  const gateway2 = new ClusteredConnectionManager({ nodeId: "node-2", pubsub: node2PubSub });

  const clientA = { readyState: 1, send: (d) => sentA.push(JSON.parse(d)) }; // Node 1 (Sender)
  const clientB = { readyState: 1, send: (d) => sentB.push(JSON.parse(d)) }; // Node 1 (Peer)
  const clientC = { readyState: 1, send: (d) => sentC.push(JSON.parse(d)) }; // Node 2 (Remote)

  const sentA = [];
  const sentB = [];
  const sentC = [];

  const connA = gateway1.registerSocket(clientA);
  const connB = gateway1.registerSocket(clientB);
  const connC = gateway2.registerSocket(clientC);

  await gateway1.joinRoom(connA.id, "general");
  await gateway1.joinRoom(connB.id, "general");
  await gateway2.joinRoom(connC.id, "general");

  // Client A broadcasts to "general"
  const { localDelivered } = await gateway1.broadcast(
    "general",
    "Cluster wide announcement",
    connA.id,
  );

  // Local delivery on Node 1 delivered to Client B immediately
  assert.strictEqual(localDelivered, 1);
  assert.strictEqual(sentB.length, 1);
  assert.strictEqual(sentB[0].payload, "Cluster wide announcement");
  assert.strictEqual(sentA.length, 0); // No echo

  await tick();

  // Remote delivery on Node 2 delivered to Client C via Backplane
  assert.strictEqual(sentC.length, 1);
  assert.strictEqual(sentC[0].payload, "Cluster wide announcement");

  await gateway1.shutdown();
  await gateway2.shutdown();
});
