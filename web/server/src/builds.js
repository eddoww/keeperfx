// Engine builds and their game data for the version selector
// (web/kfx_versions.js), laid out by web/publish-build.py:
//   /builds/index.json       which builds exist (always revalidated)
//   /builds/<id>/...         keeperfx.js, keeperfx.wasm, manifest.json (immutable)
//   /data/<hash>[.partN]     game data shared by the builds (immutable)
// With BUILDS_FROM "r2" they come from the DATA bucket (uploaded by
// web/upload-builds.sh), else from the static site. Production can skip the
// Worker for these by setting BUILDS_URL to the bucket's public domain.

const KEY_RE = /^(builds\/(index\.json|[A-Za-z0-9._-]{1,64}\/(keeperfx\.js|keeperfx\.wasm|manifest\.json))|data\/[0-9a-f]{8,64}(\.part\d{1,3})?)$/;

export async function serveBuilds(request, env, url) {
  if (env.BUILDS_FROM !== 'r2' || !env.DATA) return env.ASSETS.fetch(request);
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const key = decodeURIComponent(url.pathname.slice(1));
  if (!KEY_RE.test(key)) return new Response('Not found', { status: 404 });
  const object = await env.DATA.get(key, { onlyIf: request.headers });
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  if (key === 'builds/index.json') headers.set('Cache-Control', 'no-cache');
  else if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', key.endsWith('.wasm') ? 'application/wasm'
      : key.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : key.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  }
  if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}
