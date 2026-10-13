import fs from 'fs';
import path from 'path';

import { CanadianController } from '../src/controllers/canadian.controller';
import {
  FETCH_TRANSPORT_MIN_NODE_MAJOR,
  shouldUseFetchTransport,
} from '../src/tools/runtime.tools';

/**
 * Pins the CI `test` job to running an interpreter each side of the Canadian
 * transport threshold, and pins the one assertion that makes that worth doing.
 *
 * `shouldUseFetchTransport` picks between `got` (below Node 21) and undici's
 * `fetch` (at or above) off the running major. Two things follow, and keeping
 * them apart is what stops this file overclaiming:
 *
 *   - It does NOT buy arm coverage. #30's injectable `useFetchTransport` means
 *     both arms already execute on any single interpreter, because the arm
 *     suites set the flag explicitly.
 *   - It DOES buy the only check that the *default* selection is correct above
 *     the threshold. Before the matrix, CI ran node 20 alone, so a default
 *     hard-wired to `false` -- which switches off the arm the deployment box
 *     actually runs -- was green.
 *
 * Measured 2026-10-12, hard-wiring the field past the function:
 *
 *   `useFetchTransport = true`   -> node 20 RED,   node 24 green
 *   `useFetchTransport = false`  -> node 20 green, node 24 RED
 *
 * The threshold is imported from production rather than restated here, so
 * moving `FETCH_TRANSPORT_MIN_NODE_MAJOR` moves what this file demands of CI.
 *
 * Deliberate boundary: this file grades the `test` job, not the workflow's
 * trigger. Rewriting `on:` to `workflow_dispatch` only would leave every
 * assertion below green -- but it also stops `lint` and `build`, so it is
 * self-announcing in a way the per-leg neutralisations below are not.
 */

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yaml');

/** The workflow source, line endings normalised so a CRLF checkout still parses. */
function workflowSource(): string {
  return fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
}

/** The `test:` job block, from its key to the next same-indent job key. */
function testJobBlock(): string {
  const match = workflowSource().match(/^ {2}test:\n(?: {4}.*\n| *\n)*/m);
  if (!match) {
    throw new Error(`no two-space-indented \`test:\` job found in ${WORKFLOW}`);
  }
  return match[0];
}

/**
 * The block introduced by `key:` at `indent`, up to the next key at or below it.
 *
 * Needed because the keys that neutralise this gate live at three different
 * depths -- `continue-on-error` on the job, `exclude` under `matrix`, `if` on a
 * single step -- and a flat scan of the job block at one fixed indent cannot
 * tell them apart from `with:` inside `steps`.
 */
function subBlock(block: string, indent: number, key: string): string {
  const pattern = new RegExp(`^ {${indent}}${key}:\\n(?:(?: {${indent + 1},}.*)?\\n)*`, 'm');
  const match = block.match(pattern);
  if (!match) {
    throw new Error(`no \`${key}:\` at indent ${indent} in block`);
  }
  return match[0];
}

/** The mapping keys declared at exactly `indent`, comments and deeper keys excluded. */
function keysAt(block: string, indent: number): Set<string> {
  const keys = block
    .split('\n')
    .map(line => line.match(new RegExp(`^ {${indent}}([A-Za-z][A-Za-z0-9-]*):`)))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(match => match[1]);
  return new Set(keys);
}

const strategyBlock = () => subBlock(testJobBlock(), 4, 'strategy');
const matrixBlock = () => subBlock(strategyBlock(), 6, 'matrix');
const stepsBlock = () => subBlock(testJobBlock(), 4, 'steps');

/**
 * The majors in the `test` job's matrix.
 *
 * Read out of the `matrix:` sub-block rather than the job block, so it cannot
 * pick up a `node-version:` that happens to sit elsewhere in the job -- YAML
 * does not fix the order of `strategy` and `steps`.
 */
