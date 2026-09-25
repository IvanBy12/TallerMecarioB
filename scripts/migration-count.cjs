'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function expectedMigrationCount() {
  const journal = JSON.parse(readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8'));
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error('MIGRATION_JOURNAL_INVALID');
  }
  return journal.entries.length;
}

module.exports = { expectedMigrationCount };
