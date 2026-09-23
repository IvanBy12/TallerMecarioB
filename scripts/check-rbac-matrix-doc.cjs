'use strict';

/**
 * Compara RBAC_MATRIX_V1 (src/authz/rbac-matrix.ts) contra el documento
 * canónico "RBAC — Matriz completa de roles y permisos v1" bajo /docs.
 *
 * /docs es local (gitignored) y no está presente en CI. Cuando no se
 * encuentra, este script imprime DOC_PARITY_SKIPPED_NO_DOCS y sale 0 — eso
 * NO cuenta como PASS del Gate documental (ver AGENTS.md / Quality Gates).
 * Localmente, con el documento presente, compara TODAS las celdas y solo
 * imprime DOC_PARITY_PASS si hay paridad total con RBAC_MATRIX_V1. Nunca
 * modifica el documento.
 *
 * Uso: node scripts/check-rbac-matrix-doc.cjs
 */

const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const ROLE_COLUMN_ORDER = ['owner', 'admin', 'service_advisor', 'technician'];
const MARK_TO_SCOPE = { '✅': 'tenant', A: 'assigned', Q: 'quality_control', '—': 'deny' };

/** Busca un directorio `docs` recorriendo hacia arriba desde la raíz del repo. */
function findDocsRoot() {
  const repoRoot = resolve(__dirname, '..');
  let dir = repoRoot;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'docs');
    if (existsDir(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function existsDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Recorre docsRoot buscando el .md cuyo nombre contenga "RBAC" y "Matriz". */
function findRbacMatrixDoc(docsRoot) {
  const stack = [docsRoot];
  const matches = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.md') && /rbac/i.test(entry.name) && /matriz/i.test(entry.name)) {
        matches.push(full);
      }
    }
  }
  return matches;
}

/** Parsea todas las tablas "| Permission code | Owner | Admin | Advisor | Technician |" del doc. */
function parseDocMatrix(markdown) {
  const lines = markdown.split(/\r?\n/);
  const rows = new Map(); // permissionCode -> { owner, admin, service_advisor, technician }

  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].trim();
    if (!/^\|\s*Permission code\s*\|\s*Owner\s*\|\s*Admin\s*\|\s*Advisor\s*\|\s*Technician\s*\|$/i.test(header)) {
      continue;
    }
    // Next line must be the separator row; data rows follow until a non-table line.
    let j = i + 2;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim().startsWith('|')) break;
      // line.split('|') on "| a | b |" -> ['', ' a ', ' b ', ''] — drop the empty ends explicitly.
      const trimmedCells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      if (trimmedCells.length !== 5) continue;
      const [codeRaw, ownerMark, adminMark, advisorMark, technicianMark] = trimmedCells;
      const code = codeRaw.replace(/`/g, '').trim();
      if (!code) continue;
      const marks = [ownerMark, adminMark, advisorMark, technicianMark];
      if (!marks.every((m) => m in MARK_TO_SCOPE)) continue; // not a data row (e.g. stray table)
      const cell = {};
      ROLE_COLUMN_ORDER.forEach((role, idx) => {
        cell[role] = MARK_TO_SCOPE[marks[idx]];
      });
      rows.set(code, cell);
    }
    i = j - 1;
  }
  return rows;
}

function compileToTempDir() {
  const outDir = mkdtempSync(join(tmpdir(), 'tallermecario-rbac-doc-check-'));
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit', 'false',
      '--rootDir', 'src', '--outDir', outDir,
    ],
    { cwd: process.cwd(), stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('RBAC_MATRIX_TSC_COMPILE_FAILED');
  return outDir;
}

function main() {
  const docsRoot = findDocsRoot();
  if (!docsRoot) {
    process.stdout.write('DOC_PARITY_SKIPPED_NO_DOCS\n');
    return;
  }

  const candidates = findRbacMatrixDoc(docsRoot);
  if (candidates.length === 0) {
    process.stdout.write('DOC_PARITY_SKIPPED_NO_DOCS\n');
    return;
  }
  if (candidates.length > 1) {
    process.stderr.write(`DOC_PARITY_AMBIGUOUS: multiple candidate documents found:\n${candidates.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  const docPath = candidates[0];
  const docMatrix = parseDocMatrix(readFileSync(docPath, 'utf8'));
  if (docMatrix.size === 0) {
    process.stderr.write(`DOC_PARITY_FAIL: no permission rows parsed from ${docPath}\n`);
    process.exitCode = 1;
    return;
  }

  const compiledRoot = compileToTempDir();
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const rbac = require(join(compiledRoot, 'authz/rbac-matrix.js'));

    const missingInDoc = [];
    const extraInDoc = [];
    const scopeMismatches = [];

    for (const code of rbac.PERMISSION_CODES) {
      const docCell = docMatrix.get(code);
      if (!docCell) {
        missingInDoc.push(code);
        continue;
      }
      for (const role of ROLE_COLUMN_ORDER) {
        const expected = rbac.RBAC_MATRIX_V1[code][role].grant;
        const actual = docCell[role];
        if (expected !== actual) {
          scopeMismatches.push(`${code}.${role} matrix=${expected} doc=${actual}`);
        }
      }
    }
    const codeSet = new Set(rbac.PERMISSION_CODES);
    for (const code of docMatrix.keys()) {
      if (!codeSet.has(code)) extraInDoc.push(code);
    }

    if (missingInDoc.length || extraInDoc.length || scopeMismatches.length) {
      process.stderr.write(`DOC_PARITY_FAIL: ${docPath}\n`);
      if (missingInDoc.length) process.stderr.write(`  missing in doc: ${missingInDoc.join(', ')}\n`);
      if (extraInDoc.length) process.stderr.write(`  extra in doc (not in RBAC_MATRIX_V1): ${extraInDoc.join(', ')}\n`);
      if (scopeMismatches.length) process.stderr.write(`  scope mismatches:\n    ${scopeMismatches.join('\n    ')}\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`DOC_PARITY_PASS: ${docPath} (${rbac.PERMISSION_CODES.length} permission codes, full cell parity)\n`);
  } finally {
    if (compiledRoot.startsWith(join(tmpdir(), 'tallermecario-rbac-doc-check-'))) {
      rmSync(compiledRoot, { recursive: true, force: true });
    }
  }
}

module.exports = { findDocsRoot, findRbacMatrixDoc, parseDocMatrix };

if (require.main === module) {
  main();
}
