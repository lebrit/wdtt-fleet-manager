import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/http/app.js';

async function start(app) {
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  return `http://127.0.0.1:${app.address().port}`;
}

async function enrollNode(baseUrl, label) {
  const grantResponse = await fetch(`${baseUrl}/v1/enrollment-grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  assert.equal(grantResponse.status, 201);
  const grant = await grantResponse.json();

  const enrollmentResponse = await fetch(`${baseUrl}/v1/agent/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: grant.token,
      identityFingerprint: label === 'irkutsk-1' ? 'a'.repeat(64) : 'b'.repeat(64),
    }),
  });
  assert.equal(enrollmentResponse.status, 201);
  return { grant, enrollment: await enrollmentResponse.json() };
}

test('management and agent paths fail closed without valid credentials', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const baseUrl = await start(app);

  for (const [path, method] of [
    ['/v1/enrollment-grants', 'POST'],
    ['/v1/commands', 'POST'],
    ['/v1/agent/heartbeat', 'POST'],
    ['/v1/agent/commands', 'GET'],
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    assert.equal(response.status, 401);
  }
});

test('an enrollment grant is one-use and enables versioned heartbeat', async (t) => {
  const app = createApp({
    authenticateAdmin: async () => ({ subject: 'operator' }),
  });
  t.after(() => app.close());
  const baseUrl = await start(app);

  const { grant, enrollment } = await enrollNode(baseUrl, 'irkutsk-1');
  assert.equal(enrollment.node.label, 'irkutsk-1');
  assert.match(enrollment.agentToken, /^[A-Za-z0-9_-]{32,}$/);

  const repeatedEnrollment = await fetch(`${baseUrl}/v1/agent/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: grant.token, identityFingerprint: 'a'.repeat(64) }),
  });
  assert.equal(repeatedEnrollment.status, 400);

  const heartbeat = await fetch(`${baseUrl}/v1/agent/heartbeat`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${enrollment.agentToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocolVersion: 'wdtt-fleet/v1', agentVersion: '0.1.0', panelAdapterVersion: '0.1.0',
    }),
  });
  assert.equal(heartbeat.status, 200);

  const nodes = await fetch(`${baseUrl}/v1/nodes`);
  const node = (await nodes.json()).nodes[0];
  assert.equal(node.reportedVersions.protocolVersion, 'wdtt-fleet/v1');
  assert.ok(node.lastSeenAt);
});

test('an agent receives only commands addressed to its enrolled node', async (t) => {
  const app = createApp({ authenticateAdmin: async () => ({ subject: 'operator' }) });
  t.after(() => app.close());
  const baseUrl = await start(app);
  const first = await enrollNode(baseUrl, 'irkutsk-1');
  const second = await enrollNode(baseUrl, 'irkutsk-2');

  const createCommand = await fetch(`${baseUrl}/v1/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeId: first.enrollment.node.id,
      kind: 'user.read', payload: { sourceUserId: 'local-7' }, idempotencyKey: 'request-7',
    }),
  });
  assert.equal(createCommand.status, 202);

  const commands = await fetch(`${baseUrl}/v1/agent/commands`, {
    headers: { authorization: `Bearer ${first.enrollment.agentToken}` },
  });
  const response = await commands.json();
  assert.equal(response.commands.length, 1);
  assert.equal(response.commands[0].nodeId, first.enrollment.node.id);

  const otherCommands = await fetch(`${baseUrl}/v1/agent/commands`, {
    headers: { authorization: `Bearer ${second.enrollment.agentToken}` },
  });
  assert.deepEqual((await otherCommands.json()).commands, []);
});

test('credential rotation and revocation immediately disable previous agent access', async (t) => {
  const app = createApp({ authenticateAdmin: async () => ({ subject: 'operator' }) });
  t.after(() => app.close());
  const baseUrl = await start(app);
  const { enrollment } = await enrollNode(baseUrl, 'irkutsk-1');

  const rotation = await fetch(`${baseUrl}/v1/nodes/${enrollment.node.id}/credentials/rotate`, {
    method: 'POST',
  });
  assert.equal(rotation.status, 200);
  const { agentToken } = await rotation.json();

  const oldCredentials = await fetch(`${baseUrl}/v1/agent/commands`, {
    headers: { authorization: `Bearer ${enrollment.agentToken}` },
  });
  assert.equal(oldCredentials.status, 401);

  const freshCredentials = await fetch(`${baseUrl}/v1/agent/commands`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  assert.equal(freshCredentials.status, 200);

  const revoke = await fetch(`${baseUrl}/v1/nodes/${enrollment.node.id}/revoke`, { method: 'POST' });
  assert.equal(revoke.status, 200);
  const revokedCredentials = await fetch(`${baseUrl}/v1/agent/commands`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  assert.equal(revokedCredentials.status, 401);
});
