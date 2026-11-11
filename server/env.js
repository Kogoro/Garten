// Environment for child processes (git, ssh, ssh-keygen): only what they need, never the server's secrets
// (SECRET_KEY, SMTP_URL, OIDC_CLIENT_SECRET, ADMIN_PASSWORD …).
const PASS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE', 'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'];
export function childEnv(extra = {}) {
  const env = {};
  for (const k of PASS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, LC_ALL: 'C', LANGUAGE: 'C', ...extra };
}
