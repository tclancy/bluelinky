import fs from 'fs';
import path from 'path';

/**
 * Keeps `.github/dependabot.yml` in step with the manifests actually in the
 * tree, and keeps the one deliberate omission honest.
 *
 * Until #48 this file did not exist, so Dependabot ran *security* updates only
 * -- those fire on advisories, and a major bump of a types package is not an
 * advisory. The failure mode was silent in both directions: nothing proposed an
 * update, and nothing said that nothing was proposing one. Merely adding the
 * file does not close that, because the same silence returns the moment a new
 * manifest lands without an ecosystem beside it. So these tests DERIVE the
 * required ecosystem set from the repo contents rather than restating the
 * config, and a new manifest with no ecosystem fails here.
 *
 * The docker block is the interesting one, and it is asserted ABSENT. The
 * Dockerfile's base comes through `ARG NODE_IMAGE=` + `FROM ${NODE_IMAGE}`, and
 * Dependabot's docker updater reads the `FROM` line textually without
 * substituting build arguments (dependabot-core#2057, open since 2020-01-03;
 * the duplicate #4597 closed `not planned` in 2022). An ecosystem entry for it
 * would therefore watch nothing while reading as coverage -- the exact shape of
 * the bug #48 was filed about. The absence is conditional on the interpolation,
 * not permanent: make any `FROM` literal and the pair of tests below flips and
 * demands the block.
 *
 * That flip is necessary but not sufficient, and the test cannot say so on its
 * own, so it is said here. `node-matrix-gate.spec.ts` separately asserts that
 * `ARG NODE_IMAGE`'s major is a leg in CI's `test` matrix. Dependabot bumps to
 * latest, which is outside `[20, 24, 25]`, so a literal `FROM` makes it able to
 * propose a bump that is red the moment it lands -- on purpose, per #25. Adding
 * the ecosystem means moving the matrix in the same change.
 *
 * Hand-rolled readers rather than js-yaml, for the reason given at length in
 * `pre-commit-config.spec.ts`: js-yaml is in node_modules only as an undeclared
 * transitive dependency of eslint, so an eslint bump could remove it and break
 * this file for an entirely unrelated reason.
 */

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, '.github', 'dependabot.yml');

interface Update {
  ecosystem: string;
  directory: string | null;
  interval: string | null;
}

/**
 * Strip a trailing comment.
 *
 * Quote-blind on purpose: a `#` inside a quoted scalar would be stripped too.
 * No value in this file contains one, and if one ever does the truncated value
 * fails an assertion below rather than passing a wrong one -- which is the
 * direction to fail in. Do not read this as a guarantee about quoting.
 */
