// Which game versions can play online together (src/net_compat.h).
//
// A build's "net compat" key is "<oldest protocol>-<protocol>/<simulation>":
// two builds play together when they run the same simulation and their
// network protocol ranges overlap. Builds from before this key have none and
// only play with exactly the same build. Shared by the Worker and the page
// (web/kfx_versions.js has the same function).

const COMPAT_RE = /^(\d{1,5})-(\d{1,5})\/(\d{1,10})$/;

export function parseCompat(text) {
  const m = typeof text === 'string' ? COMPAT_RE.exec(text) : null;
  if (!m) return null;
  const oldest = Number(m[1]); const protocol = Number(m[2]);
  return oldest <= protocol ? { oldest, protocol, sim: Number(m[3]) } : null;
}

export function compatOf(value) {
  return parseCompat(value) ? value : '';
}

/** Whether two compat keys can play together; false if either is missing. */
export function netCompatible(a, b) {
  const x = parseCompat(a); const y = parseCompat(b);
  return !!x && !!y && x.sim === y.sim && x.protocol >= y.oldest && y.protocol >= x.oldest;
}

/** Same game for matching: compatible keys when both have one, else the same build. */
export function sameGame(a, b) {
  if (a.compat && b.compat) return netCompatible(a.compat, b.compat);
  return (a.build || '') === (b.build || '');
}
