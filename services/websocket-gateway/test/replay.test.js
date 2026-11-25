import assert from "node:assert";
import test from "node:test";
import { ClusteredConnectionManager } from "../dist/clustered-connection-manager.js";
import { InMemoryPresenceAdapter } from "../dist/presence/in-memory-adapter.js";
import { InMemoryPubSubAdapter, InMemoryPubSubHub } from "../dist/pubsub/in-memory-adapter.js";
import { InMemoryReplayBuffer } from "../dist/replay/in-memory-replay-buffer.js";

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test("InMemoryReplayBuffer - Sequential Monotonic Offsets & Range Catchup", async () => {
  const replay = new InMemoryReplayBuffer({ capacity: 5 });

  const m1 = await replay.append("forex", "bank-1", { pair: "USD/EUR", rate: 0.95 });
  const m2 = await replay.append("forex", "bank-2", { pair: "USD/JPY", rate: 155.2 });
  const m3 = await replay.append("forex", "bank-1", { pair: "USD/GBP", rate: 0.79 });

  assert.strictEqual(m1.seq, 1);
  assert.strictEqual(m2.seq, 2);
  assert.strictEqual(m3.seq, 3);
  assert.strictEqual(await replay.getCurrentSeq("forex"), 3);

  // Client requests messages after seq 1 -> Should receive seq 2 and 3
  const range = await replay.getRange("forex", 1);
  assert.strictEqual(range.isExpired, false);
  assert.strictEqual(range.messages.length, 2);
  assert.strictEqual(range.messages[0].seq, 2);
  assert.strictEqual(range.messages[1].seq, 3);

  // Client is already up to date (after seq 3)
  const upToDate = await replay.getRange("forex", 3);
  assert.strictEqual(upToDate.isExpired, false);
  assert.strictEqual(upToDate.messages.length, 0);

  await replay.disconnect();
});

test("InMemoryReplayBuffer - Buffer Eviction & Expiration Detection", async () => {
  const replay = new InMemoryReplayBuffer({ capacity: 3 });

  // Append 5 messages into a capacity-3 buffer
  await replay.append("crypto", "trader", "msg-1"); // seq: 1 (evicted)
  await replay.append("crypto", "trader", "msg-2"); // seq: 2 (evicted)
  await replay.append("crypto", "trader", "msg-3"); // seq: 3
  await replay.append("crypto", "trader", "msg-4"); // seq: 4
  await replay.append("crypto", "trader", "msg-5"); // seq: 5

  // Oldest retained is seq 3. Client asking for after seq 1 has missed seq 2!
  const expiredRange = await replay.getRange("crypto", 1);
  assert.strictEqual(expiredRange.isExpired, true);
  assert.strictEqual(expiredRange.oldestSeq, 3);
  assert.strictEqual(expiredRange.currentSeq, 5);

  // Client asking for after seq 2 -> oldest is 3, so seq 3, 4, 5 are all available!
  const validRange = await replay.getRange("crypto", 2);
  assert.strictEqual(validRange.isExpired, false);
  assert.strictEqual(validRange.messages.length, 3);
  assert.strictEqual(validRange.messages[0].seq, 3);
  assert.strictEqual(validRange.messages[2].seq, 5);

  await replay.disconnect();
});

test("Clustered Gateway - Disconnect Recovery & Zero-Loss Message Catchup", async () => {
  const hub = new InMemoryPubSubHub();
  const presence = new InMemoryPresenceAdapter();
  const replay = new InMemoryReplayBuffer({ capacity: 100 });

  const node1PubSub = new InMemoryPubSubAdapter("node-1", hub);
  const node2PubSub = new InMemoryPubSubAdapter("node-2", hub);

  const gateway1 = new ClusteredConnectionManager({
    nodeId: "node-1",
    pubsub: node1PubSub,
    presence,
    replay,
  });

  const gateway2 = new ClusteredConnectionManager({
    nodeId: "node-2",
    pubsub: node2PubSub,
    presence,
    replay,
  });

  const receivedAlice = [];
  const clientAlice = { readyState: 1, send: (d) => receivedAlice.push(JSON.parse(d)) };

  // 1. Alice connects to Node 1 and joins "trading-floor"
  const connAlice1 = gateway1.registerSocket(clientAlice, "alice");
  await gateway1.joinRoom(connAlice1.id, "trading-floor");

  // 2. Bob connects to Node 2 and broadcasts message 1
  const clientBob = { readyState: 1, send: () => {} };
  const connBob = gateway2.registerSocket(clientBob, "bob");
  await gateway2.joinRoom(connBob.id, "trading-floor");

  await gateway2.broadcast("trading-floor", "BTC Price: $98,000", connBob.id);
  await tick(15);

  // Alice received message 1 with seq: 1
  const liveMessagesAlice = receivedAlice.filter((m) => m.type === "message");
  assert.strictEqual(liveMessagesAlice.length, 1);
  assert.strictEqual(liveMessagesAlice[0].seq, 1);
  assert.strictEqual(liveMessagesAlice[0].payload, "BTC Price: $98,000");

  // 3. SIMULATE DISCONNECT: Alice drops offline (e.g. subway tunnel)
  await gateway1.removeSocket(connAlice1.id);

  // 4. While Alice is offline, 2 more messages are broadcast on Node 2!
  await gateway2.broadcast("trading-floor", "ETH Price: $3,400", connBob.id);
  await gateway2.broadcast("trading-floor", "SOL Price: $220", connBob.id);
  await tick(15);

  // 5. RECONNECT: Alice reconnects (can even hit Node 2 this time!) and provides last_received_seq: 1
  const reconnectedAlice = [];
  const clientAlice2 = { readyState: 1, send: (d) => reconnectedAlice.push(JSON.parse(d)) };

  const connAlice2 = gateway2.registerSocket(clientAlice2, "alice");
  const joinResult = await gateway2.joinRoom(
    connAlice2.id,
    "trading-floor",
    "alice",
    1, // last_received_seq
  );

  // Verification:
  // Replay buffer caught the 2 missed messages!
  assert.strictEqual(joinResult.success, true);
  assert.strictEqual(joinResult.isExpired, false);
  assert.strictEqual(joinResult.replayedMessages?.length, 2);
  assert.strictEqual(joinResult.replayedMessages[0].seq, 2);
  assert.strictEqual(joinResult.replayedMessages[0].payload, "ETH Price: $3,400");
  assert.strictEqual(joinResult.replayedMessages[1].seq, 3);
  assert.strictEqual(joinResult.replayedMessages[1].payload, "SOL Price: $220");

  await gateway1.shutdown();
  await gateway2.shutdown();
});
