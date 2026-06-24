import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from './protocol.js';
import { normalizeCommandPayload } from './user-command-schema.js';

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
  #persist;

  constructor({ state = {}, persist = () => {} } = {}) {
    this.#persist = persist;
    for (const command of state.commands ?? []) {
      if (!command?.id || !command.idempotencyKey || !command.nodeId || !COMMAND_KINDS.has(command.kind)) {
        throw new Error('invalid persisted command');
      }
      const restored = Object.freeze({ ...command, payload: Object.freeze({ ...command.payload }) });
      this.#commands.set(restored.id, restored);
      this.#byIdempotencyKey.set(restored.idempotencyKey, restored.id);
    }
  }

  enqueue({ nodeId, kind, payload, idempotencyKey, expiresAt }) {
    assertString(nodeId, 'nodeId');
    assertString(idempotencyKey, 'idempotencyKey');
    if (!COMMAND_KINDS.has(kind)) throw new Error('unsupported command kind');
    const normalizedPayload = normalizeCommandPayload(kind, payload);

    const previous = this.#byIdempotencyKey.get(idempotencyKey);
    if (previous) return this.#commands.get(previous);

    const command = Object.freeze({
      id: randomUUID(),
      protocolVersion: PROTOCOL_VERSION,
      nodeId,
      kind,
      payload: normalizedPayload,
      idempotencyKey,
      expiresAt: expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString(),
      status: 'queued',
      createdAt: new Date().toISOString(),
    });
    this.#commands.set(command.id, command);
    this.#byIdempotencyKey.set(idempotencyKey, command.id);
    this.#persist();
    return command;
  }

  poll(nodeId, now = new Date()) {
    this.#expire(now);
    return [...this.#commands.values()].filter((command) =>
      command.nodeId === nodeId && (command.status === 'queued' || command.status === 'delivered'),
    );
  }

  list({ nodeId } = {}) {
    this.#expire(new Date());
    return [...this.#commands.values()]
      .filter((command) => !nodeId || command.nodeId === nodeId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  recordReceipt({ nodeId, commandId, status, errorCode }) {
    assertString(nodeId, 'nodeId');
    assertString(commandId, 'commandId');
    if (!new Set(['delivered', 'succeeded', 'failed']).has(status)) throw new Error('invalid command receipt status');
    if (errorCode !== undefined && (status !== 'failed' || typeof errorCode !== 'string' || !/^[a-z0-9._-]{1,64}$/i.test(errorCode))) {
      throw new Error('errorCode is invalid');
    }

    this.#expire(new Date());
    const current = this.#commands.get(commandId);
    if (!current || current.nodeId !== nodeId) throw new Error('command was not found');
    if (current.status === 'expired') throw new Error('command has expired');
    if (current.status === 'succeeded' || current.status === 'failed') {
      if (current.status === status && current.errorCode === errorCode) return current;
      throw new Error('command has already completed');
    }
    if (current.status === 'delivered' && status === 'delivered') return current;

    const completedAt = status === 'delivered' ? undefined : new Date().toISOString();
    const updated = Object.freeze({
      ...current,
      status,
      ...(status === 'delivered' ? { deliveredAt: new Date().toISOString() } : { completedAt }),
      ...(status === 'failed' ? { errorCode } : {}),
    });
    this.#commands.set(commandId, updated);
    this.#persist();
    return updated;
  }

  #expire(now) {
    for (const [commandId, command] of this.#commands) {
      if ((command.status === 'queued' || command.status === 'delivered') && new Date(command.expiresAt) <= now) {
        this.#commands.set(commandId, Object.freeze({ ...command, status: 'expired', expiredAt: now.toISOString() }));
        this.#persist();
      }
    }
  }

  exportState() {
    return { commands: [...this.#commands.values()] };
  }
}
