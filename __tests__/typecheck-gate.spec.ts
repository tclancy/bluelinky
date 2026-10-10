import fs from 'fs';
import path from 'path';

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

/** The root-level entry points the gate must cover, and why each one matters. */
const COVERED_ENTRY_POINTS = ['monitor.ts', 'status-json.ts'];

describe('the typecheck gate', () => {
  it('reachability control: all three files exist and are non-empty', () => {
    // Every assertion below reads one of these. If a rename or a move left one
    // missing, they must fail here rather than pass against an empty string.
    for (const file of [CONFIG, PACKAGE, WORKFLOW]) {
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

    // Control on the control: a regex that matched nothing would make every
    // `toContain` below fail, but a regex that matched an EMPTY list would too
    // -- and this is the assertion that tells those apart from a real removal.
    expect(entries.length).toBeGreaterThanOrEqual(COVERED_ENTRY_POINTS.length + 1);
    expect(entries).toContain('src');
    for (const entry of COVERED_ENTRY_POINTS) {
      expect(entries).toContain(entry);
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
