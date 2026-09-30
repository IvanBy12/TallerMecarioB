'use strict';

const { diagnoseNetwork } = require('../tests/media/r2-network.cjs');

diagnoseNetwork(process.env.R2_ENDPOINT).catch(() => {
  process.stderr.write('R2_NETWORK_DIAGNOSTIC_FAILED\n');
  process.exitCode = 1;
});
