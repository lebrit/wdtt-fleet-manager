import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from './protocol.js';

export function normalizeNodeLabel(label) {
  if (typeof label !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(label)) {
    throw new Error('label must use 1-63 letters, numbers or hyphens');
  }
  return label.toLowerCase();
}

export class NodeRegistry {
  #nodes = new Map();
  #byLabel = new Map();
  #byIdentityFingerprint = new Map();
  #persist;

  constructor({ state = {}, persist = () => {} } = {}) {
    this.#persist = persist;
    for (const node of state.nodes ?? []) {
      if (!node?.id || !node.label || !node.identityFingerprint) throw new Error('invalid persisted node');
      const restored = Object.freeze({ ...node });
      this.#nodes.set(restored.id, restored);
      this.#byLabel.set(restored.label, restored.id);
      this.#byIdentityFingerprint.set(restored.identityFingerprint, restored.id);
    }
  }

  register({ label, identityFingerprint }, { persist = true } = {}) {
    const normalizedLabel = normalizeNodeLabel(label);
    if (this.#byLabel.has(normalizedLabel)) throw new Error('node label already exists');
    if (typeof identityFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(identityFingerprint)) {
      throw new Error('identityFingerprint is invalid');
    }
    const normalizedFingerprint = identityFingerprint.toLowerCase();
    if (this.#byIdentityFingerprint.has(normalizedFingerprint)) throw new Error('node identity already exists');
    const node = Object.freeze({
      id: randomUUID(),
      label: normalizedLabel,
      identityFingerprint: normalizedFingerprint,
      state: 'active',
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    });
    this.#nodes.set(node.id, node);
    this.#byLabel.set(normalizedLabel, node.id);
    this.#byIdentityFingerprint.set(normalizedFingerprint, node.id);
    if (persist) this.#persist();
    return node;
  }

  heartbeat(nodeId, { protocolVersion, agentVersion, panelAdapterVersion } = {}) {
    const current = this.#nodes.get(nodeId);
    if (!current || current.state !== 'active') throw new Error('node is not active');
    if (protocolVersion !== PROTOCOL_VERSION) throw new Error('unsupported protocol version');
    for (const [field, value] of Object.entries({ agentVersion, panelAdapterVersion })) {
      if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
        throw new Error(`${field} is invalid`);
      }
    }
    const updated = Object.freeze({
      ...current,
      lastSeenAt: new Date().toISOString(),
      reportedVersions: Object.freeze({ protocolVersion, agentVersion, panelAdapterVersion }),
    });
    this.#nodes.set(nodeId, updated);
    this.#persist();
    return updated;
  }

  get(nodeId) {
    return this.#nodes.get(nodeId);
  }

  findByLabel(label) {
    const nodeId = this.#byLabel.get(normalizeNodeLabel(label));
    return nodeId ? this.#nodes.get(nodeId) : null;
  }

  list() {
    return [...this.#nodes.values()];
  }

  revoke(nodeId) {
    const current = this.#nodes.get(nodeId);
    if (!current) throw new Error('node was not found');
    if (current.state === 'revoked') return current;
    const updated = Object.freeze({ ...current, state: 'revoked', revokedAt: new Date().toISOString() });
    this.#nodes.set(nodeId, updated);
    this.#persist();
    return updated;
  }

  exportState() {
    return { nodes: [...this.#nodes.values()] };
  }
}
