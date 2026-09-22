#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createForwarder, parseResponseMessages, readAccessToken, resolveCredentialPath } from './yunxiao-mcp-proxy.mjs';

const root = mkdtempSync(resolve(tmpdir(), 'yunxiao-mcp-proxy-'));
const env = { HOME: root };
const path = resolveCredentialPath(env);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, 'YUNXIAO_ACCESS_TOKEN=fixed-token\n', { mode: 0o600 });
assert.equal(readAccessToken(env), 'fixed-token');
assert.deepEqual(parseResponseMessages('application/json', '{"jsonrpc":"2.0","id":1,"result":{}}'), [{ jsonrpc: '2.0', id: 1, result: {} }]);
assert.deepEqual(parseResponseMessages('text/event-stream', 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'), [{ jsonrpc: '2.0', id: 1, result: {} }]);

const requests = [];
const forward = createForwarder({ env, fetchImpl: async (_url, request) => {
  requests.push(request);
  return new Response('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}', { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
} });
await forward({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
await forward({ jsonrpc: '2.0', method: 'notifications/initialized' });
assert.equal(requests[0].headers.Authorization, 'Bearer fixed-token');
assert.equal(requests[0].headers['Mcp-Session-Id'], undefined);
assert.equal(requests[1].headers['Mcp-Session-Id'], 'session-1');
assert.equal(requests[1].headers['MCP-Protocol-Version'], '2025-06-18');
assert.doesNotMatch(JSON.stringify(requests.map(({ body }) => body)), /fixed-token/);
rmSync(root, { recursive: true, force: true });
console.log('yunxiao-mcp-proxy self-test passed');
