import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";

const fakeKey = "synthetic-test-key";
const audio = Buffer.from([0x49, 0x44, 0x33, 0, 1, 2]);
const audioResponse = () => new Response(audio, { headers: { "content-type": "audio/mpeg" } });
const text = result => result.content[0].text;
const json = result => JSON.parse(text(result));

async function session(t, fetchImpl, options = {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "elevenlabs-mcp-test-"));
  const calls = [];
  const server = createServer({
    apiKey: fakeKey, outputDir,
    fetch: async (...args) => { calls.push(args); return fetchImpl(...args); },
    ...options,
  });
  const client = new Client({ name: "offline-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(outputDir, { recursive: true, force: true });
  });
  return { client, outputDir, calls };
}

test("MCP advertises three tools with read/write annotations", async t => {
  const { client } = await session(t, () => { throw new Error("Unexpected network call"); });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["compose_music", "list_voices", "text_to_speech"]);
  assert.equal(tools.find(tool => tool.name === "list_voices").annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === "compose_music").annotations.idempotentHint, false);
});

test("voice pagination encodes queries and strips private upstream metadata", async t => {
  const { client, calls } = await session(t, () => Response.json({
    voices: [{ voice_id: "demo_voice", name: "Demo", category: "premade",
      labels: { internal: "not-for-client" }, samples: [{ file_name: "private-recording" }],
      sharing: { whitelisted_emails: ["private@example.invalid"] } }],
    has_more: true, next_page_token: "next-page", total_count: 9,
  }));
  const result = await client.callTool({ name: "list_voices", arguments: { search: "a&b", page_size: 5, next_page_token: "one&two" } });
  assert.deepEqual(json(result), { voices: [{ voice_id: "demo_voice", name: "Demo", category: "premade" }], has_more: true, next_page_token: "next-page" });
  const [url, request] = calls[0];
  assert.equal(url.origin, "https://api.elevenlabs.io");
  assert.equal(url.pathname, "/v2/voices");
  assert.equal(url.searchParams.get("search"), "a&b");
  assert.equal(url.searchParams.get("next_page_token"), "one&two");
  assert.equal(request.headers["xi-api-key"], fakeKey);
  assert.equal(request.redirect, "error");
  assert.ok(request.signal instanceof AbortSignal);
});

test("TTS goes through MCP and saves exact audio bytes with a unique filename", async t => {
  const { client, calls, outputDir } = await session(t, audioResponse);
  const first = json(await client.callTool({ name: "text_to_speech", arguments: { text: "Synthetic speech", voice_id: "demo_voice" } }));
  const second = json(await client.callTool({ name: "text_to_speech", arguments: { text: "Synthetic speech", voice_id: "demo_voice" } }));
  assert.equal(path.dirname(first.path), outputDir);
  assert.notEqual(first.path, second.path);
  assert.deepEqual(await readFile(first.path), audio);
  assert.equal(first.bytes, audio.length);
  assert.equal(first.mime_type, "audio/mpeg");
  assert.equal(calls[0][0].pathname, "/v1/text-to-speech/demo_voice");
  assert.equal(calls[0][0].searchParams.get("output_format"), "mp3_44100_128");
  assert.deepEqual(JSON.parse(calls[0][1].body), { text: "Synthetic speech", model_id: "eleven_multilingual_v2" });
  if (process.platform !== "win32") assert.equal((await stat(first.path)).mode & 0o777, 0o600);
});

test("music maps duration and instrumental options and saves to the configured directory", async t => {
  const { client, calls, outputDir } = await session(t, audioResponse);
  const result = await client.callTool({ name: "compose_music", arguments: { prompt: "Soft piano", duration_ms: 5000, instrumental: false, output_filename: "demo.mp3" } });
  assert.equal(json(result).path, path.join(outputDir, "demo.mp3"));
  assert.deepEqual(await readFile(json(result).path), audio);
  assert.equal(calls[0][0].pathname, "/v1/music");
  assert.deepEqual(JSON.parse(calls[0][1].body), { prompt: "Soft piano", music_length_ms: 5000, force_instrumental: false });
});

test("multiple response chunks are written in order", async t => {
  const { client } = await session(t, () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(audio.subarray(0, 3));
      controller.enqueue(audio.subarray(3));
      controller.close();
    },
  }), { headers: { "content-type": "audio/mpeg" } }));
  const result = await client.callTool({ name: "compose_music", arguments: { prompt: "Piano" } });
  assert.deepEqual(await readFile(json(result).path), audio);
});

