#!/usr/bin/env node
import { AnyLinkClient } from '../../sdk/src/client.mjs';
import { runStdioMcpServer } from '../src/server.mjs';

const baseUrl = process.env.ANYLINK_BASE_URL;
let token = process.env.ANYLINK_TOKEN ?? process.env.ANYLINK_DEVICE_TOKEN;

if (!baseUrl) {
  console.error('ANYLINK_BASE_URL is required');
  process.exit(1);
}

if (!token) {
  const joinKey = process.env.ANYLINK_JOIN_KEY;
  const installId = process.env.ANYLINK_INSTALL_ID ?? 'mcp-client-default';
  if (!joinKey) {
    console.error('Provide ANYLINK_TOKEN (or ANYLINK_JOIN_KEY for first-time connect)');
    process.exit(1);
  }
  const joined = await AnyLinkClient.connect({
    baseUrl,
    joinKey,
    installId,
    device: { name: process.env.ANYLINK_DEVICE_NAME ?? 'MCP Host', platform: process.env.ANYLINK_PLATFORM ?? 'other' },
    agent: { key: process.env.ANYLINK_AGENT_KEY ?? 'mcp', name: process.env.ANYLINK_AGENT_NAME ?? 'MCP Agent', kind: 'mcp' },
  });
  token = joined.token;
}

const client = new AnyLinkClient({ baseUrl, token });
runStdioMcpServer(client);
