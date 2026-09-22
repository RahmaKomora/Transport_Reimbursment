// All backend calls go through here. Vite proxies /api to the Express server in
// development (see vite.config.js), so there is no host to configure.
const TOKEN_KEY = 'songa.session';

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
};
const setToken = (token) => {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
};

// The two failures that are about the setup rather than the request, phrased so the
// person reading them knows what to do. A 502 comes from the Vite proxy when nothing is
// listening on the API port; a 503 is the API itself saying it cannot reach the sheet.
const API_DOWN = 'The Songa API is not running. Start it with "npm run dev:all" (or "npm run server" in a second terminal), then try again.';

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch only rejects when the request never completed — the dev server itself is down.
    const error = new Error(API_DOWN);
    error.status = 0;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || (response.status === 502 || response.status === 504 ? API_DOWN : `Request failed (${response.status})`));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export const api = {
  health: () => request('/health'),
  login: async (email) => {
    const result = await request('/auth/login', { method: 'POST', body: { email } });
    setToken(result.token);
    return result.user;
  },
  logout: () => setToken(''),
  me: () => request('/me'),
  alerts: () => request('/alerts'),
  previewClaim: (amount) => request('/claims/preview', { method: 'POST', body: { amount } }),
  submitClaim: (claim) => request('/claims', { method: 'POST', body: claim }),
  myClaims: () => request('/claims/mine'),
  reviewQueue: () => request('/claims/review'),
  managerClaims: () => request('/claims/manager'),
  liveClaims: () => request('/claims/live'),
  approvedClaims: () => request('/claims/approved'),
  paidClaims: () => request('/claims/paid'),
  runBatch: (cycleKey, force) => request('/batches/run', { method: 'POST', body: { cycleKey, force } }),
  refreshSheet: () => request('/admin/refresh', { method: 'POST' }),
  configStatus: () => request('/admin/config'),
  savings: (cycle) => request(`/analytics/savings${cycle ? `?cycle=${cycle}` : ''}`),
  // The proof endpoint needs the auth header, so it cannot be an <img src>. Fetch the
  // bytes and hand back an object URL the caller must revoke when it is done.
  proofObjectUrl: async (id) => {
    const response = await fetch(`/api/claims/${id}/proof`, { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'The proof image could not be loaded.');
    }
    return URL.createObjectURL(await response.blob());
  },
  decide: (id, action, note) => request(`/claims/${id}/decision`, { method: 'POST', body: { action, note } }),
};
