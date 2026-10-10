'use strict';
// Deployment bootstrap only, using the migrator/bootstrap credential.
// Production purger connects with this separate NOINHERIT login, never DATABASE_URL.
const postgres=require('postgres');
const {randomBytes,pbkdf2Sync,createHmac,createHash}=require('node:crypto');
// Printable ASCII secret avoids SASLprep ambiguities; only the verifier reaches SQL.
function scramVerifier(password){
 if(!/^[\x21-\x7e]+$/.test(password))throw new Error('MEDIA_PURGER_PASSWORD_FORMAT_INVALID');
 const salt=randomBytes(16),iterations=4096;
 const salted=pbkdf2Sync(password,salt,iterations,32,'sha256');
 const client=createHmac('sha256',salted).update('Client Key').digest();
 const stored=createHash('sha256').update(client).digest('base64');
 const server=createHmac('sha256',salted).update('Server Key').digest('base64');
 return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored}:${server}`;
}
async function main(){
 const url=process.env.DATABASE_URL,password=process.env.MEDIA_PURGER_DB_PASSWORD;
 if(!url||!password)throw new Error('MEDIA_PURGER_BOOTSTRAP_CONFIGURATION_REQUIRED');
 const sql=postgres(url,{max:1,prepare:false,onnotice:()=>{}});
 try{
  await sql.begin(async sql=>{
  const [boundary]=await sql`SELECT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.roleid,m.member)
    WHERE r.rolname='tallermecario_media_lifecycle')
    OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='tallermecario_media_lifecycle'
      AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole)) invalid`;
  if(boundary.invalid)throw new Error('MEDIA_PURGER_BOOTSTRAP_ROLE_INVALID');
  const [exists]=await sql`SELECT 1 FROM pg_roles WHERE rolname='tallermecario_media_purge_runtime'`;
  const command=exists?'ALTER ROLE':'CREATE ROLE';
  await sql.unsafe(`${command} tallermecario_media_purge_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${scramVerifier(password)}'`);
  await sql`GRANT tallermecario_media_purger TO tallermecario_media_purge_runtime WITH INHERIT FALSE, SET TRUE`;
  const [bad]=await sql`SELECT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles c ON c.oid=m.member
   WHERE c.rolname='tallermecario_media_purge_runtime' AND p.rolname<>'tallermecario_media_purger') invalid`;
  if(bad.invalid)throw new Error('MEDIA_PURGER_BOOTSTRAP_ROLE_INVALID');
  });
  process.stdout.write('MEDIA_PURGER_LOGIN_PROVISION_PASS\n');
 }finally{await sql.end();}
}
main().catch(()=>{process.stderr.write('MEDIA_PURGER_LOGIN_PROVISION_FAILED\n');process.exitCode=1;});
