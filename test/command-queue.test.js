import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandQueue, PROTOCOL_VERSION } from '../src/domain/command-queue.js';

test('returns the original command for a repeated idempotency key', () => {
  const queue = new CommandQueue();
  const input = {
    nodeId: 'node-1', kind: 'user.update',
    payload: { sourceUserId: '42', expectedRevision: 'revision-1', patch: { enabled: false } },
    idempotencyKey: 'request-1',
  };
  const first = queue.enqueue(input);
  const repeated = queue.enqueue({
    ...input,
    payload: { sourceUserId: 'different', expectedRevision: 'revision-2', patch: { enabled: true } },
  });

  assert.equal(repeated.id, first.id);
  assert.equal(first.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(queue.poll('node-1'), [first]);
});

test('does not deliver expired commands', () => {
  const queue = new CommandQueue();
  queue.enqueue({
    nodeId: 'node-1', kind: 'user.read', payload: { sourceUserId: '42' }, idempotencyKey: 'expired',
    expiresAt: '2020-01-01T00:00:00.000Z',
  });
  assert.deepEqual(queue.poll('node-1'), []);
});

test('rejects fields outside the typed WDTT user contract', () => {
  const queue = new CommandQueue();
  assert.throws(() => queue.enqueue({
    nodeId: 'node-1', kind: 'user.create', idempotencyKey: 'bad-user',
    payload: { sourceUserId: '42', shellCommand: 'whoami' },
  }), /unsupported payload field/);
});

test('records idempotent delivery and final command status', () => {
  const queue = new CommandQueue();
  const command = queue.enqueue({
    nodeId: 'node-1', kind: 'user.read', payload: { sourceUserId: '42' }, idempotencyKey: 'receipt-1',
  });
  assert.equal(queue.recordReceipt({ nodeId: 'node-1', commandId: command.id, status: 'delivered' }).status, 'delivered');
  const completed = queue.recordReceipt({ nodeId: 'node-1', commandId: command.id, status: 'succeeded' });
  assert.equal(completed.status, 'succeeded');
  assert.equal(queue.recordReceipt({ nodeId: 'node-1', commandId: command.id, status: 'succeeded' }).id, command.id);
});
