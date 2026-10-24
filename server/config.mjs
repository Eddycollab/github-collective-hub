// Server settings, read once from the environment. Error messages name missing variables, never values.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const LIBRARY_REPO = 'Eddycollab/github-library-collection-';
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const loopbackUrl = (s) => {
  try { const u = new URL(s); return u.protocol === 'http:' && LOOPBACK.has(u.hostname) ? u.origin : null; } catch { return null; }
};

export function readConfig(env = process.env) {
  const missing = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SESSION_SECRET', 'ALLOWED_GITHUB_ID', 'LIBRARY_TOKEN', 'PUBLIC_URL']
    .filter((k) => !String(env[k] || '').trim());
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`);
  const problems = [];
  const secret = String(env.SESSION_SECRET);
  if (secret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters (use a random value)');
  const allowedId = String(env.ALLOWED_GITHUB_ID).trim();
  if (!/^[1-9][0-9]{0,15}$/.test(allowedId)) problems.push('ALLOWED_GITHUB_ID must be the numeric GitHub user id');
  let publicUrl = null;
  try {
    const u = new URL(String(env.PUBLIC_URL).trim());
    if (u.protocol === 'https:' || loopbackUrl(u.href)) publicUrl = u.origin;
  } catch { /* reported below */ }
  if (!publicUrl) problems.push('PUBLIC_URL must be the https origin of this service (http only for localhost)');
  const repo = String(env.LIBRARY_REPO || LIBRARY_REPO).trim();
  if (!REPO_RE.test(repo)) problems.push('LIBRARY_REPO must look like owner/repo');
  // Test and local-preview hooks: other GitHub endpoints are honoured only on loopback.
  const apiUrl = env.GITHUB_API_URL ? loopbackUrl(env.GITHUB_API_URL) : 'https://api.github.com';
  const oauthUrl = env.GITHUB_OAUTH_URL ? loopbackUrl(env.GITHUB_OAUTH_URL) : 'https://github.com';
  if (!apiUrl || !oauthUrl) problems.push('GITHUB_API_URL / GITHUB_OAUTH_URL may only point at localhost');
  if (problems.length) throw new Error(problems.join('; '));
  return Object.freeze({
    clientId: String(env.GITHUB_CLIENT_ID).trim(),
    clientSecret: String(env.GITHUB_CLIENT_SECRET).trim(),
    sessionSecret: secret,
    allowedId: Number(allowedId),
    libraryToken: String(env.LIBRARY_TOKEN).trim(),
    libraryRepo: repo,
    publicUrl,
    secure: publicUrl.startsWith('https:'),
    apiUrl,
    oauthUrl,
    port: Number(env.PORT) || 8080,
  });
}
