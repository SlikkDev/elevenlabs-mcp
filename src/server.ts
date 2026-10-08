import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const API_ORIGIN = "https://api.elevenlabs.io";
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;

export interface ServerOptions {
  apiKey?: string | undefined;
  outputDir?: string | undefined;
  /** Dependency injection for offline tests; not configurable through MCP. */
  fetch?: typeof globalThis.fetch;
}

class SafeError extends Error {}

function result(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function guarded(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof SafeError
        ? error.message
        : "The operation failed. Check local configuration and network access; no automatic retry was made." }],
    };
  }
}

const filenameSchema = z.string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.mp3$/,
    "Use a simple .mp3 filename without directories.")
  .refine(value => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(value),
    "Reserved device filenames are not supported.")
  .optional()
  .describe("Optional new .mp3 filename within the configured output directory; existing files are never overwritten.");

const voicesSchema = z.object({
  voices: z.array(z.object({
    voice_id: z.string(),
    name: z.string(),
    category: z.string().optional(),
  })),
  has_more: z.boolean(),
  next_page_token: z.string().nullable().optional(),
});

export function createServer(options: ServerOptions = {}): McpServer {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const outputDir = path.resolve(options.outputDir || path.join(os.tmpdir(), "elevenlabs-mcp"));
  const server = new McpServer({ name: "elevenlabs-mcp", version: "0.1.0" });

  async function request(endpoint: string, init: RequestInit = {}): Promise<Response> {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) throw new SafeError("Set ELEVENLABS_API_KEY in the MCP server environment.");
    const response = await fetchImpl(new URL(endpoint, API_ORIGIN), {
      ...init,
      headers: { "xi-api-key": apiKey, ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SafeError(`ElevenLabs returned HTTP ${response.status}. Check API access, quota, and inputs. No automatic retry was made.`);
    }
    return response;
  }

  async function generateAudio(endpoint: string, body: unknown, prefix: string,
    outputFilename: string | undefined): Promise<CallToolResult> {
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const destination = path.join(outputDir, outputFilename ?? `${prefix}-${randomUUID()}.mp3`);
    // Reserve before a billable API call; wx refuses existing files and symlinks.
    let file;
    try {
      file = await open(destination, "wx", 0o600);
    } catch {
      throw new SafeError("Cannot create the output file. Choose a new filename and check the output directory permissions.");
    }
    let complete = false;
    let response: Response | undefined;
    let bytes = 0;
    try {
      response = await request(`${endpoint}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(body),
      });
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("audio/") || !response.body) {
        throw new SafeError("ElevenLabs did not return an audio response.");
      }
      if (Number(response.headers.get("content-length")) > MAX_AUDIO_BYTES) {
        throw new SafeError("The audio response exceeded the 100 MiB local limit.");
      }
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_AUDIO_BYTES) throw new SafeError("The audio response exceeded the 100 MiB local limit.");
        await file.writeFile(chunk);
      }
      if (!bytes) throw new SafeError("ElevenLabs returned an empty audio response.");
      complete = true;
      return result({ path: destination, bytes, mime_type: "audio/mpeg" });
    } finally {
      await response?.body?.cancel().catch(() => {});
      await file.close();
      if (!complete) await unlink(destination).catch(() => {});
    }
  }

  server.registerTool("list_voices", {
    title: "List ElevenLabs voices",
    description: "List one page of available voice IDs, names, and categories. Search and continue using next_page_token.",
    inputSchema: {
      search: z.string().max(200).optional(),
      page_size: z.number().int().min(1).max(100).default(20),
      next_page_token: z.string().max(2000).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ search, page_size, next_page_token }) => guarded(async () => {
    const query = new URLSearchParams({ page_size: String(page_size), include_total_count: "false" });
    if (search) query.set("search", search);
    if (next_page_token) query.set("next_page_token", next_page_token);
    const response = await request(`/v2/voices?${query}`);
    const data = voicesSchema.parse(await response.json());
    // Zod strips upstream metadata, including samples, sharing, and verification data.
    return result(data);
  }));

  server.registerTool("text_to_speech", {
    title: "Text to speech",
    description: "Send text to ElevenLabs and save an MP3 locally. Uses ElevenLabs credits. Use list_voices to choose a voice_id.",
    inputSchema: {
      text: z.string().min(1).max(40_000),
      voice_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
      model_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).default("eleven_multilingual_v2"),
      output_filename: filenameSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ text, voice_id, model_id, output_filename }) => guarded(() =>
    generateAudio(`/v1/text-to-speech/${encodeURIComponent(voice_id)}`, { text, model_id }, "tts", output_filename)));

  server.registerTool("compose_music", {
    title: "Compose music",
    description: "Send a prompt to ElevenLabs Music and save an MP3 locally. Uses ElevenLabs credits; instrumental by default.",
    inputSchema: {
      prompt: z.string().min(1).max(2000),
      duration_ms: z.number().int().min(3000).max(300_000).default(30_000),
      instrumental: z.boolean().default(true),
      output_filename: filenameSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ prompt, duration_ms, instrumental, output_filename }) => guarded(() =>
    generateAudio("/v1/music", { prompt, music_length_ms: duration_ms, force_instrumental: instrumental }, "music", output_filename)));

  return server;
}
