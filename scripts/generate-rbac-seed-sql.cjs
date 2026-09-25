'use strict';

/**
 * Generador determinista: RBAC_MATRIX_V1 (src/authz/rbac-matrix.ts) → SQL de
 * seed para `roles`, `permissions` y `role_permissions`.
 *
 * Ejecutar dos veces con el mismo schema.ts produce byte-a-byte el mismo
 * output (sin timestamps ni randomness). Los UUID de fila se generan en
 * PostgreSQL con `uuidv7()` durante el propio INSERT; el texto generado no
 * los necesita para ser determinista.
 *
 * Orden canónico: permission code en el orden del documento RBAC v1 (orden
 * de declaración en RAW_MATRIX, agrupado por sección del documento), luego
 * role code en el orden canónico ROLE_CODES = [owner, admin, service_advisor,
 * technician]. Esta es la "estrategia equivalente documentada" de ordenación
 * exigida por la tarea S1-02 (permission code, luego role code).
 *
 * Uso:
 *   node scripts/generate-rbac-seed-sql.cjs            # imprime el bloque en stdout
 *   node scripts/generate-rbac-seed-sql.cjs --check <migration.sql>
 *       # regenera y compara contra el bloque BEGIN/END GENERATED RBAC V1
 *       # existente en <migration.sql>; exit 0 si coincide, 1 si no.
 */

const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const BEGIN_MARKER = '-- BEGIN GENERATED RBAC V1';
const END_MARKER = '-- END GENERATED RBAC V1';