function uncomment(line: string): string {
  return line.replace(/\s+#.*$/, '').trimEnd();
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]/, '').replace(/['"]$/, '');
}

/**
 * The `updates:` entries, each read from its own `- package-ecosystem:` line to
 * the next one.
 *
 * Deliberately narrow: an entry whose first key is not `package-ecosystem` is
 * not recognised at all, which fails these tests rather than passing them
 * silently. `directory` and `interval` read as `null` when absent, which the
 * assertions below treat as a failure -- a missing schedule is a config
 * GitHub rejects.
 *
 * Known gap, loud rather than silent: Dependabot's multi-directory `directories:`
 * (plural) key is not read, so an entry using it reports `directory: null` and
 * fails with a message blaming a missing `directory`. There are no sub-packages
 * here; teach the reader the plural form before introducing one.
 */
function parseUpdates(yaml: string): Update[] {
  const lines = yaml.split('\n').map(uncomment);
  const updates: Update[] = [];

  for (const line of lines) {
    const head = line.match(/^ {2}- package-ecosystem:\s*(\S+)\s*$/);
    if (head) {
      updates.push({ ecosystem: unquote(head[1]), directory: null, interval: null });
      continue;
    }
    if (updates.length === 0) continue;
    const current = updates[updates.length - 1];

    const directory = line.match(/^ {4}directory:\s*(\S+)\s*$/);
    if (directory) current.directory = unquote(directory[1]);

    const interval = line.match(/^ {6}interval:\s*(\S+)\s*$/);
    if (interval) current.interval = unquote(interval[1]);
  }
  return updates;
}

/**
 * The `dependency-name:` values under any `ignore:` block.
 *
 * Flat across entries on purpose: the assertion below is "is `got` suppressed
 * anywhere", and an ignore smuggled into the wrong ecosystem's entry should
 * still be visible to it rather than hide behind the grouping.
 */
function ignoredNames(yaml: string): Set<string> {
  const names = yaml
    .split('\n')
    .map(uncomment)
    .map(line => line.match(/^ {6}- dependency-name:\s*(\S+)\s*$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(match => unquote(match[1]));
  return new Set(names);
}

/** The `version:` scalar, or null. A wrong one makes GitHub ignore the file. */
function parseVersion(yaml: string): string | null {
  const match = yaml
    .split('\n')
    .map(uncomment)
    .find(line => /^version:/.test(line));
  return match ? unquote(match.slice('version:'.length)) : null;
}

/**
 * Every image reference on a `FROM` line, tagged by whether Dependabot can read
 * it. A reference containing `$` is interpolated from a build argument and
 * resolves to no dependency; anything else is a literal Dependabot can bump.
 */
function fromRefs(dockerfile: string): { ref: string; literal: boolean }[] {
  return dockerfile
    .split('\n')
    .map(uncomment)
    .map(line => line.match(/^FROM\s+(?:--\S+\s+)*(\S+)/i))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(match => ({ ref: match[1], literal: !match[1].includes('$') }));
}

const source = () => fs.readFileSync(CONFIG, 'utf8').replace(/\r\n/g, '\n');
const updates = () => parseUpdates(source());
const ecosystems = () => new Set(updates().map(update => update.ecosystem));

describe('the readers these assertions depend on', () => {
  // Without these, every `toContain`/`toEqual` below is a claim about whatever
  // the parser happened to return -- and a parser that returns nothing makes
  // the absence assertions pass vacuously.
  it("parseUpdates separates entries and reads each entry's keys", () => {
    const parsed = parseUpdates(
      [
        'version: 2',
        'updates:',
        '  - package-ecosystem: "npm"',
        '    directory: "/"',
        '    schedule:',
        '      interval: "weekly"',
        '  - package-ecosystem: "docker"',
        '    directory: "/sub"',
        '    schedule:',
        '      interval: "monthly"',
        '',
      ].join('\n')
    );
    expect(parsed).toEqual([
      { ecosystem: 'npm', directory: '/', interval: 'weekly' },
      { ecosystem: 'docker', directory: '/sub', interval: 'monthly' },
    ]);
  });

  it('parseUpdates does not read an ecosystem out of a comment', () => {
    // The live config argues the docker omission at length in prose, and that
    // prose contains the words `docker` and `package-ecosystem`. If comments
    // leaked into the parse, the absence assertion below would read the
    // explanation for the omission as the omission being undone.
    expect(parseUpdates('updates:\n  # - package-ecosystem: "docker"\n')).toEqual([]);
    expect(parseUpdates('updates:\n  - package-ecosystem: "npm" # docker\n')).toEqual([
      { ecosystem: 'npm', directory: null, interval: null },
    ]);
  });

  it('ignoredNames reads dependency-name entries and not the prose around them', () => {
    expect(
      ignoredNames(
        [
          '    ignore:',
          "      # - dependency-name: 'eslint'",
          "      - dependency-name: 'got'",
          '        update-types:',
          "          - 'version-update:semver-major'",
          '',
        ].join('\n')
      )
    ).toEqual(new Set(['got']));
    expect(ignoredNames("updates:\n  - package-ecosystem: 'npm'\n")).toEqual(new Set());
  });

  it('fromRefs tells an interpolated base from a literal one', () => {
    expect(
      fromRefs('ARG NODE_IMAGE=node:20-slim\nFROM ${NODE_IMAGE} AS deps\nFROM $NODE_IMAGE')
    ).toEqual([
      { ref: '${NODE_IMAGE}', literal: false },
      { ref: '$NODE_IMAGE', literal: false },
    ]);
    expect(
      fromRefs('FROM node:24-slim AS deps\nFROM --platform=$BUILDPLATFORM node:24-slim')
    ).toEqual([
      { ref: 'node:24-slim', literal: true },
      { ref: 'node:24-slim', literal: true },
    ]);
  });
});

describe('.github/dependabot.yml', () => {
  it('reachability control: exists, is version 2, and yields parseable entries', () => {
    // `version: 2` is not decoration -- GitHub ignores a file without it, which
    // reproduces the pre-#48 silence with the file sitting there looking right.
    expect(fs.existsSync(CONFIG)).toBe(true);
    expect(source().trim().length).toBeGreaterThan(0);
    expect(parseVersion(source())).toBe('2');
    expect(updates().length).toBeGreaterThanOrEqual(2);
  });

  it('every entry declares a directory and a weekly schedule', () => {
    // A schedule is mandatory in Dependabot's schema, and `weekly` is the
    // house cadence in every config Tom authored. (The one `monthly` in the
    // fleet is courtlistener's, a vendored upstream fork.)
    for (const update of updates()) {
      expect(update.directory).toBe('/');
      expect(update.interval).toBe('weekly');
    }
  });

  it('declares no ecosystem twice', () => {
    const declared = updates().map(update => update.ecosystem);
    expect(declared.length).toBe(new Set(declared).size);
  });

  it('covers npm, because package.json and its lockfile are at the root', () => {
    expect(fs.existsSync(path.join(ROOT, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'package-lock.json'))).toBe(true);
    expect(ecosystems()).toContain('npm');
  });

  it('covers github-actions, because there are workflows with `uses:` lines', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const workflows = fs.readdirSync(dir).filter(name => /\.ya?ml$/.test(name));
    expect(workflows.length).toBeGreaterThan(0);
    expect(
      workflows.some(name => /^\s*- uses:/m.test(fs.readFileSync(path.join(dir, name), 'utf8')))
    ).toBe(true);
    expect(ecosystems()).toContain('github-actions');
  });

  it('covers pre-commit for exactly as long as a third-party hook repo is rev-pinned', () => {
    // Derived rather than hardcoded, so retiring the last pinned repo does not
    // leave a dead entry that nobody notices, and adding one back is covered.
    const config = fs.readFileSync(path.join(ROOT, '.pre-commit-config.yaml'), 'utf8');
    const pinned = config.split('\n').filter(line => /^\s+rev:\s*\S/.test(line));
    expect(ecosystems().has('pre-commit')).toBe(pinned.length > 0);
  });

  it('omits docker for exactly as long as the Dockerfile base is interpolated', () => {
    // The flip-side pair. Today every `FROM` is `${NODE_IMAGE}`, which
    // Dependabot cannot resolve, so an entry would watch nothing while reading
    // as coverage. Make any base literal and this demands the block instead --
    // and see the docblock before obeying it: `node-matrix-gate.spec.ts` needs
    // the base major to be a leg in the `test` matrix, so the ecosystem wants
    // that matrix moved in the same change, or every bump is red on arrival.
    const refs = fromRefs(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'));
    expect(refs.length).toBeGreaterThan(0);
    expect(ecosystems().has('docker')).toBe(refs.some(ref => ref.literal));
  });

  it('suppresses got majors for exactly as long as src imports got@9-only types', () => {
    // The third conditional, same shape as the pre-commit and docker pairs.
    // `GotInstance` and `GotJSONFn` do not exist in got's own typings from v10
    // on, so while src still names them a major bump cannot typecheck and the
    // ignore has to be there. Migrate off them and this test fails, which is
    // the reminder to delete the ignore rather than leave `got` frozen forever
    // because nobody remembered why.
    const sources = ['controllers', 'vehicles']
      .flatMap(dir => {
        const base = path.join(ROOT, 'src', dir);
        return fs.readdirSync(base).map(name => path.join(base, name));
      })
      .filter(file => file.endsWith('.ts'))
      .map(file => fs.readFileSync(file, 'utf8'));
    expect(sources.length).toBeGreaterThan(5);

    const usesGot9Types = sources.some(source => /\bGotInstance\b|\bGotJSONFn\b/.test(source));
    expect(ignoredNames(source()).has('got')).toBe(usesGot9Types);
  });

  it('declares nothing beyond the ecosystems the tree can justify', () => {
    // The closing half. Without it the tests above are satisfied by a config
    // that also declares `cargo`, `gomod` and `bundler` -- entries that fail
    // on every run and train the reader to ignore Dependabot noise.
    expect(ecosystems()).toEqual(new Set(['npm', 'github-actions', 'pre-commit']));
  });
});
