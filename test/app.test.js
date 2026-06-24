import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/http/app.js';
import { JsonStateStore } from '../src/domain/state-store.js';

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

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /WDTT Fleet Manager/);

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

test('persists enrolled nodes and agent credentials when a state file is configured', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'wdtt-fleet-test-'));
  const stateStore = new JsonStateStore({ filePath: join(directory, 'state.json') });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { authenticateAdmin: async () => ({ subject: 'operator' }), stateStore };
  const firstApp = createApp(options);
  const baseUrl = await start(firstApp);
  const { enrollment } = await enrollNode(baseUrl, 'irkutsk-1');
  await new Promise((resolve) => firstApp.close(resolve));

  const restoredApp = createApp(options);
  t.after(() => restoredApp.close());
  const restoredBaseUrl = await start(restoredApp);
  const nodes = await fetch(`${restoredBaseUrl}/v1/nodes`);
  assert.equal((await nodes.json()).nodes[0].id, enrollment.node.id);
  const commands = await fetch(`${restoredBaseUrl}/v1/agent/commands`, {
    headers: { authorization: `Bearer ${enrollment.agentToken}` },
  });
  assert.equal(commands.status, 200);
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

test('an agent snapshot produces a node-scoped fleet user read model', async (t) => {
  const app = createApp({ authenticateAdmin: async () => ({ subject: 'operator' }) });
  t.after(() => app.close());
  const baseUrl = await start(app);
  const { enrollment } = await enrollNode(baseUrl, 'irkutsk-1');

  const snapshot = await fetch(`${baseUrl}/v1/agent/snapshots`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${enrollment.agentToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocolVersion: 'wdtt-fleet/v1',
      users: [{
        sourceUserId: 'local-7', displayName: 'Ada', label: 'team-a', enabled: true,
        expiresAt: null, traffic: { receivedBytes: 120, sentBytes: 45 }, online: true,
        devices: [{ sourceDeviceId: 'phone', label: 'Phone' }], revision: '7',
      }],
    }),
  });
  assert.equal(snapshot.status, 202);

  const users = await fetch(`${baseUrl}/v1/fleet-users?nodeId=${enrollment.node.id}`);
  const body = await users.json();
  assert.equal(body.users.length, 1);
  assert.equal(body.users[0].nodeId, enrollment.node.id);
  assert.equal(body.users[0].traffic.receivedBytes, 120);
});

test('an agent can report a final status only for its own command', async (t) => {
  const app = createApp({ authenticateAdmin: async () => ({ subject: 'operator' }) });
  t.after(() => app.close());
  const baseUrl = await start(app);
  const first = await enrollNode(baseUrl, 'irkutsk-1');
  const second = await enrollNode(baseUrl, 'irkutsk-2');

  const created = await fetch(`${baseUrl}/v1/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeId: first.enrollment.node.id, kind: 'user.read', payload: { sourceUserId: 'local-7' },
      idempotencyKey: 'status-1',
    }),
  });
  const { command } = await created.json();

  const wrongNode = await fetch(`${baseUrl}/v1/agent/command-receipts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${second.enrollment.agentToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 'wdtt-fleet/v1', commandId: command.id, status: 'succeeded' }),
  });
  assert.equal(wrongNode.status, 400);

  const completion = await fetch(`${baseUrl}/v1/agent/command-receipts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${first.enrollment.agentToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 'wdtt-fleet/v1', commandId: command.id, status: 'succeeded' }),
  });
  assert.equal(completion.status, 200);
  assert.equal((await completion.json()).command.status, 'succeeded');
});
