import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from './protocol.js';

export { PROTOCOL_VERSION } from './protocol.js';

export const COMMAND_KINDS = new Set([
  'user.create',
  'user.update',
  'user.delete',
  'user.read',
  'node.snapshot.read',
]);

function assertString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
}

export class CommandQueue {
  #commands = new Map();
  #byIdempotencyKey = new Map();

  enqueue({ nodeId, kind, payload, idempotencyKey, expiresAt }) {
    assertString(nodeId, 'nodeId');
    assertString(idempotencyKey, 'idempotencyKey');
    if (!COMMAND_KINDS.has(kind)) throw new Error('unsupported command kind');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('payload must be an object');
    }

    const previous = this.#byIdempotencyKey.get(idempotencyKey);
    if (previous) return this.#commands.get(previous);

    const command = Object.freeze({
      id: randomUUID(),
      protocolVersion: PROTOCOL_VERSION,
      nodeId,
      kind,
      payload: Object.freeze({ ...payload }),
      idempotencyKey,
      expiresAt: expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString(),
      status: 'queued',
      createdAt: new Date().toISOString(),
    });
    this.#commands.set(command.id, command);
    this.#byIdempotencyKey.set(idempotencyKey, command.id);
    return command;
  }

  poll(nodeId, now = new Date()) {
    return [...this.#commands.values()].filter((command) =>
      command.nodeId === nodeId && command.status === 'queued' && new Date(command.expiresAt) > now,
    );
  }
}
