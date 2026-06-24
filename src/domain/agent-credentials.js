import { createHash, randomBytes } from 'node:crypto';

function tokenDigest(token) {
  return createHash('sha256').update(token).digest('base64url');
}

function readBearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(authorization);
  return match?.[1] ?? null;
}

export class AgentCredentialStore {
  #credentials = new Map();
  #byNodeId = new Map();

  constructor({ nodeRegistry }) {
    this.nodeRegistry = nodeRegistry;
  }

  issue(nodeId) {
    const node = this.nodeRegistry.get(nodeId);
    if (!node || node.state !== 'active') throw new Error('node is not active');

    this.revoke(nodeId);
    const token = randomBytes(32).toString('base64url');
    const digest = tokenDigest(token);
    this.#credentials.set(digest, Object.freeze({ nodeId, createdAt: new Date().toISOString() }));
    this.#byNodeId.set(nodeId, digest);
    return token;
  }

  revoke(nodeId) {
    const digest = this.#byNodeId.get(nodeId);
    if (digest) this.#credentials.delete(digest);
    this.#byNodeId.delete(nodeId);
  }

  authenticate(request) {
    const token = readBearerToken(request);
    if (!token) return null;

    const credential = this.#credentials.get(tokenDigest(token));
    const node = credential && this.nodeRegistry.get(credential.nodeId);
    if (!node || node.state !== 'active') return null;
    return { nodeId: node.id };
  }
}

export function createBearerAgentAuthenticator({ credentialStore }) {
  return async (request) => credentialStore.authenticate(request);
}
