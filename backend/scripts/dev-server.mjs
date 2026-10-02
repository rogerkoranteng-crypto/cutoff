// Local preview: the real Lambda handler behind a plain HTTP server, in-memory store.
import http from 'node:http';
import fs from 'node:fs';
for (const l of fs.readFileSync(new URL('../../../../.env', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
process.env.STORE = 'memory';
process.env.LIVE_DISPUTE_IDS ??= 'PP-R-IQQ-10190238';
if (process.env.NO_MODEL === '1') process.env.BEDROCK_DISABLED = '1';
const { handle } = await import('../src/handler.js');
const port = Number(process.env.PORT || 8787);
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://x');
  const r = await handle({ requestContext: { http: { method: req.method, path: url.pathname } }, headers: req.headers, queryStringParameters: Object.fromEntries(url.searchParams), body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
  res.writeHead(r.statusCode, r.headers); res.end(r.body);
}).listen(port, () => console.log('dev api on', port));
