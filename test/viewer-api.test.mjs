import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "viewer", "server.mjs");
const LONG_PROMPT = `${"lead ".repeat(80)}BURIEDNEEDLE tail`; // the needle sits well past the 280-char preview
const RECORDS = [
  {
    provider: "claude", sessionId: "s1", id: "s1:0", ts: "2026-08-10T10:00:00.000Z",
    prompt: LONG_PROMPT, promptChars: LONG_PROMPT.length, response: "answered", responseChars: 8,
    model: "claude-sonnet-4-5", usage: { input: 10, output: 2 }, cost: { total: 1, source: "priced" },
  },
  {
    provider: "codex", sessionId: "s2", id: "s2:0", ts: "2026-08-10T11:00:00.000Z",
    prompt: "short one", promptChars: 9, response: "ok", responseChars: 2,
    model: "gpt-test", usage: { input: 5, output: 1 }, cost: { total: 2, source: "priced" },
  },
];

function request(port, pathname, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port, path: pathname, method,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// One server for the whole file; --no-sync/--no-pricing-refresh keep it off the
// network and stop autoSync from pulling this machine's real history into the
// fixture directory.
let dir;
let child;
let port;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-viewerapi-"));
  fs.writeFileSync(path.join(dir, "p.ndjson"), RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  port = 4500 + Math.floor(Math.random() * 400);
  child = spawn(process.execPath, [SERVER, "--port", String(port), "--no-sync", "--no-pricing-refresh"], {
    env: { ...process.env, AI_USAGE_DIR: dir },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      await request(port, "/api/config");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("viewer did not start");
});

test.after(() => {
  try { child.kill(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

test("/api/events ships previews, never the full stored text", async () => {
  const res = await request(port, "/api/events");
  assert.equal(res.status, 200);
  assert.equal(res.json.length, 2);
  const long = res.json.find((e) => e.id === "s1:0");
  assert.equal("prompt" in long, false, "full prompt must not ride along in the list");
  assert.equal(long.promptPreview.length, 280);
  assert.equal(long.promptChars, LONG_PROMPT.length, "true size still reported");
});

test("/api/search matches text past the preview cut-off", async () => {
  const hit = await request(port, "/api/search?q=BURIEDNEEDLE");
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.json.keys, [JSON.stringify(["claude", "s1", "s1:0"])]);

  const previews = (await request(port, "/api/events")).json;
  const preview = previews.find((e) => e.id === "s1:0").promptPreview;
  assert.equal(preview.includes("BURIEDNEEDLE"), false, "needle is genuinely beyond the preview");
});

test("/api/search: empty query disables filtering, no match returns none", async () => {
  assert.equal((await request(port, "/api/search?q=")).json.keys, null);
  assert.deepEqual((await request(port, "/api/search?q=zzznotfoundzzz")).json.keys, []);
});

test("/api/export returns whole records for the requested keys", async () => {
  const res = await request(port, "/api/export", {
    method: "POST",
    body: { keys: [{ provider: "claude", sessionId: "s1", id: "s1:0" }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.length, 1);
  assert.equal(res.json[0].prompt, LONG_PROMPT, "full text, not the preview");
  assert.equal(res.json[0].response, "answered");
});

test("/api/export with no keys returns nothing rather than everything", async () => {
  const res = await request(port, "/api/export", { method: "POST", body: { keys: [] } });
  assert.deepEqual(res.json, []);
});

test("/api/event/:id returns one full record; unknown id is 404", async () => {
  const ok = await request(port, "/api/event/s2%3A0");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.prompt, "short one");
  assert.equal((await request(port, "/api/event/nope")).status, 404);
});

test("/api/stream is an SSE feed that fires when the data dir changes", async () => {
  const events = await new Promise((resolve, reject) => {
    const seen = [];
    const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
      assert.match(res.headers["content-type"], /text\/event-stream/);
      res.on("data", (d) => {
        if (d.toString().includes("event: change")) seen.push(1);
      });
      setTimeout(() => {
        fs.appendFileSync(path.join(dir, "p.ndjson"), JSON.stringify({ ...RECORDS[1], id: "s2:1" }) + "\n");
      }, 300);
      setTimeout(() => { req.destroy(); resolve(seen.length); }, 2500);
    });
    req.on("error", reject);
  });
  assert.ok(events >= 1, "a write to the data dir must notify connected clients");
});

test("DELETE tombstones the record so it stays gone", async () => {
  const del = await request(port, "/api/events", {
    method: "DELETE",
    body: { keys: [{ provider: "codex", sessionId: "s2", id: "s2:0" }] },
  });
  assert.equal(del.status, 200);
  assert.equal(del.json.removed, 1);
  assert.ok(fs.existsSync(path.join(dir, "tombstones.json")), "tombstone persisted for the next sync");

  const left = (await request(port, "/api/events")).json;
  assert.equal(left.some((e) => e.id === "s2:0"), false);
});

test("static index is served; unknown routes and traversal do not escape", async () => {
  const index = await request(port, "/");
  assert.equal(index.status, 200);
  assert.match(index.headers["content-type"], /text\/html/);
  assert.equal((await request(port, "/definitely-not-here.js")).status, 404);
  const escaped = await request(port, "/....//....//package.json");
  assert.ok(escaped.status === 403 || escaped.status === 404, `traversal must not serve a file (got ${escaped.status})`);
});
