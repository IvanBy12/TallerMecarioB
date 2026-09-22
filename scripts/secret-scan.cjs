'use strict';

// Security Baseline §2/§20: secret scan required, .env/credentials must never
// enter Git. No dedicated scanner (gitleaks/trufflehog) is installed in this
// environment, so this is a small, dependency-free scanner over
// `git ls-files` (never node_modules, never gitignored files) plus an
// independent check of the FULL commit history for tracked .env files.
//
// It only ever prints file path + line number + pattern NAME, never the
// matched text -- so running this script cannot itself leak a secret into
// CI logs (AGENTS.md invariant 13).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

const SECRET_PATTERNS = [
  { name: 'AWS/R2 access key ID', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'PEM private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'Clerk secret key', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { name: 'Wompi private key', regex: /\bprv_(?:prod|test|stag)_[A-Za-z0-9]{10,}/ },
  { name: 'PostgreSQL/connection string with embedded password', regex: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:/\s'"]+:[^@/\s'"]+@/i },
  { name: 'JWT-shaped token literal', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // Generic "keyword: 'long literal'" assignment -- deliberately requires an
  // actual `:`/`=` immediately after the keyword so it does not fire on SQL
  // like `PASSWORD '${var}'` or JS identifiers such as `loginPassword`.
  { name: 'generic secret-shaped literal assignment', regex: /\b(?:secret|token|api[_-]?key|access[_-]?key|password|passwd)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{20,}['"]/i },
];

// Paths that legitimately contain the string patterns above as *source code*
// describing the scanner itself, or as a values-empty template -- never as a
// live secret.
const ALLOWLIST_FILES = new Set(['scripts/secret-scan.cjs', '.env.example']);

// Exact, reviewed false positives, each with why it is not a real secret
// (gitleaks-style fingerprint allowlist, kept in source so it is visible in
// review instead of a silent side file). Add an entry here only for a
// verified non-secret; never to silence a real finding.
const ALLOWLIST_MATCHES = new Set([
  // GitHub Actions `services.postgres` container: fixed, publicly-documented
  // placeholder credential for an ephemeral CI-only loopback database, not a
  // real secret -- same convention as the Postgres Docker image's own docs.
  '.github/workflows/ci.yml:30',
]);

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.eot', '.lock',
]);

function isTrackedEnvFile(relativePath) {
  const base = path.posix.basename(relativePath.replace(/\\/g, '/'));
  return /^\.env(\..+)?$/.test(base) && base !== '.env.example';
}

function scanTrackedFiles() {
  const files = git(['ls-files']).split('\n').filter(Boolean);
  const findings = [];

  for (const file of files) {
    if (isTrackedEnvFile(file)) {
      findings.push({ file, line: 0, pattern: 'tracked .env-like file (must be gitignored)' });
      continue;
    }
    if (ALLOWLIST_FILES.has(file)) continue;
    const ext = path.extname(file).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) continue;

    const fullPath = path.join(REPO_ROOT, file);
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue; // binary/unreadable/deleted-but-still-listed: skip, not a text secret carrier
    }
    if (content.includes('\u0000')) continue; // binary heuristic

    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      const lineNumber = idx + 1;
      if (ALLOWLIST_MATCHES.has(`${file}:${lineNumber}`)) return;
      for (const { name, regex } of SECRET_PATTERNS) {
        if (regex.test(line)) findings.push({ file, line: lineNumber, pattern: name });
      }
    });
  }

  return findings;
}

// Independent of the working tree: a secret committed once and later
// deleted still lives in history (Security Baseline §2: "nunca asumir que
// borrar el archivo en un commit elimina el secreto del historial").
function scanHistoryForEnvFiles() {
  let log;
  try {
    log = git(['log', '--all', '--full-history', '--name-only', '--pretty=format:']);
  } catch {
    return []; // shallow clone without history: nothing more we can check here
  }
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isTrackedEnvFile(line));
}

function main() {
  const fileFindings = scanTrackedFiles();
  const historyHits = [...new Set(scanHistoryForEnvFiles())];

  if (fileFindings.length === 0 && historyHits.length === 0) {
    process.stdout.write('SECRET_SCAN_PASS\n');
    return;
  }

  for (const f of fileFindings) {
    process.stderr.write(`SECRET_MATCH ${f.file}:${f.line} [${f.pattern}]\n`);
  }
  for (const h of historyHits) {
    process.stderr.write(`ENV_FILE_IN_HISTORY ${h}\n`);
  }
  process.stderr.write('SECRET_SCAN_FAIL\n');
  process.exitCode = 1;
}

main();
