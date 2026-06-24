import { createServer } from 'node:http';
import { AgentCredentialStore, createBearerAgentAuthenticator } from '../domain/agent-credentials.js';
import { CommandQueue } from '../domain/command-queue.js';
import { EnrollmentService } from '../domain/enrollment-service.js';
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
  commandQueue = new CommandQueue(),
  nodeRegistry = new NodeRegistry(),
  agentCredentials = new AgentCredentialStore({ nodeRegistry }),
  enrollmentService = new EnrollmentService({ nodeRegistry, credentialStore: agentCredentials }),
  authenticateAgent = createBearerAgentAuthenticator({ credentialStore: agentCredentials }),
} = {}) {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;

      if (request.method === 'GET' && pathname === '/health') {
        return json(response, 200, { status: 'ok' });
      }

      if (request.method === 'POST' && pathname === '/v1/enrollment-grants') {
        const admin = await authenticateAdmin(request);
        if (!admin) return reject(response, 401, 'unauthenticated');
        const body = await readJson(request);
        const enrollment = enrollmentService.issueGrant(body);
        return json(response, 201, enrollment);
      }

      if (request.method === 'POST' && pathname === '/v1/agent/enroll') {
        const body = await readJson(request);
        const enrollment = enrollmentService.redeem(body);
        return json(response, 201, enrollment);
      }

      if (request.method === 'GET' && pathname === '/v1/nodes') {
        const admin = await authenticateAdmin(request);
        if (!admin) return reject(response, 401, 'unauthenticated');
        return json(response, 200, { nodes: nodeRegistry.list() });
      }

      const revokeMatch = /^\/v1\/nodes\/([^/]+)\/revoke$/.exec(pathname);
      if (request.method === 'POST' && revokeMatch) {
        const admin = await authenticateAdmin(request);
        if (!admin) return reject(response, 401, 'unauthenticated');
        const node = nodeRegistry.revoke(decodeURIComponent(revokeMatch[1]));
        agentCredentials.revoke(node.id);
        return json(response, 200, { node });
      }

      const rotateMatch = /^\/v1\/nodes\/([^/]+)\/credentials\/rotate$/.exec(pathname);
      if (request.method === 'POST' && rotateMatch) {
        const admin = await authenticateAdmin(request);
        if (!admin) return reject(response, 401, 'unauthenticated');
        const nodeId = decodeURIComponent(rotateMatch[1]);
        if (!nodeRegistry.get(nodeId)) return reject(response, 404, 'node_not_found');
        const agentToken = agentCredentials.issue(nodeId);
        return json(response, 200, { nodeId, agentToken });
      }

      if (request.method === 'POST' && pathname === '/v1/commands') {
        const admin = await authenticateAdmin(request);
        if (!admin) return reject(response, 401, 'unauthenticated');
        const body = await readJson(request);
        const node = nodeRegistry.get(body.nodeId);
        if (!node) return reject(response, 404, 'node_not_found');
        if (node.state !== 'active') return reject(response, 409, 'node_not_active');
        const command = commandQueue.enqueue(body);
        return json(response, 202, { command });
      }

      if (request.method === 'POST' && pathname === '/v1/agent/heartbeat') {
        const agent = await authenticateAgent(request);
        if (!agent?.nodeId) return reject(response, 401, 'unauthenticated');
        const body = await readJson(request);
        const node = nodeRegistry.heartbeat(agent.nodeId, body);
        return json(response, 200, { nodeId: node.id, lastSeenAt: node.lastSeenAt });
      }

      if (request.method === 'GET' && pathname === '/v1/agent/commands') {
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
