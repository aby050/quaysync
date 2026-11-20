// Local sync server for the example app. Data lives in memory.
// Run: npm run example:server   (listens on http://localhost:8911/sync)
import http from 'node:http';
import { createSyncHandler, memoryBackend } from '../packages/server/dist/index.js';

const PORT = Number(process.env.PORT ?? 8911);
const sync = createSyncHandler({
  backend: memoryBackend(),
  // Demo only: every caller shares one space. In production, verify a token here.
  authorize: (req) => req.headers.get('x-demo-space') ?? 'demo',
});

http
  .createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-demo-space',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const response = await sync(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      }),
    );
    res.writeHead(response.status, { ...cors, 'content-type': 'application/json' });
    res.end(await response.text());
  })
  .listen(PORT, () => console.log(`QuaySync dev server on http://localhost:${PORT}/sync`));
