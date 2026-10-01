'use strict';

const { diagnoseNetwork, evaluateNetworkDiagnostic } = require('../tests/media/r2-network.cjs');

async function main() {
  const result = evaluateNetworkDiagnostic(await diagnoseNetwork(process.env.R2_ENDPOINT));
  if (!result.ok) throw new Error('R2_NETWORK_DIAGNOSTIC_FAILED');
  process.stdout.write(`R2_NETWORK_DIAGNOSTIC_PASS samples=${result.samples} usable_samples=${result.usableSamples} ipv4_usable=${result.ipv4Usable} ipv6_usable=${result.ipv6Usable}\n`);
}

main().catch(() => {
  process.stderr.write('R2_NETWORK_DIAGNOSTIC_FAILED\n');
  process.exitCode = 1;
});
