import fs from 'fs';
import path from 'path';

/**
 * Pins the CI `test` job to running the suite on the interpreter the runtime
 * image pins, and pins the structural keys that can retire a leg while the
 * matrix list still reads intact.
 *
 * **This file's original thesis is gone, deliberately.** It was written for the
 * Canadian transport fork: `shouldUseFetchTransport` picked between `got`
 * (below Node 21) and undici's `fetch` (at or above) off the running major, so
 * two legs either side of 21 bought the only check that the DEFAULT selection
 * was right above the threshold. Issue #32 deleted the Canadian region, which
 * deleted `src/tools/runtime.tools.ts`, the threshold constant and both arms.
 * Three of this file's assertions went with them.
 *
 * What is left, stated narrowly so this file cannot overclaim again:
 *
 *   - It DOES buy the coupling below -- CI runs the suite on the major
 *     `Dockerfile`'s `NODE_IMAGE` pins, so a base-image bump that nothing tests
 *     is red rather than green. That is derived from the Dockerfile, not
 *     restated here, so moving the pin moves what this file demands of CI.
 *   - It does NOT buy arm coverage any more, because there are no arms. After
 *     #32 **nothing in this suite is version-sensitive**: the legs run
 *     byte-identical assertions and differ only in interpreter. That is worth
 *     something (interpreter-level drift is the failure this repo has actually
 *     had -- #26 was a TLS regression within one arm) but it is strictly less
 *     than it was, and it is the open question on issue #31. This docblock is
 *     the honest record of that, not an argument for the current leg count.
 *
 * Deliberate boundary: this file grades the `test` job, not the workflow's
 * trigger. Rewriting `on:` to `workflow_dispatch` only would leave every
 * assertion below green -- but it also stops `lint` and `build`, so it is
 * self-announcing in a way the per-leg neutralisations below are not.
 */

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yaml');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');

/**
 * The major in the runtime image's pinned base, read off `ARG NODE_IMAGE=`.
 *
 * Read from the Dockerfile rather than restated, so this gate follows the pin
 * instead of having to be edited in lockstep with it -- which is the failure
 * mode a hardcoded `20` here would have. Throws rather than returning a
 * sentinel, because a silent `NaN` satisfies nothing and reports nothing.
 */
function runtimeImageMajor(): number {
  const source = fs.readFileSync(DOCKERFILE, 'utf8').replace(/\r\n/g, '\n');
  const match = source.match(/^ARG NODE_IMAGE=node:(\d+)-slim$/m);
  if (!match) {
    throw new Error(`no \`ARG NODE_IMAGE=node:NN-slim\` found in ${DOCKERFILE}`);
  }
  return Number(match[1]);
}

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

  it('covers the major the runtime image pins', () => {
    // The coupling that survived #32, and the only assertion here that can go
    // red from a change made OUTSIDE this file. plexpi runs whatever
    // `ARG NODE_IMAGE` resolves to, so a base-image bump with no matching leg
    // means the interpreter production executes is untested -- green CI over an
    // untried runtime. Both sides are derived (Dockerfile, workflow), so this
    // tracks the pin rather than needing an edit in lockstep with it.
    //
    // The property is containment, not a literal: `node:24-slim` with a
    // `[20, 24, 25]` matrix passes; `node:22-slim` with the same matrix fails.
    expect(matrixMajors()).toContain(runtimeImageMajor());
  });

  it('runs more than one interpreter', () => {
    // Weaker than the threshold assertion this replaces, and the weakening is
    // the point rather than an oversight. Before #32 the legs graded a
    // version-sensitive production default; nothing in the suite is
    // version-sensitive now, so what a second leg buys is interpreter-level
    // drift (#26's TLS regression was within one arm, not between arms) and
    // nothing stronger.
    //
    // Kept as a floor rather than deleted because a one-leg matrix is just a
    // pinned version wearing matrix syntax, and collapsing to one is a decision
    // -- issue #31 -- not a tidy-up. This makes it a visible edit here.
    expect(new Set(matrixMajors()).size).toBeGreaterThanOrEqual(2);
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
