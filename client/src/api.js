// fetch helpers: parsed JSON, or an Error carrying the server's message.
async function request(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return data;
}

export const getJson = (url) => request('GET', url);
export const sendJson = (method, url, body) => request(method, url, body);

// SQLite UTC "YYYY-MM-DD HH:MM:SS" -> Date
export const fromSql = (ts) => new Date(`${ts.replace(' ', 'T')}Z`);
