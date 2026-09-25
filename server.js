// Thin HTTP wrapper around nsm.js - a single GET /api/reports endpoint,
// nothing else. No static frontend, no auth, no caching, no digest/push,
// no dependencies beyond Node's own http module.
const http = require('http');
const { URL } = require('url');
const { fetchReports } = require('./nsm');

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/reports') {
    const { status, body } = await fetchReports({
      leis: url.searchParams.get('leis'),
      days: url.searchParams.get('days'),
    });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`fca-nsm-api listening on :${PORT}`);
});
