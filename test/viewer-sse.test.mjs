import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSseRegistry } from "../viewer/sse.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("failed SSE notifications use the idempotent drop path", async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.write = () => { throw new Error("closed"); };
  let drops = 0;
  const clients = createSseRegistry({ onDrop: () => drops++, heartbeatMs: 1000, notifyDelayMs: 1 });
  clients.add(req, res);
  clients.notify();
  await pause(15);
  req.emit("close");
  req.emit("error", new Error("also closed"));

  assert.equal(clients.size, 0);
  assert.equal(drops, 1, "later request events cannot arm cleanup twice");
});

test("failed SSE heartbeats remove the client and arm cleanup", async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.write = () => { throw new Error("closed"); };
  let drops = 0;
  const clients = createSseRegistry({ onDrop: () => drops++, heartbeatMs: 2 });
  clients.add(req, res);
  await pause(15);

  assert.equal(clients.size, 0);
  assert.equal(drops, 1);
});
