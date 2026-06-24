const USER_FIELD_NAMES = new Set([
  'displayName',
  'label',
  'expiresAt',
  'trafficLimitBytes',
  'enabled',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertAllowedKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unsupported payload field: ${key}`);
  }
}

function assertSourceUserId(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    throw new Error('sourceUserId is invalid');
  }
  return value.trim();
}

function assertRevision(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    throw new Error('expectedRevision is invalid');
  }
  return value.trim();
}

function assertIsoOrNull(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(new Date(value).valueOf())) {
    throw new Error(`${field} must be an ISO timestamp or null`);
  }
  return new Date(value).toISOString();
}

function normalizePatch(value) {
  if (!isPlainObject(value)) throw new Error('patch must be an object');
  const keys = Object.keys(value);
  if (keys.length === 0) throw new Error('patch cannot be empty');
  assertAllowedKeys(value, USER_FIELD_NAMES);

  const patch = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === 'displayName' || field === 'label') {
      if (fieldValue !== null && (typeof fieldValue !== 'string' || fieldValue.trim() === '' || fieldValue.length > 128)) {
        throw new Error(`${field} is invalid`);
      }
      patch[field] = fieldValue === null ? null : fieldValue.trim();
    } else if (field === 'expiresAt') {
      patch[field] = assertIsoOrNull(fieldValue, field);
    } else if (field === 'trafficLimitBytes') {
      if (fieldValue !== null && (!Number.isSafeInteger(fieldValue) || fieldValue < 0)) {
        throw new Error('trafficLimitBytes is invalid');
      }
      patch[field] = fieldValue;
    } else if (field === 'enabled') {
      if (typeof fieldValue !== 'boolean') throw new Error('enabled is invalid');
      patch[field] = fieldValue;
    }
  }
  return Object.freeze(patch);
}

export function normalizeCommandPayload(kind, payload) {
  if (!isPlainObject(payload)) throw new Error('payload must be an object');

  if (kind === 'node.snapshot.read') {
    assertAllowedKeys(payload, new Set());
    return Object.freeze({});
  }

  if (kind === 'user.read' || kind === 'user.delete') {
    assertAllowedKeys(payload, new Set(['sourceUserId']));
    return Object.freeze({ sourceUserId: assertSourceUserId(payload.sourceUserId) });
  }

  if (kind === 'user.create') {
    assertAllowedKeys(payload, new Set(['sourceUserId', ...USER_FIELD_NAMES]));
    const { sourceUserId, ...patch } = payload;
    return Object.freeze({ sourceUserId: assertSourceUserId(sourceUserId), ...normalizePatch(patch) });
  }

  if (kind === 'user.update') {
    assertAllowedKeys(payload, new Set(['sourceUserId', 'expectedRevision', 'patch']));
    return Object.freeze({
      sourceUserId: assertSourceUserId(payload.sourceUserId),
      expectedRevision: assertRevision(payload.expectedRevision),
      patch: normalizePatch(payload.patch),
    });
  }

  throw new Error('unsupported command kind');
}
