# Security

Use a private output directory and an ElevenLabs key limited to the capabilities
you need. The server is a local stdio process and should not be exposed as a
network service without an independently reviewed authentication layer.

Treat MCP tool inputs as requests from your client. Generating speech or music
sends the supplied content to ElevenLabs and may consume credits. Grant tool
access only to clients you trust. Output files and voice names may themselves
contain private information.

The server accepts filenames only within its configured output directory, refuses
overwrites, disables HTTP redirects, and omits upstream error bodies. It does not
read project files, load adjacent environment files automatically, or run shell
commands. The output directory is trusted local configuration; do not allow other
users to replace that directory or its parents while the server is running.

Report vulnerabilities privately through this repository's GitHub **Security →
Report a vulnerability** feature. Do not include API keys, private voice data,
audio, or customer content in public issues. Rotate exposed credentials through
the provider's normal account workflow.
