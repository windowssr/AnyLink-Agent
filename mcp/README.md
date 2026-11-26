# `@anylink-agent/mcp`

Zero-code MCP Server adapter for **AnyLink Protocol v3**. Plug Claude Code, Cursor, Codex, or OpenClaw directly into your Personal Agent Network to access cloud shared memory and invoke remote devices.

## Configuration (Claude Code / Cursor / Codex)

```json
{
  "mcpServers": {
    "anylink": {
      "command": "node",
      "args": ["/path/to/anylink-agent/mcp/bin/anylink-mcp.mjs"],
      "env": {
        "ANYLINK_BASE_URL": "https://your-anylink-server.example",
        "ANYLINK_TOKEN": "ak_..."
      }
    }
  }
}
```

## Exposed Tools

- **Cloud Memory Brain**: `anylink_memory_assemble`, `anylink_memory_ingest`, `anylink_memory_search`, `anylink_memory_save`, `anylink_memory_update`, `anylink_memory_delete`
- **Cross-Device Invocation**: `anylink_directory`, `anylink_invoke` (no prior capability manifest required; optional `wait: true`), `anylink_task_status`, `anylink_task_cancel`
