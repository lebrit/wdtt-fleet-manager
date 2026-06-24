import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizeNodeLabel } from './node-registry.js';

const DEFAULT_GRANT_TTL_MS = 15 * 60_000;
const MAX_GRANT_TTL_MS = 24 * 60 * 60_000;

function digest(token) {
  return createHash('sha256').update(token).digest('base64url');
}

function parseExpiry(expiresAt) {
  if (expiresAt === undefined) return new Date(Date.now() + DEFAULT_GRANT_TTL_MS);
  if (typeof expiresAt !== 'string') throw new Error('expiresAt must be an ISO timestamp');
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.valueOf()) || parsed <= new Date()) throw new Error('expiresAt must be in the future');
  if (parsed.valueOf() - Date.now() > MAX_GRANT_TTL_MS) throw new Error('expiresAt is too far in the future');
  return parsed;
}

export class EnrollmentService {
  #grants = new Map();
  #activeGrantByLabel = new Map();

  constructor({ nodeRegistry, credentialStore }) {
    this.nodeRegistry = nodeRegistry;
    this.credentialStore = credentialStore;
  }

  issueGrant({ label, expiresAt }) {
    const normalizedLabel = normalizeNodeLabel(label);
    this.#discardExpiredGrants();
    if (this.nodeRegistry.findByLabel(normalizedLabel) || this.#activeGrantByLabel.has(normalizedLabel)) {
      throw new Error('node label already exists or is awaiting enrollment');
    }

    const expiry = parseExpiry(expiresAt);
    const token = randomBytes(32).toString('base64url');
    const tokenDigest = digest(token);
    const grant = Object.freeze({
      id: randomUUID(),
      label: normalizedLabel,
      expiresAt: expiry.toISOString(),
      createdAt: new Date().toISOString(),
    });
    this.#grants.set(tokenDigest, grant);
    this.#activeGrantByLabel.set(normalizedLabel, tokenDigest);
    return { grant, token };
  }

  redeem({ token, identityFingerprint }) {
    if (typeof token !== 'string' || token.length < 32) throw new Error('invalid enrollment grant');
    const tokenDigest = digest(token);
    const grant = this.#grants.get(tokenDigest);
    if (!grant || new Date(grant.expiresAt) <= new Date()) {
      if (grant) this.#discardGrant(tokenDigest, grant);
      throw new Error('invalid enrollment grant');
    }

    const node = this.nodeRegistry.register({
      label: grant.label,
      identityFingerprint,
    });
    const agentToken = this.credentialStore.issue(node.id);
    this.#discardGrant(tokenDigest, grant);
    return { node, agentToken };
  }

  #discardExpiredGrants() {
    const now = new Date();
    for (const [tokenDigest, grant] of this.#grants) {
      if (new Date(grant.expiresAt) <= now) this.#discardGrant(tokenDigest, grant);
    }
  }

  #discardGrant(tokenDigest, grant) {
    this.#grants.delete(tokenDigest);
    this.#activeGrantByLabel.delete(grant.label);
  }
}
