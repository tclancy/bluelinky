#!/usr/bin/env -S npx tsx
/**
 * Entry point for `npm run status-json`.
 *
 * Thin on purpose. The logic, the contract and the exit codes live in
 * `src/status-json.ts`, where the repo's ESLint hook reaches (`files: ^src/`)
 * and where the tests can assert the exact stdout and stderr bytes without
 * spying on a global. This file is the only part that may touch a terminal.
 */
import { statusReport } from './src/status-json.ts';

const report = statusReport();
if (report.stdout) {
  // eslint-disable-next-line no-console
  console.log(report.stdout);
}
if (report.stderr) {
  // eslint-disable-next-line no-console
  console.error(report.stderr);
}
// `process.exitCode`, not `process.exit()`. Node's stdout is asynchronous when
// it is a pipe, which is exactly how the fuel producer invokes this
// (`capture_output=True`), and `process.exit()` can cut a buffered write off
// mid-flight. The database is already closed, so nothing holds the loop open
// and the process ends on its own.
process.exitCode = report.code;
