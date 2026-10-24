// Which GitHub API calls the page may make through /api/gh, and nothing else. Mirrors the calls in
// web/lib/library.mjs: the private library (fixed repo) gets exactly the reads and writes the page
// performs; public repositories being collected are read-only. Writes never touch .github/ or any
// path the page does not own.

const ID = '[0-9]{8}-[0-9]{6}-[0-9a-f]{4,8}';
const STEM = '[a-z0-9._-]+__[a-z0-9._-]+';
const OBJ = '[A-Za-z0-9-]{1,80}'; // a commit/tree sha (the local preview uses other ids)
const BRANCH = '[A-Za-z0-9._-]{1,100}';
const REF = '[A-Za-z0-9._~%-]{1,200}(?:/[A-Za-z0-9._~%-]{1,200}){0,20}';
const re = (s) => new RegExp(`^${s}$`);

const LIBRARY = {
  GET: [
    [re(''), []],
    [re('/contents/(?:index\\.json|user\\.json|README\\.md)'), ['ref']],
    [re('/contents/inbox(?:/failed)?'), []],
    [re(`/contents/inbox/(?:failed/)?${ID}\\.json`), []],
    [re(`/contents/library/${STEM}\\.(?:md|json|svg)`), ['ref']],
    [re(`/git/ref/heads/${BRANCH}`), []],
    [re(`/git/commits/${OBJ}`), []],
    [re(`/git/trees/${OBJ}`), []],
    [re('/actions/runs'), ['status', 'per_page']],
  ],
  PUT: [[re(`/contents/inbox/${ID}\\.json`), []], [re('/contents/user\\.json'), []]],
  DELETE: [[re(`/contents/inbox/(?:failed/)?${ID}\\.json`), []]],
  POST: [[re('/git/trees'), []], [re('/git/commits'), []]],
  PATCH: [[re(`/git/refs/heads/${BRANCH}`), []]],
};

const PUBLIC = {
  GET: [
    [re(''), []],
    [re(`/git/matching-refs/(?:heads|tags)/${REF}`), []],
    [re(`/git/trees/${REF}`), ['recursive']],
  ],
};

// Paths a removal commit (POST /git/trees) may change.
const TREE_PATH = re(`library/${STEM}\\.(?:md|json|svg)|index\\.json|README\\.md|user\\.json`);

const REPO_PATH = /^\/api\/gh\/repos\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(\/[^?#]*)?$/;

// -> { ok: true, repo, rest, library } or { ok: false, status, reason }
export function checkRequest({ method, pathname, query, body }, libraryRepo) {
  const m = REPO_PATH.exec(pathname);
  if (!m) return { ok: false, status: 404, reason: 'not an allowed path' };
  const repo = `${m[1]}/${m[2]}`, rest = m[3] || '';
  if (rest.split('/').some((seg) => seg === '..' || seg === '.') || /%2e%2e|%2f|%5c/i.test(rest)) return { ok: false, status: 400, reason: 'bad path' };
  const library = repo.toLowerCase() === libraryRepo.toLowerCase();
  const rules = (library ? LIBRARY : PUBLIC)[method];
  const rule = rules && rules.find(([r]) => r.test(rest));
  if (!rule) return { ok: false, status: 403, reason: library ? 'operation not allowed on the library' : 'public repositories are read-only' };
  for (const key of query.keys()) if (!rule[1].includes(key)) return { ok: false, status: 400, reason: `query ${key} not allowed` };
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) return { ok: false, status: 400, reason: 'body must be a JSON object' };
  if (method === 'PATCH' && body && body.force === true) return { ok: false, status: 403, reason: 'force updates are not allowed' };
  if (method === 'POST' && rest === '/git/trees') {
    const tree = body && body.tree;
    if (!Array.isArray(tree) || !tree.every((t) => t && typeof t.path === 'string' && TREE_PATH.test(t.path) && (t.mode === undefined || t.mode === '100644'))) {
      return { ok: false, status: 403, reason: 'tree may only change library entries, index.json, README.md or user.json' };
    }
  }
  return { ok: true, repo, rest, library };
}
