import readline from 'node:readline';

export const MCP_TOOLS = [
  {
    name: 'anylink_memory_assemble',
    description: 'Retrieve relevant shared cloud memory, learned device capability boundaries, and recent cross-device episodes for the current query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Current user question or topic to retrieve relevant memories for' },
        max_memories: { type: 'integer', minimum: 1, maximum: 50 },
        max_episodes: { type: 'integer', minimum: 0, maximum: 20 },
        max_chars: { type: 'integer', minimum: 500, maximum: 40000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_memory_ingest',
    description: 'Send a conversation turn or observation to the Cloud Memory Brain so it extracts, consolidates, and shares useful facts across devices.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['turn', 'task_outcome', 'observation'] },
        session_key: { type: 'string' },
        messages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
          minItems: 1,
        },
        consolidate_now: { type: 'boolean' },
      },
      required: ['messages'],
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_memory_search',
    description: 'Search cloud memories using hybrid CJK/Latin lexical ranking.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'device', 'agent'] },
        kind: { type: 'string', enum: ['fact', 'preference', 'boundary', 'episode'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_memory_save',
    description: 'Explicitly save a durable cloud memory fact.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'device', 'agent'] },
        kind: { type: 'string', enum: ['fact', 'preference', 'boundary'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'content', 'scope'],
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_memory_update',
    description: 'Revise an existing cloud memory using optimistic locking (expected_revision).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        expected_revision: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['id', 'expected_revision'],
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_memory_delete',
    description: 'Delete a cloud memory by id and current revision.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        revision: { type: 'integer', minimum: 1 },
      },
      required: ['id', 'revision'],
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_directory',
    description: 'List all devices and agents in this personal AnyLink network along with live WebSocket online status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'anylink_invoke',
    description: 'Send a natural-language task or instruction to another device/agent in the personal network. Supports priority, require_online fast-fail, and concurrency_key.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'Clear instruction describing what you want the target agent to do' },
        target_agent_id: { type: 'string' },
        target_device_id: { type: 'string' },
        target_device_slug: { type: 'string', description: 'Unique short device alias, e.g. "home-mac" or "gpu-box"' },
        target_device_name: { type: 'string', description: 'Human-friendly device name, e.g. "Mac" or "Phone"' },
        target_agent_key: { type: 'string', description: 'Target agent key, e.g. "mac-openclaw"' },
        capability: { type: 'string', description: 'Optional structured capability name; defaults to agent.invoke' },
        input: { type: 'object', description: 'Optional structured input payload' },
        priority: { type: 'integer', minimum: 0, maximum: 10 },
        require_online: { type: 'boolean', description: 'Fail fast (409 TARGET_OFFLINE) if target is offline' },
        concurrency_key: { type: 'string' },
        execution_timeout_seconds: { type: 'integer', minimum: 10, maximum: 86400 },
        wait: { type: 'boolean', description: 'Wait for the task to finish (default false)' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000 },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_task_status',
    description: 'Check the status, progress, pending interaction, and result of a cross-device task.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_task_reply',
    description: 'Reply to or approve/reject a suspended cross-device task (awaiting_input or awaiting_approval).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        message: { type: 'string' },
        choice: { type: 'string' },
        approved: { type: 'boolean' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_task_cancel',
    description: 'Cancel a queued/suspended task or send cooperative cancellation to a running task.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_artifact_upload',
    description: 'Upload a temporary base64-encoded binary artifact (up to 10 MiB) to share across devices.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        content_type: { type: 'string' },
        data_base64: { type: 'string' },
        task_id: { type: 'string' },
        ttl_seconds: { type: 'integer', minimum: 60, maximum: 86400 },
      },
      required: ['filename', 'data_base64'],
      additionalProperties: false,
    },
  },
  {
    name: 'anylink_artifact_download',
    description: 'Download a cross-device artifact by id as base64 + metadata.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

export function createMcpHandler(client, { serverInfo = { name: 'anylink-mcp', version: '0.9.0' } } = {}) {
  async function callTool(name, args = {}) {
    if (name === 'anylink_memory_assemble') return client.assembleMemory(args);
    if (name === 'anylink_memory_ingest') return client.ingestMemory(args);
    if (name === 'anylink_memory_search') return client.searchMemories(args);
    if (name === 'anylink_memory_save') return client.saveMemory(args);
    if (name === 'anylink_memory_update') {
      const { id, expected_revision, ...patch } = args;
      return client.updateMemory(id, expected_revision, patch);
    }
    if (name === 'anylink_memory_delete') return client.deleteMemory(args.id, args.revision);
    if (name === 'anylink_directory') return client.directory();
    if (name === 'anylink_task_status') return client.task(args.id);
    if (name === 'anylink_task_reply') {
      const { id, ...body } = args;
      return client.replyTask(id, body);
    }
    if (name === 'anylink_task_cancel') return client.cancelTask(args.id);
    if (name === 'anylink_artifact_upload') {
      return client.uploadArtifact({
        data: Buffer.from(args.data_base64, 'base64'),
        filename: args.filename,
        contentType: args.content_type ?? 'application/octet-stream',
        taskId: args.task_id,
        ttlSeconds: args.ttl_seconds,
      });
    }
    if (name === 'anylink_artifact_download') {
      const out = await client.downloadArtifact(args.id);
      return {
        filename: out.filename,
        content_type: out.contentType,
        sha256: out.sha256,
        size_bytes: out.data.length,
        data_base64: out.data.toString('base64'),
      };
    }
    if (name === 'anylink_invoke') {
      const target = args.target_agent_id ? { agent_id: args.target_agent_id }
        : args.target_device_id ? { device_id: args.target_device_id }
        : args.target_device_slug ? { device_slug: args.target_device_slug }
        : args.target_device_name ? { device_name: args.target_device_name }
        : args.target_agent_key ? { agent_key: args.target_agent_key }
        : undefined;
      const created = await client.invoke({
        target,
        instruction: args.instruction,
        capability: args.capability,
        input: args.input,
        priority: args.priority,
        requireOnline: args.require_online,
        concurrencyKey: args.concurrency_key,
        executionTimeoutSeconds: args.execution_timeout_seconds,
      });
      if (args.wait) {
        return client.waitForTask(created.id, { timeoutMs: args.timeout_ms ?? 60000 });
      }
      return created;
    }
    throw new Error(`Unknown MCP tool: ${name}`);
  }

  return async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const { id, method, params } = msg;
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;

    try {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo,
          },
        };
      }
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      if (method === 'tools/call') {
        const data = await callTool(params?.name, params?.arguments ?? {});
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          },
        };
      }
      if (id === undefined) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (err) {
      if (id === undefined) return null;
      if (method === 'tools/call') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: { code: err?.code ?? 'MCP_TOOL_ERROR', message: String(err?.message ?? err) } }) }],
          },
        };
      }
      return { jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err) } };
    }
  };
}

/** Run the MCP server over newline-delimited stdio JSON-RPC 2.0. */
export function runStdioMcpServer(client, { input = process.stdin, output = process.stdout } = {}) {
  const handle = createMcpHandler(client);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const response = await handle(msg);
    if (response) output.write(JSON.stringify(response) + '\n');
  });
  return rl;
}