function matrixMajors(): number[] {
  const match = matrixBlock().match(/^ +node-version: \[([^\]]*)\]$/m);
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
    // It is also what catches quoted (`['20', '24']`), full-version
    // (`[20.19.5]`) and non-numeric (`[20, 'latest']`) lists, all of which
    // parse to fewer majors than they appear to declare.
    expect(fs.existsSync(WORKFLOW)).toBe(true);
    expect(workflowSource().trim().length).toBeGreaterThan(0);
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

  it('the leg this test is running on grades the default, not merely the function', () => {
    // The assertion that makes the matrix falsifiable at all. Without a
    // version-sensitive expectation SOMEWHERE in the suite, the legs are a
    // duplicate run of byte-identical assertions and every structural check
    // above still passes. `canadian-transport.spec.ts` carries this too; the
    // duplication is deliberate, because it must not be able to disappear
    // from under the file whose docblock explains why the legs exist.
    //
    // Derived from `process.version` -- a different API than the production
    // default reads -- so a hardcoded default cannot satisfy it.
    const runningMajor = Number(process.version.replace(/^v/, '').split('.')[0]);
    const controller = new CanadianController({
      username: 'testuser@gmail.com',
      password: 'test',
      region: 'CA',
      autoLogin: false,
      brand: 'hyundai',
      pin: '1234',
      vin: '4444444444444',
      vehicleId: undefined,
    } as never);

    expect(controller.useFetchTransport).toBe(runningMajor >= FETCH_TRANSPORT_MIN_NODE_MAJOR);
  });

  it('the job consumes the matrix rather than pinning a literal version', () => {
    // A matrix that exists and is never read would double the runtime and
    // grade one arm twice. `setup-node` has to interpolate it.
    const block = testJobBlock();
    expect(block).toMatch(/node-version: \$\{\{ matrix\.node-version \}\}/);
    expect(block).not.toMatch(/^ +node-version: \d+$/m);
  });

  it('does not fail fast, so a red leg cannot cancel the other', () => {
    // Without this, the first leg to go red cancels its siblings and the run
    // reports one failure of unknown scope -- precisely the per-arm
    // information the matrix was added to produce.
    expect(strategyBlock()).toMatch(/^ +fail-fast: false$/m);
  });

  // The four below are ALLOW-lists over the permitted key SET at each depth,
  // not bans on the specific keys known to neutralise this gate. A ban passes
  // every synonym, and a mutation round walked past the first draft of this
  // file three times on keys it had not thought of:
  //
  //   continue-on-error: true  on the job   -> all legs run, none can fail it
  //   exclude: [{node-version: 20}]         -> only the upper leg runs, while
  //                                            the list still reads intact
  //   if: matrix.node-version == 20  on a step -> ditto, one level deeper
  //
  // All three retire a leg -- the exact regression this file exists to catch --
  // without touching any text the assertions above read.
  //
  // Benign keys are banned too, by design: `name`, `env` and `timeout-minutes`
  // are not neutralisation vectors, and a timeout turns a leg RED rather than
  // quiet. Closure is what makes an allow-list work, so adding any key here is
  // meant to be a deliberate edit to this test, and it fails loudly.

  it('the test job declares no keys beyond runs-on/strategy/steps (adding one is a deliberate edit here)', () => {
    expect(keysAt(testJobBlock(), 4)).toEqual(new Set(['runs-on', 'strategy', 'steps']));
  });

  it('the strategy declares no keys beyond fail-fast/matrix (adding one is a deliberate edit here)', () => {
    expect(keysAt(strategyBlock(), 6)).toEqual(new Set(['fail-fast', 'matrix']));
  });

  it('the matrix declares node-version and nothing that could filter it', () => {
    // `exclude` and `include` both reshape the realised leg set without
    // changing the list, so an allow-list of one key is the only assertion
    // that sees them.
    expect(keysAt(matrixBlock(), 8)).toEqual(new Set(['node-version']));
  });

  it('every leg still installs and runs the suite, ungated (adding a step key is a deliberate edit here)', () => {
    // The depth the first two drafts left open. A step-level `if` or
    // `continue-on-error` retires a leg while the job-level and matrix-level
    // allow-lists above read perfectly intact.
    //
    // `- ` is normalised to two spaces so each item's first key lands at the
    // same indent as `with:`, which is where a step-level `if` would also sit.
    const steps = stepsBlock();
    expect(steps).toMatch(/^ +- run: npm ci$/m);
    expect(steps).toMatch(/^ +- run: npm test$/m);
    expect(keysAt(steps.replace(/^ {6}- /gm, '        '), 8)).toEqual(
      new Set(['uses', 'with', 'run'])
    );
  });
});