/** Compila src/**\/*.ts a un directorio temporal y devuelve el path compilado. */
function compileToTempDir() {
  const outDir = mkdtempSync(join(tmpdir(), 'tallermecario-rbac-gen-'));
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

/** Carga el módulo compilado de la matriz RBAC canónica. Llama a compileToTempDir() primero. */
function loadCompiledMatrix(compiledRoot) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(join(compiledRoot, 'authz/rbac-matrix.js'));
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Filas canónicas (permission_code, role_code, resource_scope) en orden determinista. */
function canonicalRows(rbac) {
  return rbac.listRolePermissionRows();
}

function buildRolesBlock(rbac) {
  const rows = rbac.ROLE_CODES.map(
    (code) => `\t(uuidv7(), ${sqlString(code)}, ${sqlString(rbac.ROLE_NAMES_ES[code])}, 'tenant', true)`,
  );
  return [
    '-- Roles baseline (system roles). Idempotente: no crea filas nuevas si ya',
    '-- existen (código estable); actualiza nombre/scope/is_system si difieren.',
    'INSERT INTO public.roles (id, code, name, scope, is_system) VALUES',
    `${rows.join(',\n')}`,
    'ON CONFLICT (code) DO UPDATE SET',
    '\tname = EXCLUDED.name,',
    '\tscope = EXCLUDED.scope,',
    '\tis_system = EXCLUDED.is_system;',
  ].join('\n');
}

function buildPermissionsBlock(rbac) {
  const rows = rbac.PERMISSION_CODES.map(
    (code) => `\t(uuidv7(), ${sqlString(code)}, ${sqlString(rbac.PERMISSION_DESCRIPTIONS[code])})`,
  );
  return [
    `-- Catálogo de permission codes (${rbac.PERMISSION_CODES.length} filas, RBAC_MATRIX_V1).`,
    'INSERT INTO public.permissions (id, code, description) VALUES',
    `${rows.join(',\n')}`,
    'ON CONFLICT (code) DO UPDATE SET',
    '\tdescription = EXCLUDED.description;',
  ].join('\n');
}

function buildCanonicalValuesTable(rows) {
  const lines = rows.map(
    (row) => `\t\t(${sqlString(row.permissionCode)}, ${sqlString(row.roleCode)}, ${sqlString(row.resourceScope)})`,
  );
  return `\tVALUES\n${lines.join(',\n')}`;
}

function buildScopeDriftGuardBlock(rows) {
  return [
    '-- Fail-fast: si una fila (role_id, permission_id) ya existe con un',
    '-- resource_scope distinto al canónico, abortar en vez de sobrescribir o',
    '-- ignorar silenciosamente (DO NOTHING nunca oculta un scope incorrecto).',
    'DO $rbac_scope_drift_guard$',
    'DECLARE',
    '\tv_mismatched integer;',
    'BEGIN',
    '\tSELECT count(*) INTO v_mismatched',
    '\tFROM (',
    buildCanonicalValuesTable(rows),
    '\t) AS canonical(permission_code, role_code, resource_scope)',
    '\tJOIN public.permissions p ON p.code = canonical.permission_code',
    '\tJOIN public.roles r ON r.code = canonical.role_code',
    '\tJOIN public.role_permissions rp ON rp.role_id = r.id AND rp.permission_id = p.id',
    '\tWHERE rp.resource_scope IS DISTINCT FROM canonical.resource_scope;',
    '',
    '\tIF v_mismatched > 0 THEN',
    "\t\tRAISE EXCEPTION 'RBAC_SEED_SCOPE_DRIFT: % existing role_permissions row(s) have a resource_scope different from RBAC_MATRIX_V1', v_mismatched;",
    '\tEND IF;',
    'END',
    '$rbac_scope_drift_guard$;',
  ].join('\n');
}

function buildRolePermissionsInsertBlock(rows) {
  return [
    `-- role_permissions (${rows.length} filas, RBAC_MATRIX_V1). Idempotente: la`,
    '-- guarda anterior ya garantizó que ninguna fila existente tiene un scope',
    '-- distinto, por lo que DO NOTHING aquí solo omite reinserciones exactas.',
    'INSERT INTO public.role_permissions (role_id, permission_id, resource_scope)',
    'SELECT r.id, p.id, canonical.resource_scope',
    'FROM (',
    buildCanonicalValuesTable(rows),
    ') AS canonical(permission_code, role_code, resource_scope)',
    'JOIN public.permissions p ON p.code = canonical.permission_code',
    'JOIN public.roles r ON r.code = canonical.role_code',
    'ON CONFLICT (role_id, permission_id) DO NOTHING;',
  ].join('\n');
}

/** Conteos por (role_code, resource_scope), en el orden canónico ROLE_CODES × RESOURCE_SCOPES. */
function countsByRoleScope(rbac, rows) {
  const counts = [];
  for (const roleCode of rbac.ROLE_CODES) {
    for (const scope of rbac.RESOURCE_SCOPES) {
      const count = rows.filter((r) => r.roleCode === roleCode && r.resourceScope === scope).length;
      if (count > 0) counts.push({ roleCode, scope, count });
    }
  }
  return counts;
}

function buildCountsGuardBlock(rbac, rows) {
  const totalPermissions = rbac.PERMISSION_CODES.length;
  const totalRolePermissions = rows.length;
  const roleScopeCounts = countsByRoleScope(rbac, rows);

  const perRoleScopeChecks = roleScopeCounts.map(({ roleCode, scope, count }) => {
    const varName = `v_${roleCode}_${scope}`;
    return {
      declare: `\t${varName} integer;`,
      select: [
        `\tSELECT count(*) INTO ${varName}`,
        '\tFROM public.role_permissions rp',
        '\tJOIN public.roles r ON r.id = rp.role_id',
        `\tWHERE r.code = ${sqlString(roleCode)} AND rp.resource_scope = ${sqlString(scope)};`,
      ].join('\n'),
      check: [
        `\tIF ${varName} <> ${count} THEN`,
        `\t\tRAISE EXCEPTION 'RBAC_SEED_COUNT_MISMATCH: role=% scope=% expected=% found=%', ${sqlString(roleCode)}, ${sqlString(scope)}, ${count}, ${varName};`,
        '\tEND IF;',
      ].join('\n'),
    };
  });

  return [
    '-- Guarda de conteos canónicos derivada de RBAC_MATRIX_V1. Aborta la',
    '-- migración si el seed no produjo exactamente los conteos esperados.',
    'DO $rbac_counts_guard$',
    'DECLARE',
    '\tv_permissions_count integer;',
    '\tv_role_permissions_count integer;',
    ...perRoleScopeChecks.map((c) => c.declare),
    'BEGIN',
    '\tSELECT count(*) INTO v_permissions_count FROM public.permissions;',
    `\tIF v_permissions_count <> ${totalPermissions} THEN`,
    `\t\tRAISE EXCEPTION 'RBAC_SEED_PERMISSIONS_COUNT_MISMATCH: expected=% found=%', ${totalPermissions}, v_permissions_count;`,
    '\tEND IF;',
    '',
    '\tSELECT count(*) INTO v_role_permissions_count FROM public.role_permissions;',
    `\tIF v_role_permissions_count <> ${totalRolePermissions} THEN`,
    `\t\tRAISE EXCEPTION 'RBAC_SEED_ROLE_PERMISSIONS_COUNT_MISMATCH: expected=% found=%', ${totalRolePermissions}, v_role_permissions_count;`,
    '\tEND IF;',
    '',
    ...perRoleScopeChecks.flatMap((c) => ['', c.select, c.check]).filter((line) => line !== ''),
    'END',
    '$rbac_counts_guard$;',
  ].join('\n');
}

/** Bloque completo (con marcadores) a insertar/comparar en la migración. */
function buildGeneratedBlock(rbac) {
  const rows = canonicalRows(rbac);
  const parts = [
    buildRolesBlock(rbac),
    buildPermissionsBlock(rbac),
    buildScopeDriftGuardBlock(rows),
    buildRolePermissionsInsertBlock(rows),
    buildCountsGuardBlock(rbac, rows),
  ];
  const withBreakpoints = parts.join('\n--> statement-breakpoint\n\n');
  return `${BEGIN_MARKER}\n\n${withBreakpoints}\n--> statement-breakpoint\n\n${END_MARKER}`;
}

/** Extrae el bloque BEGIN/END GENERATED RBAC V1 (marcadores incluidos) de un archivo SQL. */
function extractGeneratedBlock(sqlText) {
  const beginIdx = sqlText.indexOf(BEGIN_MARKER);
  const endIdx = sqlText.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  return sqlText.slice(beginIdx, endIdx + END_MARKER.length);
}

function main() {
  const args = process.argv.slice(2);
  const checkIdx = args.indexOf('--check');
  const compiledRoot = compileToTempDir();
  try {
    const rbac = loadCompiledMatrix(compiledRoot);
    const generated = buildGeneratedBlock(rbac);

    if (checkIdx === -1) {
      process.stdout.write(`${generated}\n`);
      return;
    }

    const migrationPath = args[checkIdx + 1];
    if (!migrationPath) throw new Error('RBAC_SEED_CHECK_REQUIRES_PATH');
    const existing = extractGeneratedBlock(readFileSync(migrationPath, 'utf8'));
    if (existing === null) {
      process.stderr.write(`RBAC_SEED_PARITY_FAIL: no GENERATED RBAC V1 block found in ${migrationPath}\n`);
      process.exitCode = 1;
      return;
    }
    if (existing !== generated) {
      process.stderr.write(`RBAC_SEED_PARITY_FAIL: ${migrationPath} does not match RBAC_MATRIX_V1\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`RBAC_SEED_PARITY_PASS: ${migrationPath}\n`);
  } finally {
    if (compiledRoot.startsWith(join(tmpdir(), 'tallermecario-rbac-gen-'))) {
      rmSync(compiledRoot, { recursive: true, force: true });
    }
  }
}

module.exports = {
  BEGIN_MARKER,
  END_MARKER,
  compileToTempDir,
  loadCompiledMatrix,
  canonicalRows,
  buildGeneratedBlock,
  extractGeneratedBlock,
};

if (require.main === module) {
  main();
}
