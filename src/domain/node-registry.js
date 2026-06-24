import { randomUUID } from 'node:crypto';

function normalizeLabel(label) {
  if (typeof label !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(label)) {
    throw new Error('label must use 1-63 letters, numbers or hyphens');
  }
  return label.toLowerCase();
}

export class NodeRegistry {
  #nodes = new Map();
  #byLabel = new Map();

  register({ label, identityFingerprint }) {
    const normalizedLabel = normalizeLabel(label);
    if (this.#byLabel.has(normalizedLabel)) throw new Error('node label already exists');
    if (typeof identityFingerprint !== 'string' || identityFingerprint.length < 16) {
      throw new Error('identityFingerprint is invalid');
    }
    const node = Object.freeze({
      id: randomUUID(),
      label: normalizedLabel,
      identityFingerprint,
      state: 'active',
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    });
    this.#nodes.set(node.id, node);
    this.#byLabel.set(normalizedLabel, node.id);
    return node;
  }

  heartbeat(nodeId) {
    const current = this.#nodes.get(nodeId);
    if (!current || current.state !== 'active') throw new Error('node is not active');
    const updated = Object.freeze({ ...current, lastSeenAt: new Date().toISOString() });
    this.#nodes.set(nodeId, updated);
    return updated;
  }

  get(nodeId) {
    return this.#nodes.get(nodeId);
  }
}
