// Tiny response helpers shared by the local server and the Vercel functions (no heavy imports).
export function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.end(html);
}

export function sendJson(res, { status, body, html, headers }) {
  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
  if (html !== undefined) return sendHtml(res, status, html);   // a route may answer a page (the Google callback)
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