test("existing output is never overwritten or billed", async t => {
  const { client, outputDir, calls } = await session(t, audioResponse);
  await writeFile(path.join(outputDir, "existing.mp3"), "keep me");
  const result = await client.callTool({ name: "compose_music", arguments: { prompt: "Piano", output_filename: "existing.mp3" } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(path.join(outputDir, "existing.mp3"), "utf8"), "keep me");
});

test("symlink output is refused without touching its target", { skip: process.platform === "win32" }, async t => {
  const { client, outputDir, calls } = await session(t, audioResponse);
  const target = path.join(outputDir, "original.txt");
  await writeFile(target, "keep me");
  await symlink(target, path.join(outputDir, "link.mp3"));
  const result = await client.callTool({ name: "compose_music", arguments: { prompt: "Piano", output_filename: "link.mp3" } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(target, "utf8"), "keep me");
});

test("path traversal, device filenames, and invalid IDs are rejected before any API call", async t => {
  const { client, calls, outputDir } = await session(t, audioResponse);
  for (const output_filename of ["../outside.mp3", "/absolute.mp3", "a\\outside.mp3", "C:escape.mp3", "NUL.mp3", "con.extra.mp3", ".hidden.mp3"]) {
    assert.equal((await client.callTool({ name: "compose_music", arguments: { prompt: "Piano", output_filename } })).isError, true);
  }
  assert.equal((await client.callTool({ name: "text_to_speech", arguments: { text: "Hello", voice_id: "../../voices" } })).isError, true);
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(outputDir), []);
});

test("invalid duration and pagination are rejected locally", async t => {
  const { client, calls } = await session(t, audioResponse);
  for (const duration_ms of [2999, 300001, 3500.5]) {
    assert.equal((await client.callTool({ name: "compose_music", arguments: { prompt: "Piano", duration_ms } })).isError, true);
  }
  assert.equal((await client.callTool({ name: "list_voices", arguments: { page_size: 101 } })).isError, true);
  assert.equal(calls.length, 0);
});

test("missing credentials fail without a network request or leftover audio file", async t => {
  const { client, calls, outputDir } = await session(t, audioResponse, { apiKey: undefined });
  const result = await client.callTool({ name: "compose_music", arguments: { prompt: "Piano" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /ELEVENLABS_API_KEY/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(outputDir), []);
});

test("upstream error bodies, status text, and credentials do not enter MCP results", async t => {
  const { client, calls, outputDir } = await session(t, () => new Response("private-response-body", {
    status: 429, statusText: "private-status-text",
  }));
  const result = await client.callTool({ name: "compose_music", arguments: { prompt: "private-prompt" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /HTTP 429/);
  for (const secret of ["private-response-body", "private-status-text", "private-prompt", fakeKey]) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(calls.length, 1);
  assert.deepEqual(await readdir(outputDir), []);
});

test("network and timeout exceptions are sanitized and never retried", async t => {
  const { client, calls } = await session(t, () => { throw new Error("private-url-and-key", { cause: new Error(fakeKey) }); });
  const result = await client.callTool({ name: "list_voices", arguments: {} });
  assert.equal(result.isError, true);
  assert.ok(!text(result).includes("private-url-and-key"));
  assert.ok(!text(result).includes(fakeKey));
  assert.equal(calls.length, 1);
});

test("malformed voice response produces a safe error", async t => {
  const { client } = await session(t, () => new Response("private-invalid-json", { headers: { "content-type": "application/json" } }));
  const result = await client.callTool({ name: "list_voices", arguments: {} });
  assert.equal(result.isError, true);
  assert.ok(!text(result).includes("private-invalid-json"));
});

test("non-audio, empty, and oversized responses leave no file", async t => {
  for (const makeResponse of [
    () => Response.json({ detail: "private-data" }),
    () => new Response(null, { headers: { "content-type": "audio/mpeg" } }),
    () => new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": String(101 * 1024 * 1024) } }),
    () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(101 * 1024 * 1024)); controller.close();
    } }), { headers: { "content-type": "audio/mpeg" } }),
  ]) {
    const { client, outputDir } = await session(t, makeResponse);
    const result = await client.callTool({ name: "compose_music", arguments: { prompt: "Piano" } });
    assert.equal(result.isError, true);
    assert.deepEqual(await readdir(outputDir), []);
  }
});

test("interrupted audio streams remove partial output without exposing the exception", async t => {
  const { client, outputDir } = await session(t, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(audio); },
    pull(controller) { controller.error(new Error("private-stream-error")); },
  }), { headers: { "content-type": "audio/mpeg" } }));
  const result = await client.callTool({ name: "compose_music", arguments: { prompt: "Piano" } });
  assert.equal(result.isError, true);
  assert.ok(!text(result).includes("private-stream-error"));
  assert.deepEqual(await readdir(outputDir), []);
});

test("built CLI starts over stdio and handles MCP without stdout pollution", async t => {
  const client = new Client({ name: "stdio-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { ELEVENLABS_API_KEY: "", ELEVENLABS_MCP_OUTPUT_DIR: "" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk; });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 3);
  const result = await client.callTool({ name: "list_voices", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(text(result), /ELEVENLABS_API_KEY/);
  assert.equal(stderr, "");
});
