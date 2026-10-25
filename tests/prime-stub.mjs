// Standalone stub of the Bank of Canada Valet prime endpoint, for
// screenshot runs (the e2e suite has its own inline copy). Serves
// the real API's shape: prime 4.45% current, 4.70% before that.
//   node tests/prime-stub.mjs [port]
import http from 'node:http';

const port = Number(process.argv[2] || 9399);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    seriesDetail: { V80691311: { label: 'Prime rate' } },
    observations: [
      { d: '2026-10-21', V80691311: { v: '4.45' } },
      { d: '2026-10-14', V80691311: { v: '4.45' } },
      { d: '2026-10-07', V80691311: { v: '4.70' } },
    ],
  }));
}).listen(port, '127.0.0.1', () => console.log(`[prime-stub] listening on ${port}`));
