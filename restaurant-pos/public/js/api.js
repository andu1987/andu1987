// Small JSON API client. Errors carry the server's message and HTTP status.
async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error("Cannot reach the restaurant server. Check the network and that the server is running.");
    err.network = true;
    throw err;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    if (res.status === 401 && api.onUnauthorized) api.onUnauthorized();
    throw err;
  }
  return data;
}

export const api = {
  get: (u) => request("GET", u),
  post: (u, b = {}) => request("POST", u, b),
  put: (u, b = {}) => request("PUT", u, b),
  patch: (u, b = {}) => request("PATCH", u, b),
  del: (u) => request("DELETE", u, {}),
  onUnauthorized: null,
};
