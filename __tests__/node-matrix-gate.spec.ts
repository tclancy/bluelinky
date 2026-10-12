import fs from 'fs';
import path from 'path';

import {
  FETCH_TRANSPORT_MIN_NODE_MAJOR,
  shouldUseFetchTransport,
} from '../src/tools/runtime.tools';

/**
 * Pins the CI `test` job to grading BOTH Canadian transports, not one.
 *
 * `shouldUseFetchTransport` is a pure function of the interpreter version, so
 * the two arms it selects between -- `got` below Node 21, undici's `fetch` at
 * or above it -- are only ever *both* executed if CI runs an interpreter on
 * each side of that threshold. Before #31 the job pinned `node-version: 20`,
 * so the `fetch` arm -- the one that actually executes on plexpi -- had never
 * been run by a CI job in this repo's history.
 *
 * What makes this assertable rather than decorative: the threshold is imported
 * from production rather than written here. Moving
 * `FETCH_TRANSPORT_MIN_NODE_MAJOR` moves what this file demands of CI, so the
 * matrix cannot silently stop spanning the boundary it exists to span.
 *
 * Measured against this branch on 2026-10-12, hard-wiring the field past the
 * function:
 *
 *   `useFetchTransport = true`   -> node 20 RED,   node 24 green
 *   `useFetchTransport = false`  -> node 20 green, node 24 RED
 *
 * Neither leg alone catches both. That asymmetry is the whole case for a
 * matrix, and the second row is the costly one: node 20 on its own is blind to
 * the mutant that switches off the shipping arm.
 */

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yaml');

/** The `test:` job block, from its key to the next same-indent job key. */
function testJobBlock(): string {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const match = workflow.match(/^ {2}test:\n(?: {4}.*\n| *\n)*/m);
  if (!match) {
    throw new Error(`no two-space-indented \`test:\` job found in ${WORKFLOW}`);
  }
  return match[0];
}

/** The majors in the `test` job's `node-version` matrix. */
function matrixMajors(): number[] {
  const match = testJobBlock().match(/^ +node-version: \[([^\]]*)\]$/m);
  if (!match) {
    throw new Error('the `test` job has no inline `node-version: [...]` matrix list');
  }
  return match[1]
    .split(',')
    .map(entry => Number(entry.trim()))
    .filter(major => !Number.isNaN(major));
}

describe('the CI node-version matrix', () => {
  it('reachability control: the workflow exists, is non-empty, and yields a parseable matrix', () => {
    // Every assertion below reads one of these. Without this, a renamed
    // workflow or a reshaped `test:` block would make the helpers throw or
    // return `[]`, and an empty list satisfies `every()` vacuously -- the
    // shape in which an absence assertion passes while measuring nothing.
    expect(fs.existsSync(WORKFLOW)).toBe(true);
    expect(fs.readFileSync(WORKFLOW, 'utf8').trim().length).toBeGreaterThan(0);
    expect(testJobBlock()).toMatch(/runs-on:/);
    expect(matrixMajors().length).toBeGreaterThanOrEqual(2);
  });

  it('spans the transport threshold: at least one major each side of it', () => {
    const majors = matrixMajors();

    // The property, not the literal versions. `[20, 24]` satisfies it today,
    // but so would `[18, 22]`; `[22, 24]` would not, and that is the point --
    // bumping the lower leg past the threshold silently retires the `got` arm
    // from CI, which is the exact regression this file exists to catch.
    expect(
      majors.filter(major => major < FETCH_TRANSPORT_MIN_NODE_MAJOR).length
    ).toBeGreaterThanOrEqual(1);
    expect(
      majors.filter(major => major >= FETCH_TRANSPORT_MIN_NODE_MAJOR).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('the matrix majors really do select different transports', () => {
    // Closes the gap between "two numbers either side of a constant" and "two
    // interpreters that make production branch differently". This reads the
    // decision through the production function rather than re-deriving the
    // comparison, so a change to how the version string is parsed -- not just
    // to the constant -- is covered too.
    const selections = new Set(
      matrixMajors().map(major => shouldUseFetchTransport(`${major}.0.0`))
    );
    expect(selections).toEqual(new Set([false, true]));
  });

  it('the job consumes the matrix rather than pinning a literal version', () => {
    // A matrix that exists and is never read would double the runtime and
    // grade one arm twice. `setup-node` has to interpolate it.
    const block = testJobBlock();
    expect(block).toMatch(/node-version: \$\{\{ matrix\.node-version \}\}/);
    expect(block).not.toMatch(/^ +node-version: \d+$/m);
  });

  it('does not fail fast, so a red leg cannot cancel the other', () => {
    // Without this, the first leg to go red cancels its sibling and the run
    // reports one failure of unknown scope -- precisely the per-arm
    // information the matrix was added to produce.
    expect(testJobBlock()).toMatch(/^ +fail-fast: false$/m);
  });
});
