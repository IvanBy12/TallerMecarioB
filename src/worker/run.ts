import postgres from 'postgres';
import {
  claimBatch,
  processClaimedJob,
  requeueStalled,
  type OutboxHandler,
} from './outbox-worker.js';

/**
 * ADR-007: API and worker ship from the same image, started with a
 * different command. This is that worker command. No WhatsApp/Wompi/email
 * dispatch handlers are wired in yet (out of scope here) -- an empty
 * registry is a safe, correct starting state: `processClaimedJob` already
 * treats an unregistered `event_type` as a permanent failure (dead_letter),
 * never a crash, so the process stays up either way.
 */
const HANDLERS: Record<string, OutboxHandler> = {};

function databaseUrlFromEnv(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.PGHOST;
  const database = process.env.PGDATABASE;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  if (!host || !database || !user || !password) throw new Error('DATABASE_CONFIGURATION_REQUIRED');
  const port = process.env.PGPORT ?? '5432';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

async function main(): Promise<void> {
  const runtimeRole = process.env.DB_RUNTIME_ROLE ?? 'tallermecario_worker';
  const database = postgres(databaseUrlFromEnv(), {
    max: Number(process.env.DB_POOL_MAX ?? 5),
    connection: { role: runtimeRole },
  });

  const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
  const batchSize = Number(process.env.WORKER_BATCH_SIZE ?? 10);
  const stallSeconds = Number(process.env.WORKER_STALL_SECONDS ?? 300);

  let running = true;
  const shutdown = async (signal: string) => {
    if (!running) return;
    running = false;
    process.stdout.write(`worker: received ${signal}, finishing current cycle\n`);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.stdout.write('worker started\n');

  while (running) {
    try {
      await requeueStalled(database, stallSeconds, batchSize);
      const jobs = await claimBatch(database, batchSize);
      for (const job of jobs) {
        if (!running) break;
        await processClaimedJob({ database, handlers: HANDLERS }, job);
      }
    } catch (error) {
      process.stderr.write(`worker cycle error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (running) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  await database.end({ timeout: 5 });
  process.stdout.write('worker stopped\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
