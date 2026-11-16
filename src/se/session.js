let secret = '';
let inflight = null;

export async function getSessionSecret() {
  if (secret) return secret;
  if (!inflight) {
    inflight = fetch('/api/session')
      .then(async (res) => {
        if (!res.ok) throw new Error(`session bootstrap failed: HTTP ${res.status}`);
        const data = await res.json();
        secret = String(data && data.session ? data.session : '');
        return secret;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function installApiSession() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const original = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input && input.url ? input.url : '');
    if (url.startsWith('/api/') && url !== '/api/session') {
      const session = await getSessionSecret();
      const headers = new Headers(init.headers || (typeof input === 'object' && input.headers) || {});
      headers.set('X-RF-Session', session);
      init = { ...init, headers };
    }
    return original(input, init);
  };
}
