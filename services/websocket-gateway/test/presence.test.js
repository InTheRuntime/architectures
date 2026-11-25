import assert from "node:assert";
import test from "node:test";
import { ClusteredConnectionManager } from "../dist/clustered-connection-manager.js";
import { InMemoryPresenceAdapter } from "../dist/presence/in-memory-adapter.js";
import { InMemoryPubSubAdapter, InMemoryPubSubHub } from "../dist/pubsub/in-memory-adapter.js";

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test("InMemoryPresenceAdapter - Sliding Window Roster & Ghost Eviction", async () => {
  const presence = new InMemoryPresenceAdapter({ defaultPresenceTtlMs: 50 });

  await presence.heartbeat("room-alpha", "user-1");
  await presence.heartbeat("room-alpha", "user-2");

  // Both active immediately
  let active = await presence.getOnlineUsers("room-alpha");
  assert.deepStrictEqual(active.sort(), ["user-1", "user-2"]);
  assert.strictEqual(await presence.getOnlineCount("room-alpha"), 2);

  // Wait 30ms (less than 50ms TTL) and refresh user-1
  await tick(30);
  await presence.heartbeat("room-alpha", "user-1");

  // Wait another 30ms (total 60ms for user-2, 30ms for user-1)
  await tick(30);

  // user-2 should be expired and pruned; user-1 remains active!
  active = await presence.getOnlineUsers("room-alpha");
  assert.deepStrictEqual(active, ["user-1"]);
  assert.strictEqual(await presence.getOnlineCount("room-alpha"), 1);

  await presence.disconnect();
});

test("InMemoryPresenceAdapter - Ephemeral Typing Indicators", async () => {
  const presence = new InMemoryPresenceAdapter({ defaultTypingTtlMs: 40 });

  await presence.setTyping("chat-room", "alice", true);
  await presence.setTyping("chat-room", "bob", true);

  let typing = await presence.getTypingUsers("chat-room");
  assert.deepStrictEqual(typing.sort(), ["alice", "bob"]);

  // Explicit stop typing for alice
  await presence.setTyping("chat-room", "alice", false);
  typing = await presence.getTypingUsers("chat-room");
  assert.deepStrictEqual(typing, ["bob"]);

  // Wait for bob's typing TTL to expire (40ms)
  await tick(50);
  typing = await presence.getTypingUsers("chat-room");
  assert.deepStrictEqual(typing, []);

  await presence.disconnect();
});

test("Clustered Presence - Cross-Node Roster Sync & Join/Leave Events", async () => {
  const hub = new InMemoryPubSubHub();
  const presence = new InMemoryPresenceAdapter();

  const node1PubSub = new InMemoryPubSubAdapter("node-1", hub);
  const node2PubSub = new InMemoryPubSubAdapter("node-2", hub);

  const gateway1 = new ClusteredConnectionManager({
    nodeId: "node-1",
    pubsub: node1PubSub,
    presence,
  });

  const gateway2 = new ClusteredConnectionManager({
    nodeId: "node-2",
    pubsub: node2PubSub,
    presence,
  });

  const sentAlice = [];
  const sentBob = [];

  const clientAlice = { readyState: 1, send: (d) => sentAlice.push(JSON.parse(d)) };
  const clientBob = { readyState: 1, send: (d) => sentBob.push(JSON.parse(d)) };

  // 1. Alice connects to Node 1 with user_id "alice" and joins "standup"
  const connAlice = gateway1.registerSocket(clientAlice, "alice");
  const joinAlice = await gateway1.joinRoom(connAlice.id, "standup");

  assert.strictEqual(joinAlice.success, true);
  assert.deepStrictEqual(joinAlice.onlineUsers, ["alice"]);

  // 2. Bob connects to Node 2 with user_id "bob" and joins "standup"
  const connBob = gateway2.registerSocket(clientBob, "bob");
  const joinBob = await gateway2.joinRoom(connBob.id, "standup");

  assert.strictEqual(joinBob.success, true);
  assert.deepStrictEqual(joinBob.onlineUsers.sort(), ["alice", "bob"]);

  await tick(15); // Allow cross-node pub/sub broadcast

  // Alice on Node 1 received a "user_joined" event for Bob!
  const aliceJoinedEvents = sentAlice.filter((m) => m.type === "user_joined");
  assert.strictEqual(aliceJoinedEvents.length, 1);
  assert.strictEqual(aliceJoinedEvents[0].user_id, "bob");
  assert.strictEqual(aliceJoinedEvents[0].room, "standup");

  // 3. Bob types on Node 2
  await gateway2.setTyping(connBob.id, "standup", true);
  await tick(15);

  // Alice on Node 1 receives "user_typing" for Bob
  const aliceTypingEvents = sentAlice.filter((m) => m.type === "user_typing");
  assert.strictEqual(aliceTypingEvents.length, 1);
  assert.strictEqual(aliceTypingEvents[0].user_id, "bob");
  assert.strictEqual(aliceTypingEvents[0].is_typing, true);

  // Bob was NOT echoed his own typing event
  assert.strictEqual(sentBob.filter((m) => m.type === "user_typing").length, 0);

  // 4. Bob disconnects from Node 2
  await gateway2.removeSocket(connBob.id);
  await tick(15);

  // Alice receives "user_left" event for Bob
  const aliceLeftEvents = sentAlice.filter((m) => m.type === "user_left");
  assert.strictEqual(aliceLeftEvents.length, 1);
  assert.strictEqual(aliceLeftEvents[0].user_id, "bob");

  // Roster now only contains Alice
  const remaining = await gateway1.getOnlineUsers("standup");
  assert.deepStrictEqual(remaining, ["alice"]);

  await gateway1.shutdown();
  await gateway2.shutdown();
});
