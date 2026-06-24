import { PROTOCOL_VERSION } from './protocol.js';

const MAX_USERS_PER_SNAPSHOT = 500;
const USER_FIELDS = new Set([
  'sourceUserId', 'displayName', 'label', 'enabled', 'expiresAt', 'traffic', 'online', 'devices', 'revision', 'vkHashes', 'ports',
]);
const TRAFFIC_FIELDS = new Set(['receivedBytes', 'sentBytes']);
const DEVICE_FIELDS = new Set(['sourceDeviceId', 'label']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertAllowedKeys(value, allowed, name) {
  if (!isPlainObject(value)) throw new Error(`${name} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unsupported ${name} field: ${key}`);
  }
}

function nonEmptyString(value, field, maxLength = 128) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`${field} is invalid`);
  }
  return value.trim();
}

function nullableString(value, field, maxLength = 128) {
  if (value === undefined || value === null) return null;
  return nonEmptyString(value, field, maxLength);
}

function nullableIso(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(new Date(value).valueOf())) {
    throw new Error(`${field} is invalid`);
  }
  return new Date(value).toISOString();
}

function normalizeTraffic(value) {
  assertAllowedKeys(value, TRAFFIC_FIELDS, 'traffic');
  const receivedBytes = value.receivedBytes;
  const sentBytes = value.sentBytes;
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0 || !Number.isSafeInteger(sentBytes) || sentBytes < 0) {
    throw new Error('traffic is invalid');
  }
  return Object.freeze({ receivedBytes, sentBytes });
}

function normalizeDevices(value) {
  if (!Array.isArray(value) || value.length > 32) throw new Error('devices is invalid');
  const ids = new Set();
  return Object.freeze(value.map((device) => {
    assertAllowedKeys(device, DEVICE_FIELDS, 'device');
    const sourceDeviceId = nonEmptyString(device.sourceDeviceId, 'sourceDeviceId');
    if (ids.has(sourceDeviceId)) throw new Error('sourceDeviceId must be unique per user');
    ids.add(sourceDeviceId);
    return Object.freeze({ sourceDeviceId, label: nullableString(device.label, 'device label') });
  }));
}

function normalizeUser(value) {
  assertAllowedKeys(value, USER_FIELDS, 'user');
  if (typeof value.enabled !== 'boolean' || typeof value.online !== 'boolean') throw new Error('user status is invalid');
  return Object.freeze({
    sourceUserId: nonEmptyString(value.sourceUserId, 'sourceUserId'),
    displayName: nullableString(value.displayName, 'displayName'),
    label: nullableString(value.label, 'label'),
    enabled: value.enabled,
    expiresAt: nullableIso(value.expiresAt, 'expiresAt'),
    traffic: normalizeTraffic(value.traffic),
    online: value.online,
    devices: normalizeDevices(value.devices),
    revision: nonEmptyString(value.revision, 'revision'),
    vkHashes: nullableString(value.vkHashes, 'vkHashes', 256) ?? '',
    ports: nullableString(value.ports, 'ports', 256) ?? '',
  });
}

export class FleetUserDirectory {
  #users = new Map();
  #snapshotByNodeId = new Map();
  #persist;

  constructor({ state = {}, persist = () => {} } = {}) {
    this.#persist = persist;
    for (const user of state.users ?? []) {
      if (!user?.nodeId || !user.sourceUserId) throw new Error('invalid persisted fleet user');
      this.#users.set(`${user.nodeId}\u0000${user.sourceUserId}`, Object.freeze({ ...user }));
    }
    for (const [nodeId, capturedAt] of Object.entries(state.snapshotByNodeId ?? {})) {
      this.#snapshotByNodeId.set(nodeId, capturedAt);
    }
  }

  ingestSnapshot(nodeId, { protocolVersion, capturedAt, users }) {
    if (protocolVersion !== PROTOCOL_VERSION) throw new Error('unsupported protocol version');
    if (!Array.isArray(users) || users.length > MAX_USERS_PER_SNAPSHOT) throw new Error('users is invalid');
    const snapshotAt = nullableIso(capturedAt, 'capturedAt') ?? new Date().toISOString();
    const normalizedUsers = users.map(normalizeUser);
    const sourceIds = new Set();
    for (const user of normalizedUsers) {
      if (sourceIds.has(user.sourceUserId)) throw new Error('sourceUserId must be unique per snapshot');
      sourceIds.add(user.sourceUserId);
    }

    for (const [key, user] of this.#users) {
      if (user.nodeId === nodeId) this.#users.delete(key);
    }
    for (const user of normalizedUsers) {
      const record = Object.freeze({ ...user, nodeId, capturedAt: snapshotAt });
      this.#users.set(`${nodeId}\u0000${user.sourceUserId}`, record);
    }
    this.#snapshotByNodeId.set(nodeId, snapshotAt);
    this.#persist();
    return { capturedAt: snapshotAt, userCount: normalizedUsers.length };
  }

  list({ nodeId } = {}) {
    return [...this.#users.values()]
      .filter((user) => !nodeId || user.nodeId === nodeId)
      .sort((left, right) => `${left.nodeId}:${left.sourceUserId}`.localeCompare(`${right.nodeId}:${right.sourceUserId}`));
  }

  snapshotAt(nodeId) {
    return this.#snapshotByNodeId.get(nodeId) ?? null;
  }

  exportState() {
    return {
      users: [...this.#users.values()],
      snapshotByNodeId: Object.fromEntries(this.#snapshotByNodeId),
    };
  }
}
