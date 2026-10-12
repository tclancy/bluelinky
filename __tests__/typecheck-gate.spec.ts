import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Pins the typecheck gate to something that actually runs.
 *
 * `src/vehicle-db.ts` documents a compile-time guarantee -- a required
 * `CheckRow` field forces every writer to supply it -- and before
 * `tsconfig.typecheck.json` existed, **nothing in this repo could enforce it**:
 *
 *   tsconfig.json       "include": ["src"]            -> never sees monitor.ts
 *   npm run lint        files/scope ^src/             -> never sees monitor.ts
 *   npm run build       entry src/index.ts            -> never imports it
 *   npm test            ts-jest isolatedModules: true -> transpile-only
 *
 * Measured at the time: deleting `batteryCharge12v:` from `monitor.ts` left all
 * four of those green. With the config wired in, the same deletion is
 * `monitor.ts(228,22): error TS2345`.
 *
 * So these assert the three pieces that have to hold together -- the config
 * covers the file, an npm script invokes the config, and CI invokes the script.
 * Any one of them removed turns the guarantee back into prose.
 */

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'tsconfig.typecheck.json');
const PACKAGE = path.join(ROOT, 'package.json');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yaml');

/**
 * Every root-level path the gate covers, `src` excluded.
 *
 * This list is asserted as a SET against the config's own `include`, not as a
 * floor, so it has to be exhaustive in both directions: dropping a file from
 * the config fails, and adding one here without adding it there fails too.
 * A floor would have let `alert-backends.ts` be silently removed -- it was in
 * the config and not in this list from the day it was added until #19.
 *
 * Entries are config `include` entries, which is why `scripts` is a bare
 * directory name and not three filenames: set equality is against `include`,
 * and `include` says `scripts`. What the directory EXPANDS to is a separate
 * question, answered by `expectedFilesFor()` below -- the two must not be
 * conflated, because listing the three files here instead would fail set
 * equality while the config is correct.
 */
const COVERED_ENTRY_POINTS = [
  'monitor.ts',
  'status-json.ts',
  'alert-backends.ts',
  'monitor-fuel.ts',
  'scripts',
];

/** Extensions tsc resolves for a directory entry when `allowJs` is off. */
const TS_EXTENSIONS = ['.ts', '.tsx'];

/** Every `.ts`/`.tsx` file under `dir`, recursively, absolute. */
function typeScriptFilesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(item => {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) return typeScriptFilesUnder(full);
      return TS_EXTENSIONS.some(ext => item.name.endsWith(ext)) ? [full] : [];
    })
    .sort();
}

/**
 * The concrete files tsc has to resolve for one `include` entry.
 *
 * `scripts` is the first directory entry in the config, and a directory is
 * covered differently from a file: tsc expands the entry to `scripts/**\/*` and
 * puts the files under it in `fileNames` -- the directory path itself never
 * appears there. So asserting `fileNames` contains `<root>/scripts` cannot
 * pass, and relaxing the assertion until it does is how a directory entry ends
 * up unguarded. This expands it instead.
 *
 * The expansion is read from DISK, not hard-coded. A list of the three scripts
 * that exist today would be a floor: a fourth script, or an `exclude` naming
 * only the fourth, would be invisible to it. Reading the directory means the
 * assertion's breadth tracks the directory's contents by construction.
 */
function expectedFilesFor(entry: string): string[] {
  const target = path.join(ROOT, entry);
  if (!fs.existsSync(target)) return [target]; // let the caller's assertion name it
  return fs.statSync(target).isDirectory() ? typeScriptFilesUnder(target) : [target];
}

