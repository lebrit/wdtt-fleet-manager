import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/http/app.js';

async function start(app) {
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  return `http://127.0.0.1:${app.address().port}`;
}

test('management and agent paths fail closed without authenticators', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const baseUrl = await start(app);

  for (const path of ['/v1/nodes', '/v1/commands', '/v1/agent/heartbeat']) {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST' });
    assert.equal(response.status, 401);
  }
});

test('an agent receives only commands for its authenticated node', async (t) => {
  let nodeId;
  const app = createApp({
    authenticateAdmin: async () => ({ subject: 'operator' }),
    authenticateAgent: async () => ({ nodeId }),
  });
  t.after(() => app.close());
  const baseUrl = await start(app);

  const nodeResponse = await fetch(`${baseUrl}/v1/nodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'irkutsk-1', identityFingerprint: 'a'.repeat(32) }),
  });
  const node = (await nodeResponse.json()).node;
  nodeId = node.id;

  const createCommand = await fetch(`${baseUrl}/v1/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeId, kind: 'user.read', payload: { sourceUserId: 'local-7' }, idempotencyKey: 'request-7',
    }),
  });
  assert.equal(createCommand.status, 202);

  const commands = await fetch(`${baseUrl}/v1/agent/commands`);
  const response = await commands.json();
  assert.equal(response.commands.length, 1);
  assert.equal(response.commands[0].nodeId, nodeId);
});
