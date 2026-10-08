#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

try {
  const server = createServer({
    apiKey: process.env.ELEVENLABS_API_KEY,
    outputDir: process.env.ELEVENLABS_MCP_OUTPUT_DIR,
  });
  await server.connect(new StdioServerTransport());
} catch {
  // stdout is reserved for MCP. Never log environment values or raw errors.
  process.stderr.write("ElevenLabs MCP could not start. Check the local configuration.\n");
  process.exitCode = 1;
}
