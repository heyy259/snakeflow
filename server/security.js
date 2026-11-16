import crypto from 'node:crypto';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostPortOf(req) {
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (!host) return { hostname: '', port: '' };
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return { hostname: host, port: '' };
    const hostname = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    return { hostname, port: rest.startsWith(':') ? rest.slice(1) : '' };
  }
  const colon = host.lastIndexOf(':');
  if (colon < 0) return { hostname: host, port: '' };
  return { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

export function createSecurityGate({ port = 5173 } = {}) {
  const sessionSecret = process.env.RF_SESSION_SECRET || crypto.randomBytes(24).toString('hex');
  let currentPort = Number(port) || 5173;
  const insecureTest = process.env.RF_ALLOW_INSECURE_TEST === '1';

  function allowedOrigins() {
    return [`http://127.0.0.1:${currentPort}`, `http://localhost:${currentPort}`];
  }

  function isAllowedBootstrap(req) {
    if (insecureTest) return true;
    const { hostname, port } = hostPortOf(req);
    if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
    if (port && Number(port) !== currentPort) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    return allowedOrigins().includes(String(origin).replace(/\/$/, ''));
  }

  function hasSession(req) {
    return req.headers['x-rf-session'] === sessionSecret
      || req.headers.authorization === `Bearer ${sessionSecret}`;
  }

  function isAllowedHttp(req) {
    if (insecureTest) return true;
    if (!isAllowedBootstrap(req)) return false;
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/session') return true;
    return hasSession(req);
  }

  function isAllowedUpgrade(req) {
    if (insecureTest) return true;
    if (!isAllowedBootstrap(req)) return false;
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('s') === sessionSecret || hasSession(req);
  }

  return {
    sessionSecret,
    isAllowedBootstrap,
    isAllowedHttp,
    isAllowedUpgrade,
    setPort(port) {
      currentPort = Number(port) || currentPort;
    },
  };
}
