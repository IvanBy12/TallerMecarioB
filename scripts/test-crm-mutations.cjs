'use strict';

const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const mutations = {
  M1: ['REVOKE UPDATE ON TABLE public.customers, public.vehicles, public.vehicle_owners FROM tallermecario_api;',
    'GRANT UPDATE ON TABLE public.customers, public.vehicles, public.vehicle_owners TO tallermecario_api;'],
  M2: ['REVOKE ALL ON TABLE public.customers, public.vehicles, public.vehicle_owners FROM tallermecario_worker;',
    'GRANT SELECT ON TABLE public.customers, public.vehicles, public.vehicle_owners TO tallermecario_worker;'],
  M3: ['SECURITY INVOKER\nSET search_path', 'SECURITY DEFINER\nSET search_path'],
  M4: ['IF OLD.valid_to IS NOT NULL', 'IF FALSE'],
  M5: ['OR NEW.valid_from IS DISTINCT FROM OLD.valid_from', 'OR FALSE'],
  M6: ['ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_plate_normalized_check\n\tCHECK (plate = pg_catalog.btrim(plate) AND plate = pg_catalog.upper(plate COLLATE "C"));', 'SELECT 1;'],
  M7: ['GRANT UPDATE (valid_to) ON TABLE public.vehicle_owners', 'GRANT UPDATE (valid_to, is_primary) ON TABLE public.vehicle_owners'],
  M8: ['ALTER TABLE public.vehicles NO FORCE ROW LEVEL SECURITY;', 'SELECT 1;'],
  M9: ['RESET ROLE;', 'ALTER POLICY tenant_update ON public.customers WITH CHECK (true);\n--> statement-breakpoint\nRESET ROLE;'],
  M10: ['DO $crm_hardening_checks$', 'GRANT MAINTAIN ON TABLE public.customers TO tallermecario_api;\n--> statement-breakpoint\nDO $crm_hardening_checks$'],
  M11: ['ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_plate_format_check\n\tCHECK (plate COLLATE "C" ~ \'^[A-Z0-9]{1,16}$\');',
    'ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_plate_format_check\n\tCHECK (TRUE);'],
};

let failed = false;
const selected = Object.entries(mutations).filter(([name]) => !process.env.CRM_MUTATION || process.env.CRM_MUTATION === name);
if (selected.length === 0) throw new Error('UNKNOWN_CRM_MUTATION');
for (const [name,[anchor,replacement]] of selected) {
  const folder = mkdtempSync(join(tmpdir(),`tm-crm-mut-${name}-`));
  try {
    cpSync('drizzle',folder,{recursive:true});
    const file = join(folder,'0018_s2_03_crm_hardening.sql');
    const original = readFileSync(file,'utf8').replace(/\r\n/gu,'\n');
    if (original.split(anchor).length !== 2) throw new Error(`MUTATION_ANCHOR_INVALID ${name}`);
    writeFileSync(file,original.replace(anchor,() => replacement));
    const script = ['M8','M9'].includes(name) ? 'scripts/test-crm-migration-upgrade.cjs' : 'scripts/test-crm-db.cjs';
    const r = spawnSync(process.execPath,[script],{
      cwd:process.cwd(),
      env:{...process.env,MIGRATIONS_FOLDER:folder,CRM_HEAD_FOLDER:folder,NO_COLOR:'1'},
      encoding:'utf8',timeout:600_000,
    });
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    const migrationRejected = output.includes('Migration failed.') &&
      ['M1','M2','M3','M6','M7','M10'].includes(name);
    const testRejected = /CRM_TEST_COUNTS PASS=\d+ FAIL=[1-9]/u.test(output) && ['M4','M5','M11'].includes(name);
    const preflightRejected = name==='M8' && output.includes('preflight must see legacy rows before ADD CONSTRAINT');
    const withCheckRejected = name==='M9' && output.includes('CRM_WITH_CHECK_PROBE_ACCEPTED_MOVE');
    const teardownClean = output.includes('CRM_TEARDOWN dbs=0 logins=0') || output.includes('CRM_UPGRADE_TEARDOWN dbs=0 logins=0');
    const killed = r.status !== 0 && teardownClean && (migrationRejected || testRejected || preflightRejected || withCheckRejected);
    process.stdout.write(`${name} ${killed?'KILLED':'SURVIVED'}${teardownClean ? ' teardown=clean':''}\n`);
    if (!killed) { process.stderr.write(output.slice(-1200)); failed = true; }
  } catch (e) {
    process.stderr.write(`${name} INVALID ${e.message}\n`);
    failed = true;
  } finally {
    rmSync(folder,{recursive:true,force:true});
  }
}
if (failed) process.exitCode=1;
else {
  if (!process.env.CRM_MUTATION) {
    process.stdout.write('CRM_MUTATIONS_M1_M11_PASS 11/11 killed\n');
  }
  process.stdout.write(`CRM_MUTATIONS_PASS ${selected.length}/${selected.length} killed\n`);
}
