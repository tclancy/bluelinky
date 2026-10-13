/* eslint-disable */
/**
 * No shipped source file may name the process-wide TLS switch (#37).
 *
 * `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` is read by node globally and
 * nothing restores it, so once any code path sets it, every later HTTPS call
 * anything in the process makes skips certificate verification -- including the
 * US calls `monitor.ts` makes hourly and the plain `fetch()` in
 * `monitor-helpers.ts`, which carries no dispatcher of its own.
 *
 * **This block is the surviving half of `__tests__/canadian-tls-scope.spec.ts`,
 * moved here by #32 rather than deleted with it.** That file had three
 * `describe` blocks: two drove the Canadian `fetch` and `got` request paths,
 * and died with the region. This one never was Canada-specific -- it walks
 * `src/`, `scripts/` and every root source file and bans the identifier
 * outright. Its original docblock gave the reason, and it still holds:
 *
 *   "The behavioural suites above only speak for the two request paths they
 *   drive. A third caller setting the same variable would reopen #37 with
 *   nothing red."
 *
 * Issue #32's own analysis singled this item out as the one that "should be
 * fixed under every option, including deletion", on the grounds that
 * "'unreachable' is a weaker guarantee than 'absent'". Deleting the region
 * delivers the absence; this file is what keeps it.
 */
import fs from 'fs';
import path from 'path';

const TLS_VAR = 'NODE_TLS_REJECT_UNAUTHORIZED';
const REPO_ROOT = path.join(__dirname, '..');

describe('no shipped source file names the process-wide TLS switch (#37)', () => {
  const SOURCE_DIRS = ['src', 'scripts'];
  const SOURCE_EXTENSIONS = ['.ts', '.js', '.cjs', '.mjs'];

  /**
   * Re-measured 2026-10-13 by running this file's own walk after #32's
   * deletions: 36 under `src` + 3 under `scripts` + 10 at the root (6 entry
   * scripts and 4 configs -- `.eslintrc.cjs` counts, because `readdirSync`
   * returns dotfiles) = 49.
   *
   * It was 52 before #32 deleted four source files, one of which was under
   * `__tests__` and so never counted here. The floor moved DOWN, which is the
   * one direction a floor cannot absorb on its own: left at 52 this block
   * would have gone red on a correct tree, and that is the likeliest reason to
   * delete the whole file rather than move it. The tree may grow, never shrink
   * below this.
   */
  const MIN_FILES_SCANNED = 49;

  const isSource = (name: string): boolean =>
    SOURCE_EXTENSIONS.some(extension => name.endsWith(extension));

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && isSource(entry.name) ? [full] : [];
    });

  /**
   * Derived, never listed. A hardcoded roster of root entry scripts is blind to
   * the next one added, and this repo grows them as a habit -- `monitor.ts`,
   * `monitor-fuel.ts`, `status-json.ts`, `get-fuel-level.ts` and
   * `alert-backends.ts` each arrived separately. The floor below is `>=`, so it
   * can never catch an unscanned newcomer either.
   *
   * Non-`.ts` root files are in scope deliberately: `jest.config.cjs` already
   * sets `process.env.LOG_LEVEL` and executes inside the test process, which
   * makes it the one place the variable could be set with every test still
   * green.
   */
  const rootSourceFiles = (): string[] =>
    fs
      .readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter(entry => entry.isFile() && isSource(entry.name))
      .map(entry => entry.name);

  const namesTheSwitch = (source: string): boolean => source.includes(TLS_VAR);

  const scanned: { relative: string; source: string }[] = [
    ...SOURCE_DIRS.flatMap(dir => walk(path.join(REPO_ROOT, dir))),
    ...rootSourceFiles().map(file => path.join(REPO_ROOT, file)),
  ].map(absolute => ({
    relative: path.relative(REPO_ROOT, absolute),
    source: fs.readFileSync(absolute, 'utf8'),
  }));

  it('control: the detector fires on a source file that does name it', () => {
    // Without this, "no file names it" is indistinguishable from a matcher
    // that can never match anything.
    expect(namesTheSwitch(`process.env.${TLS_VAR} = '0';`)).toBe(true);
    expect(namesTheSwitch(`process.env['${TLS_VAR}'] = '0';`)).toBe(true);
    expect(namesTheSwitch("process.env.SOMETHING_ELSE = '0';")).toBe(false);
  });

  it('control: the scan reaches the request paths that still ship', () => {
    // A floor alone passes a glob that quietly stopped matching the files that
    // make outbound HTTPS calls, so some are named outright. The two originally
    // named here were the Canadian controller and vehicle -- the files #37's
    // defect lived in, and the files #32 deleted. These are their surviving
    // equivalents: the region production actually selects, plus a second one,
    // and both are at a depth the recursive walk has to reach.
    const relatives = scanned.map(file => file.relative);
    expect(relatives).toContain(path.join('src', 'controllers', 'american.controller.ts'));
    expect(relatives).toContain(path.join('src', 'vehicles', 'european.vehicle.ts'));

    // The root list is derived rather than enumerated, so every entry script
    // and every root config file that executes is in scope by construction.
    expect(relatives).toContain('monitor.ts');
    expect(relatives).toContain('jest.config.cjs');

    expect(scanned.length).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
    for (const file of scanned) {
      expect(file.source.length).toBeGreaterThan(0);
    }
  });

  it('names it nowhere', () => {
    const offenders = scanned
      .filter(file => namesTheSwitch(file.source))
      .map(file => file.relative);

    // A comment naming the variable counts, and so does a `finally`-scoped
    // save/restore. Read the docblock above before relaxing this.
    expect(offenders).toEqual([]);
  });
});
