import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
const password = randomBytes(24).toString('hex');
process.env.MVP_AUTH_REQUIRED = '1';
process.env.MVP_ACCESS_PASSWORD = password;
process.env.MVP_COOKIE_SECURE = '1';
const { allowRequest, readBody } = await import('./access.mjs');
const server = http.createServer(async (req, res) => {
  try {
    if (!await allowRequest(req, res)) return;
    if (req.method === 'POST') await readBody(req);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"authorized":true}');
  } catch (error) { res.writeHead(error.statusCode || 500); res.end('error'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await fetch(base + '/health')).status, 200);
  const denied = await fetch(base + '/catalog', { redirect: 'manual' });
  assert.equal(denied.status, 303); assert.ok(denied.headers.get('location').startsWith('/login'));
  assert.equal((await fetch(base + '/api/chat', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ password: 'wrong' }) })).status, 401);
  const login = await fetch(base + '/login?next=%2Fcatalog', { method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual' });
  assert.equal(login.status, 303); assert.equal(login.headers.get('location'), '/catalog');
  const cookie = login.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(cookie.includes(flag));
  const headers = { Cookie: cookie.split(';')[0] };
  assert.equal((await fetch(base + '/catalog', { headers })).status, 200);
  assert.equal((await fetch(base + '/api/chat', { method: 'POST', headers, body: 'x'.repeat(17000) })).status, 413);
  assert.equal((await fetch(base + '/catalog', { headers: { Cookie: headers.Cookie + 'broken' }, redirect: 'manual' })).status, 303);
  const expired = headers.Cookie.replace(/=\d+\./, '=1.');
  assert.equal((await fetch(base + '/catalog', { headers: { Cookie: expired }, redirect: 'manual' })).status, 303);
  const redirect = await fetch(base + '/login?next=%2F%2Fevil.invalid', { method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), '/');
  console.log('PASS cloud access: protected reads/writes, login, cookie flags, tamper/expiry rejection, body cap, local redirects; no model calls or deployment.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
