import { createApp } from './http/app.js';
import { createAdminAuthenticator } from './domain/admin-auth.js';
import { JsonStateStore } from './domain/state-store.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '127.0.0.1';
const stateStore = process.env.STATE_FILE ? new JsonStateStore({ filePath: process.env.STATE_FILE }) : undefined;
const app = createApp({
  authenticateAdmin: createAdminAuthenticator({
    token: process.env.ADMIN_API_TOKEN,
    trustProxy: process.env.TRUST_PROXY_ADMIN === 'true',
  }),
  stateStore,
  agentEndpoint: process.env.AGENT_ENDPOINT,
});

app.listen(port, host, () => {
  console.log(`WDTT Fleet Manager listening on ${host}:${port}`);
});
