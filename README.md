# ElevenLabs MCP

A small, independent [Model Context Protocol](https://modelcontextprotocol.io/) server
for listing ElevenLabs voices, generating speech, and composing music. It runs
locally over stdio and saves generated MP3 files on your machine.

Maintained by [SlikkDev](https://github.com/SlikkDev). This is an unofficial
integration, not an ElevenLabs product.

## Install

Requires Node.js 22 or later and pnpm 10.33.0.

```sh
git clone https://github.com/SlikkDev/elevenlabs-mcp.git
cd elevenlabs-mcp
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
```

Set `ELEVENLABS_API_KEY` in the environment inherited by your MCP client, or use
the client's private credential settings. Choose a key with access to the APIs
you intend to use. Speech and music requests consume your ElevenLabs credits.

For a local env file, copy `.env.example` to `.env`, fill in your key privately,
and launch with `node --env-file=.env dist/index.js`. The server does **not** load
env files automatically. Never commit your key or paste it into an issue.

## Connect an MCP client

Use `node` directly so package-manager output cannot interfere with the stdio
protocol. Replace the example path with your local clone's absolute path:

```json
{
  "mcpServers": {
    "elevenlabs": {
      "command": "node",
      "args": ["/absolute/path/to/elevenlabs-mcp/dist/index.js"]
    }
  }
}
```

On Windows, the path can use forward slashes, for example
`C:/path/to/elevenlabs-mcp/dist/index.js`. Ensure `node` is available to the client,
or supply its full executable path. Clients that do not inherit your shell's
environment must supply the key through their private settings. To use a local
env file instead, put `--env-file=/absolute/path/to/.env` before the script path
in `args`.

The server waits for MCP messages; starting it in a terminal produces no banner.
A missing key does not prevent tool discovery, but tool calls return a clear error.

## Tools

| Tool | Inputs | Result |
| --- | --- | --- |
| `list_voices` | Optional `search`, `page_size` (1–100, default 20), `next_page_token` | One page of voice IDs, names, categories, and continuation metadata |
| `text_to_speech` | `text`, `voice_id`; optional `model_id`, `output_filename` | Local MP3 path, byte count, and MIME type |
| `compose_music` | `prompt`; optional `duration_ms`, `instrumental`, `output_filename` | Local MP3 path, byte count, and MIME type |

Tool results contain JSON in an MCP text content item. Music defaults to 30 seconds
and instrumental output; this server supports 3–300 seconds and prompts up to
2,000 characters. Speech defaults to `eleven_multilingual_v2`, with a local input
cap of 40,000 characters; individual models and accounts may impose lower limits.
Both generation tools request `mp3_44100_128`.

Example tool arguments:

```json
{ "text": "Hello from your assistant.", "voice_id": "YOUR_VOICE_ID", "output_filename": "hello.mp3" }
```

```json
{ "prompt": "Gentle instrumental piano", "duration_ms": 15000, "output_filename": "piano.mp3" }
```

Use `list_voices` to obtain an actual voice ID. For additional voice pages, pass
the returned `next_page_token` while `has_more` is true. Search behavior follows
the ElevenLabs API, including voice names, descriptions, labels, and categories.

## Local files and privacy

- `ELEVENLABS_MCP_OUTPUT_DIR` sets the output directory. By default it is
  `elevenlabs-mcp` under the OS temp directory. Choose a directory you own.
- `output_filename` accepts a simple `.mp3` filename, never a directory or
  arbitrary path. Omit it to get a random filename. Existing files and symlinks
  are refused before making a generation request.
- Responses stream to disk, with a 100 MiB audio limit and a 180-second request
  timeout. Failed downloads remove their partial file when the filesystem permits.
  A process crash can leave a partial file; generated files are not auto-expired.
- On POSIX systems, newly created output directories request mode `0700`, and
  files request `0600`. Windows access follows the destination directory's ACLs.
- Requests go to `https://api.elevenlabs.io` only, with redirects disabled.
  The API key is sent in the authentication header. Text, prompts, voice IDs,
  and search terms go to ElevenLabs as required to perform the requested action.
- The server has no analytics or request logging. API error bodies and raw
  exceptions are not returned to the MCP client. Voice results omit samples,
  sharing details, verification records, and other account metadata.
- Your MCP client can see the tool inputs, selected voice information, and output
  paths. ElevenLabs' own processing and retention settings still apply; this
  server does not promise provider-side zero retention.
- Requests are never retried automatically. A failed or timed-out generation
  might still consume credits; inspect your account before repeating it.

## Development

```sh
pnpm typecheck
pnpm test
pnpm audit --audit-level=high
```

Tests use a real MCP client with synthetic API responses and local temporary files.
They also launch the built executable over stdio. No live credentials, account
data, or billable generation calls are required. A symlink protection test runs
on POSIX; Windows does not require symlink privileges for the test suite.

GitHub Actions runs tests on Node.js 22 and 24, including Windows, plus dependency
auditing and Gitleaks history scanning. The package is marked `private` to avoid
accidental npm publication; the repository and MIT-licensed source are public.

## API references

- [List voices](https://elevenlabs.io/docs/api-reference/voices/search)
- [Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [Compose music](https://elevenlabs.io/docs/api-reference/music/compose)

## License

[MIT](LICENSE). ElevenLabs service access and generated audio remain subject to
your agreement with ElevenLabs and the rights applicable to the input and output.
