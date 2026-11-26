import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, MCP_TOOLS } from '../src/server.mjs';

test('MCP server exposes protocol v3 tools and dispatches memory & cross-device invoke calls', async () => {
  const calls = [];
  const fakeClient = {
    assembleMemory: async args => { calls.push(['assemble', args]); return { summary_text: '## Shared Cloud Memory\n- Prefers Chinese' }; },
    ingestMemory: async args => { calls.push(['ingest', args]); return { episode_id: 'ep-1', status: 'consolidated' }; },
    directory: async () => ({ items: [{ device: { name: 'Mac' }, agents: [{ key: 'mac-openclaw', ws_online: true }] }] }),
    invoke: async args => { calls.push(['invoke', args]); return { id: 'task-99', state: 'queued' }; },
    waitForTask: async (id, opts) => { calls.push(['wait', id, opts]); return { id, state: 'succeeded', result: { state: 'succeeded', output: { reply: 'Moved report.md' } } }; },
  };
  const handle = createMcpHandler(fakeClient);

  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'anylink-mcp');

  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(list.result.tools.length, MCP_TOOLS.length);

  const mem = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'anylink_memory_assemble', arguments: { query: 'language preference' } } });
  assert.match(mem.result.content[0].text, /Prefers Chinese/);

  const inv = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'anylink_invoke', arguments: { target_device_name: 'Mac', instruction: 'Move report.md', wait: true } } });
  assert.match(inv.result.content[0].text, /Moved report\.md/);
  assert.equal(calls.find(c => c[0] === 'invoke')[1].target.device_name, 'Mac');

  const err = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nonexistent', arguments: {} } });
  assert.equal(err.result.isError, true);
});
