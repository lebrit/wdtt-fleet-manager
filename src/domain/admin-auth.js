import { timingSafeEqual } from 'node:crypto';

function equal(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createBearerAdminAuthenticator({ token }) {
  return async (request) => {
    if (typeof token !== 'string' || token.length < 32) return null;
    const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(request.headers.authorization ?? '');
    return match && equal(match[1], token) ? { subject: 'env-admin-token' } : null;
  };
}

export function createAdminAuthenticator({ token, trustProxy = false }) {
  const bearerAuthenticator = createBearerAdminAuthenticator({ token });
  return async (request) => {
    const bearerAdmin = await bearerAuthenticator(request);
    if (bearerAdmin) return bearerAdmin;
    const proxiedOperator = request.headers['x-wdtt-fleet-operator'];
    if (trustProxy && typeof proxiedOperator === 'string' && /^[a-zA-Z0-9_.@-]{1,128}$/.test(proxiedOperator)) {
      return { subject: `proxy:${proxiedOperator}` };
    }
    return null;
  };
}
