import { createServer } from 'node:http';
import { CommandQueue } from '../domain/command-queue.js';
import { NodeRegistry } from '../domain/node-registry.js';

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new Error('request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function reject(response, status, code) {
  json(response, status, { error: { code } });
}

export function createApp({
  authenticateAdmin = async () => null,
  authenticateAgent = async () => null,
  commandQueue = new CommandQueue(),
  nodeRegistry = new NodeRegistry(),
} = {}) {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        return json(response, 200, { status: 'ok' });
      }

      if (request.method === 'POST' && request.url === '/v1/nodes') {
        const admin = await authenticateAdmin(request);
        if (!admin) return reject(response, 401, 'unauthenticated');
        const body = await readJson(request);
        const node = nodeRegistry.register(body);
        return json(response, 201, { node });
      }

      if (request.method === 'POST' && request.url === '/v1/commands') {
        const admin = await authenticateAdmin(request);
        if (!admin) return reject(response, 401, 'unauthenticated');
        const body = await readJson(request);
        if (!nodeRegistry.get(body.nodeId)) return reject(response, 404, 'node_not_found');
        const command = commandQueue.enqueue(body);
        return json(response, 202, { command });
      }

      if (request.method === 'POST' && request.url === '/v1/agent/heartbeat') {
        const agent = await authenticateAgent(request);
        if (!agent?.nodeId) return reject(response, 401, 'unauthenticated');
        const node = nodeRegistry.heartbeat(agent.nodeId);
        return json(response, 200, { nodeId: node.id, lastSeenAt: node.lastSeenAt });
      }

      if (request.method === 'GET' && request.url === '/v1/agent/commands') {
        const agent = await authenticateAgent(request);
        if (!agent?.nodeId) return reject(response, 401, 'unauthenticated');
        return json(response, 200, { commands: commandQueue.poll(agent.nodeId) });
      }

      return reject(response, 404, 'not_found');
    } catch (error) {
      if (error instanceof SyntaxError) return reject(response, 400, 'invalid_json');
      return reject(response, 400, 'invalid_request');
    }
  });
}