describe('the typecheck gate', () => {
  it('reachability control: the three config files AND every covered entry point exist', () => {
    // Every assertion below reads one of these. If a rename or a move left one
    // missing, they must fail here rather than pass against an empty string.
    //
    // The entry points are in this loop because a non-glob `include` entry that
    // matches nothing is **silently ignored** by tsc -- no `TS6053`, no "no
    // inputs found". Measured: renaming `status-json.ts` away leaves
    // `tsc -p tsconfig.typecheck.json` at rc=0 and the whole suite green. The
    // resolved-set test below is what actually catches that; this loop is here
    // so the failure names the missing file instead of a set difference.
    //
    // Expanded, so a directory entry reads its files rather than itself:
    // `readFileSync` on a directory throws EISDIR, and an entry whose
    // expansion is empty is a directory tsc would resolve nothing for, which
    // is the same silent non-coverage as a renamed file.
    const entryPoints = COVERED_ENTRY_POINTS.flatMap(entry => {
      const files = expectedFilesFor(entry);
      expect(files.length).toBeGreaterThan(0);
      return files;
    });
    for (const file of [CONFIG, PACKAGE, WORKFLOW, ...entryPoints]) {
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf8').trim().length).toBeGreaterThan(0);
    }
  });

  it('covers the root entry points that tsconfig.json cannot see', () => {
    // JSON.parse would throw on the comments the config carries deliberately,
    // so read the `include` list as text -- but strip the comment lines FIRST.
    // Those comments quote `"include": ["src"]` while explaining what this gate
    // is for, and a regex over the raw file matches the quotation rather than
    // the directive. The breadth assertion below is what caught that.
    const config = fs
      .readFileSync(CONFIG, 'utf8')
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
    const include = config.match(/"include":\s*\[([^\]]*)\]/);
    expect(include).not.toBeNull();
    const entries = include![1]
      .split(',')
      .map(item => item.trim().replace(/^"/, '').replace(/"$/, ''))
      .filter(item => item !== '');

    // Fail-fast on the count. Set equality below subsumes this -- no input can
    // fail the count without also failing the set -- but it fires first and
    // `Received: 4` reads better than a set difference. A null match is already
    // ruled out two lines up, so this is about the message, not the coverage.
    expect(entries.length).toBeGreaterThanOrEqual(COVERED_ENTRY_POINTS.length + 1);
    expect(entries).toContain('src');

    // Set equality on the non-`src` entries, not a per-entry `toContain` floor.
    // A floor only proves the config is a superset of this list, so a file
    // present in the config and absent from the list is unguarded -- which is
    // exactly what `alert-backends.ts` was. Equality also fails on an entry
    // added to the config that nobody added here, which is the review hook.
    expect(new Set(entries.filter(entry => entry !== 'src'))).toEqual(
      new Set(COVERED_ENTRY_POINTS)
    );
  });

  it('RESOLVES every covered entry point, not merely lists it', () => {
    // The assertion above reads the `include` TEXT, and the text is not the
    // gate. Three one-line edits make tsc stop reading a file while leaving
    // that list untouched, all measured on this tree:
    //
    //   "exclude": ["monitor-fuel.ts"]   -> 0 resolved, injected error invisible
    //   the same entry in tsconfig.json  -> inherited through `extends`
    //   renaming the file                -> include entry matches nothing, rc=0
    //
    // In all three the config still lists the file, tsc still exits 0, and
    // every gate in this repo still passes. So this test asks TypeScript's own
    // config reader what the project actually resolves to -- which covers
    // `exclude`, `extends`, `files` and a rename in one assertion, and reads
    // JSONC natively instead of through the regex above.
    const parsed = ts.getParsedCommandLineOfConfigFile(
      CONFIG,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: diagnostic => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
        },
      }
    );
    expect(parsed).toBeDefined();

    const resolved = parsed!.fileNames.map(file => path.resolve(file));

    // Reachability control: a parse that resolved nothing would make every
    // `toContain` below fail, and would do it for a reason unrelated to
    // coverage. `src` alone is a dozen files, so this floor is slack on purpose.
    expect(resolved.length).toBeGreaterThan(COVERED_ENTRY_POINTS.length);

    const directoryEntries = COVERED_ENTRY_POINTS.filter(
      entry =>
        fs.existsSync(path.join(ROOT, entry)) && fs.statSync(path.join(ROOT, entry)).isDirectory()
    );

    for (const entry of COVERED_ENTRY_POINTS) {
      // Not `path.join(ROOT, entry)`: for `scripts` that is a directory path,
      // which is never in `fileNames`. `expectedFilesFor` expands a directory
      // to the files under it and leaves a file entry as itself, so one loop
      // covers both and neither is asserted against something unreachable.
      const files = expectedFilesFor(entry);

      // The loop below asserts nothing at all on an empty list, and an empty
      // list is reachable: an emptied `scripts/` expands to zero files and
      // every `toContain` vanishes with it. So the breadth is asserted, not
      // assumed, once per entry.
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        expect(resolved).toContain(file);
      }
    }

    // The claim the expansion above rests on, as a check rather than a comment:
    // tsc reports the FILES a directory entry expands to and never the
    // directory itself. If that ever stops being true the comment is wrong, and
    // a `toContain` on the bare entry would have been the simpler gate.
    // Control: the three assertions this needs are directly above -- each
    // directory's files ARE in `resolved` -- so this cannot be an absence that
    // holds because nothing resolved.
    expect(directoryEntries.length).toBeGreaterThan(0);
    for (const entry of directoryEntries) {
      expect(resolved).not.toContain(path.join(ROOT, entry));
    }
  });

  it('is invoked by an npm script, which is invoked by CI', () => {
    const scripts = JSON.parse(fs.readFileSync(PACKAGE, 'utf8')).scripts as Record<string, string>;

    // The script must name THIS config. `tsc --noEmit` alone would silently
    // fall back to tsconfig.json and cover `src` only -- green, and blind to
    // every file this gate exists for.
    expect(scripts.typecheck).toBeDefined();
    expect(scripts.typecheck).toContain('tsconfig.typecheck.json');

    // And CI must run it. A script nothing calls is the same non-gate as none;
    // this repo has `dev`, `watch` and `debug` as standing proof of that.
    expect(fs.readFileSync(WORKFLOW, 'utf8')).toMatch(/^\s+run: npm run typecheck$/m);
  });
});
