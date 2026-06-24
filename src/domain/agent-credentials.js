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
  #persist;

  constructor({ nodeRegistry, state = {}, persist = () => {} }) {
    this.nodeRegistry = nodeRegistry;
    this.#persist = persist;
    for (const credential of state.credentials ?? []) {
      if (!credential?.digest || !credential.nodeId || !nodeRegistry.get(credential.nodeId)) continue;
      this.#credentials.set(credential.digest, Object.freeze({ nodeId: credential.nodeId, createdAt: credential.createdAt }));
      this.#byNodeId.set(credential.nodeId, credential.digest);
    }
  }

  issue(nodeId, { persist = true } = {}) {
    const node = this.nodeRegistry.get(nodeId);
    if (!node || node.state !== 'active') throw new Error('node is not active');

    this.revoke(nodeId, { persist: false });
    const token = randomBytes(32).toString('base64url');
    const digest = tokenDigest(token);
    this.#credentials.set(digest, Object.freeze({ nodeId, createdAt: new Date().toISOString() }));
    this.#byNodeId.set(nodeId, digest);
    if (persist) this.#persist();
    return token;
  }

  revoke(nodeId, { persist = true } = {}) {
    const digest = this.#byNodeId.get(nodeId);
    if (digest) this.#credentials.delete(digest);
    this.#byNodeId.delete(nodeId);
    if (persist) this.#persist();
  }

  authenticate(request) {
    const token = readBearerToken(request);
    if (!token) return null;

    const credential = this.#credentials.get(tokenDigest(token));
    const node = credential && this.nodeRegistry.get(credential.nodeId);
    if (!node || node.state !== 'active') return null;
    return { nodeId: node.id };
  }

  exportState() {
    return {
      credentials: [...this.#credentials.entries()].map(([digest, credential]) => ({ digest, ...credential })),
    };
  }
}

export function createBearerAgentAuthenticator({ credentialStore }) {
  return async (request) => credentialStore.authenticate(request);
}
