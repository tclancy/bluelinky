import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Guards the runtime image's CONTENT against the three defects issue #25 found,
 * all measured on the live plexpi image on 2026-10-11 before this change:
 *
 *   1. 1.22 GB, 458 top-level node_modules directories, with `jest`, `rollup`,
 *      `eslint`, `typescript` and `prettier` in the runtime filesystem, plus
 *      `python3`, `make` and `g++`. The runtime dependency list is seven
 *      packages.
 *   2. `/app/.env` -- BLUELINK_USERNAME, BLUELINK_PASSWORD, BLUELINK_PIN and the
 *      ntfy credentials, 460 bytes, dated Apr 10 2026 -- baked into an image
 *      layer by `COPY . .` with no `.dockerignore` in the repo at all.
 *      docker-compose.yml mounts the real file over it, so it never surfaced.
 *   3. `RUN npm run build || true`, producing a dist/ nothing in the container
 *      reads, with failures swallowed.
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT: the issue's first success
 * criterion, "a cold rebuild with an unchanged lockfile finishes in well under
 * a minute after the first run". Docker layer caching already did that before
 * this change -- the old Dockerfile copied the manifests before installing, so
 * an unchanged-manifest rebuild was already cached. The criterion was already
 * true of the broken image and cannot discriminate.
 *
 * Its second criterion cannot discriminate either, and that one was measured
 * rather than reasoned: run against the live 1.22 GB image with all 458
 * directories and every dev tool present,
 *
 *     docker exec bluelinky-fuel-monitor npm ls --omit=dev --depth=0
 *
 * printed exactly the six runtime dependencies. `--omit=dev` filters the tree
 * to what is DECLARED in `dependencies`; it says nothing about what is
 * installed. So the assertions below are about the Dockerfile and the build
 * context -- the inputs that decide image content -- rather than about an npm
 * query that answers a different question.
 */

const REPO_ROOT = path.join(__dirname, '..');

const DOCKERFILE = 'Dockerfile';
const DOCKERIGNORE = '.dockerignore';
const CRONTAB = 'deployment/crontab';
const ENTRYPOINT = 'deployment/entrypoint.sh';

/** Compilers and build tools that have no business in a runtime image. */
const BUILD_TOOLCHAIN = ['python3', 'make', 'g++', 'gcc'];

/**
 * `find . -type f` from `/app` in the image this branch builds, excluding
 * `node_modules/` and `state/` (the two trees the Dockerfile creates rather
 * than copies). **Re-measured 2026-10-13** on `docker build --platform
 * linux/arm64`, docker 29.8.2 / buildx 0.37.2 (read off `docker version`, not
 * copied -- see below), against the .dockerignore in this commit: 50 files.
 * First measured 2026-10-11 at 49.
 *
 * WHY IT MOVED, because the next reader will meet this again (issue #40). The
 * one added entry is `src/tools/runtime.tools.ts`, which PR #30 created. This
 * pin is per-FILE and `.dockerignore` re-admits `src/` WHOLESALE via `!src`, so
 * every new file under `src/` ships and every new file under `src/` makes this
 * pin stale. PR #33 merged its 49-file pin at 11:18Z and PR #30 added the 50th
 * file at 11:24Z (both merge times; the 49 was measured 2026-10-11, as above).
 * Each was green on its own branch and `main` was red from the second merge
 * onward, in either order. No `merge-tree` conflict sweep can see that coming,
 * because the two changes never touch the same line.
 *
 * The engine version above is read off `docker version` deliberately. The first
 * draft of this docblock said "docker 29.4", third-hand from the Dockerfile's
 * own comment via issue #40's body; this box is 29.8.2 and has been for a while.
 * plexpi really is 29.4.3 / buildx 0.33.0, measured the same day -- so the
 * Dockerfile's claim was true when written and drifted on the Mac side only.
 * A copied figure in the one docblock whose whole job is to be an observed
 * record is the same failure this constant exists to prevent, one level up.
 *
 * REGENERATE IT, NEVER EDIT IT. The whole value of this constant is that it
 * comes from outside the predictor; appending whatever `predicted` asked for
 * turns the control into a copy of the thing it grades. The command is:
 *
 *     docker build --platform linux/arm64 -t bluelinky-measure .
 *     docker run --rm --entrypoint sh bluelinky-measure \
 *       -c 'cd /app && find . -type f | sed "s|^\./||" \
 *           | grep -v "^node_modules/" | grep -v "^state/" | sort'
 *
 * This is the only thing here that ties the .dockerignore evaluator below to
 * Docker's real behaviour: the evaluator is our reimplementation of
 * last-match-wins glob semantics, and a reimplementation that is wrong in the
 * same direction as its own assertions proves nothing. Pinning an OBSERVED
 * listing makes the evaluator answerable to something outside itself.
 *
 * **It is a DEEP listing on purpose.** This was a top-level `ls -A /app` of ten
 * entries, and the review caught what that cannot grade: the predictor built
 * its input with `file.split('/')[0]`, so `isExcluded` was only ever called
 * with single-segment paths and the two rules the comment above names -- the
 * ancestor rule and last-match-wins -- were graded solely against the suite's
 * own synthetic cases. Both of those rules only do anything at depth. The
 * narrowing of `!deployment` to two named files in this same commit is the
 * worked example: it changes nothing at the top level (BuildKit still
 * materialises `deployment/` for the files inside it) and drops
 * `deployment/README.md` one level down, which only a deep listing can see.
 */
const MEASURED_IMAGE_FILES = [
  'alert-backends.ts',
  'deployment/crontab',
  'deployment/entrypoint.sh',
  'get-fuel-level.ts',
  'monitor-fuel.ts',
  'monitor.ts',
  'package-lock.json',
  'package.json',
  'src/constants.ts',
  'src/constants/america.ts',
  'src/constants/australia.cfb.ts',
  'src/constants/australia.ts',
  'src/constants/canada.ts',
  'src/constants/china.ts',
  'src/constants/europe.cfb.ts',
  'src/constants/europe.ts',
  'src/constants/seatheatvent.ts',
  'src/constants/stamps.ts',
  'src/controllers/american.controller.ts',
  'src/controllers/australia.controller.ts',
  'src/controllers/authStrategies/australia.authStrategy.ts',
  'src/controllers/authStrategies/authStrategy.ts',
  'src/controllers/authStrategies/china.authStrategy.ts',
  'src/controllers/authStrategies/chinese.legacyAuth.strategy.ts',
  'src/controllers/authStrategies/european.brandAuth.strategy.ts',
  'src/controllers/authStrategies/european.legacyAuth.strategy.ts',
  'src/controllers/canadian.controller.ts',
  'src/controllers/chinese.controller.ts',
  'src/controllers/controller.ts',
  'src/controllers/european.controller.ts',
  'src/index.ts',
  'src/interfaces/american.interfaces.ts',
  'src/interfaces/chinese.interfaces.ts',
  'src/interfaces/common.interfaces.ts',
  'src/interfaces/european.interfaces.ts',
  'src/logger.ts',
  'src/monitor-helpers.ts',
  'src/status-json.ts',
  'src/tools/common.tools.ts',
  'src/tools/runtime.tools.ts',
  'src/util.ts',
  'src/vehicle-db.ts',
  'src/vehicles/american.vehicle.ts',
  'src/vehicles/australia.vehicle.ts',
  'src/vehicles/canadian.vehicle.ts',
  'src/vehicles/chinese.vehicle.ts',
  'src/vehicles/european.vehicle.ts',
  'src/vehicles/vehicle.ts',
  'status-json.ts',
  'tsconfig.json',
];

/** Everything under here is re-admitted wholesale by `.dockerignore`'s `!src`. */
const SRC_PREFIX = 'src/';

/**
 * The observed listing above, split into the two different questions it was
 * answering at once (issue #42). **This is the whole of the #42 fix: one
 * observation, two gradings.**
 *
 * The old shape asserted exact correspondence against the WHOLE listing, which
 * conflated a stable question with a volatile one:
 *
 * - **Do the rules match Docker?** Stable. It only changes when somebody edits
 *   `.dockerignore`, and `*` makes the repo root fail-closed, so adding a
 *   runtime entrypoint means editing that file anyway.
 * - **Which files happen to exist under `src/` today?** Volatile, and nothing
 *   to do with the rules. `!src` re-admits the directory wholesale, so this
 *   moved every time anyone added a source file -- and because fixing the pin
 *   needs a docker build that CI does not have, `main` went red and stayed red
 *   until someone with docker re-measured. That is #40, and it cost ten hours.
 *
 * So the non-`src/` half stays an EXACT equality and the `src/` half becomes
 * derived, with the observed `src/` paths kept as a subset check.
 *
 * **The exactness on the non-`src/` half is not optional, and the shape of
 * that claim was measured rather than argued.** Re-admitting one unenumerated
 * dev file (`!CHANGELOG.md`) leaves every other test in this file green, so
 * whatever catches it has to live in the `predicts` test. What catches it is
 * an *extra-entry* check -- the set equality, or membership plus an exact
 * length. A bare membership loop or a count floor does not: with the equality
 * replaced by a `toContain` loop and the length assertion dropped, that
 * re-admission is green 12/12. See the PR for the round.
 *
 * Neither half is hand-maintained: regenerate `MEASURED_IMAGE_FILES` with the
 * command in its docblock and both follow.
 */
const MEASURED_NON_SRC = MEASURED_IMAGE_FILES.filter(file => !file.startsWith(SRC_PREFIX));
const MEASURED_SRC_OBSERVED = MEASURED_IMAGE_FILES.filter(file => file.startsWith(SRC_PREFIX));

function read(file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

function tracked(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter(f => f !== '');
}

// ---------------------------------------------------------------------------
// Dockerfile stages
// ---------------------------------------------------------------------------

type Stage = { name: string | null; from: string; lines: string[] };

/**
 * Split a Dockerfile into stages, with line continuations folded.
 *
 * Folding matters: the install lines here are `RUN apt-get update && \` across
 * three physical lines, so a per-physical-line scan for `g++` reads a line that
 * contains neither `apt-get` nor `RUN` and cannot tell an install from a
 * comment.
 */
function stagesOf(body: string): Stage[] {
  const logical: string[] = [];
  let buffer = '';
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*#/.test(line) && buffer === '') continue;
    if (/\\$/.test(line)) {
      buffer += line.replace(/\\$/, ' ');
      continue;
    }
    logical.push((buffer + line).trim());
    buffer = '';
  }
  if (buffer !== '') logical.push(buffer.trim());

  // Global ARG defaults, so `FROM ${NODE_IMAGE}` resolves. Without this the
  // base image is opaque to every assertion about it, and the node-major test
  // below silently measures NaN -- which is how it first failed.
  const args = new Map<string, string>();
  for (const line of logical) {
    if (/^FROM\s/i.test(line)) break;
    const arg = line.match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)/i);
    if (arg) args.set(arg[1], arg[2]);
  }
  const resolve = (ref: string) =>
    ref.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (whole, name) => args.get(name) ?? whole);

  const stages: Stage[] = [];
  for (const line of logical) {
    const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      stages.push({ name: from[2] ?? null, from: resolve(from[1]), lines: [] });
      continue;
    }
    if (stages.length > 0 && line !== '') stages[stages.length - 1].lines.push(line);
  }
  return stages;
}

/** Any npm command that materialises a dependency tree. */
const NPM_INSTALL = /\bnpm\s+(?:ci|install|i|add)\b/;

/** An apt/apk install line naming one of the build tools. */
function installsToolchain(line: string): string[] {
  if (!/\b(?:apt-get|apt|apk)\s+(?:install|add)\b/.test(line)) return [];
  return BUILD_TOOLCHAIN.filter(tool =>
    new RegExp(String.raw`(?:^|\s)${tool.replace(/\+/g, '\\+')}(?=\s|$)`).test(line)
  );
}

// ---------------------------------------------------------------------------
// Runtime interpreters, derived from what the box actually runs
// ---------------------------------------------------------------------------

/**
 * Package names invoked via `npx` on a runnable line of the given file.
 *
 * DERIVED, not hardcoded to `tsx`, and that is the point: this suite's job is
 * to notice when the scheduled job starts needing an interpreter that
 * `--omit=dev` strips. A hardcoded `expect(deps).toContain('tsx')` cannot see a
 * crontab that switches to a different runner, which is exactly the change
 * issue #25 contemplates.
 */
function npxInvocations(body: string): Set<string> {
  const found = new Set<string>();
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    for (const match of line.matchAll(/\bnpx\s+(?:-{1,2}\S+\s+)*([@\w][\w@/.-]*)/g)) {
      found.add(match[1]);
    }
  }
  return found;
}

/** Repo-relative script paths named on a runnable `npx` line. */
function npxScriptTargets(body: string): Set<string> {
  const found = new Set<string>();
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    for (const match of line.matchAll(/\bnpx\s+\S+\s+(\S+\.ts)\b/g)) {
      found.add(match[1].replace(/^\/app\//, '').replace(/^\.\//, ''));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// .dockerignore evaluation
// ---------------------------------------------------------------------------

type Pattern = { source: string; negated: boolean; re: RegExp };

/** Compile a .dockerignore line to a regex over a full slash-separated path. */
function compilePattern(raw: string): Pattern | null {
  let source = raw.trim();
  if (source === '' || source.startsWith('#')) return null;
  const negated = source.startsWith('!');
  if (negated) source = source.slice(1).trim();
  source = source.replace(/^\.\//, '').replace(/\/+$/, '');

  let re = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '*') {
      if (source[i + 1] === '*') {
        i++;
        if (source[i + 1] === '/') {
          // `**/` is "zero or more directory levels", which is moby's
          // `((.*/)|([^/]*))` -- the second alternative is the zero-level case.
          //
          // It was `.*` here, which is the SAME alternation minus the trailing
          // slash, and the difference is fail-open: `**/.env` compiled to
          // `^.*\.env$`, so this evaluator said `src/a.env` and
          // `deployment/creds.env` were excluded when real BuildKit ships both.
          // Every assertion in the file stayed green because all four cases it
          // checked (`.env`, `.env.local`, `.env.production`, `deployment/.env`)
          // are correct either way -- i.e. the reimplementation was wrong in the
          // same direction as its own assertions, which is the failure this
          // file's header claims to have ruled out. The battery in
          // `matches BuildKit's own glob semantics` is the control now.
          i++;
          re += '((.*/)|([^/]*))';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return { source: raw.trim(), negated, re: new RegExp(`^${re}$`) };
}

function compileIgnore(body: string): Pattern[] {
  return body
    .split('\n')
    .map(compilePattern)
    .filter((p): p is Pattern => p !== null);
}

/**
 * Whether Docker would exclude `target` from the build context.
 *
 * Two rules, both of which this repo's .dockerignore depends on:
 *  - a pattern matching any ANCESTOR of the path applies to the path, which is
 *    how `*` excludes `src/index.ts` and how `!src` re-admits it;
 *  - the LAST matching pattern wins, which is how the trailing `.env` rules
 *    survive the `!deployment` re-inclusion above them.
 */
function isExcluded(target: string, patterns: Pattern[]): boolean {
  const segments = target.split('/');
  const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  let excluded = false;
  for (const pattern of patterns) {
    if (prefixes.some(prefix => pattern.re.test(prefix))) excluded = !pattern.negated;
  }
  return excluded;
}

// ---------------------------------------------------------------------------

describe('runtime image content (issue #25)', () => {
  let files: string[];
  let stages: Stage[];
  let patterns: Pattern[];

  beforeAll(() => {
    files = tracked();
    stages = stagesOf(read(DOCKERFILE));
    patterns = compileIgnore(read(DOCKERIGNORE));

    // Reachability. Every absence assertion below is over one of these three,
    // and all three would pass vacuously if empty.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(DOCKERFILE);
    expect(files).toContain(DOCKERIGNORE);
    expect(files).toContain(CRONTAB);
    expect(files).toContain(ENTRYPOINT);
    expect(stages.length).toBeGreaterThan(0);
    expect(patterns.length).toBeGreaterThan(0);
  });

  it('builds in more than one stage, pinned to a single base image', () => {
    expect(stages.length).toBeGreaterThanOrEqual(2);

    // One base image across every stage. Two literal `node:NN-slim` spellings
    // drift independently, and the runtime one is the one that decides which
    // transport arm the Canadian region selects (see the node-version test).
    //
    // Under the `ARG NODE_IMAGE=` form this equality is trivially true, so it
    // is NOT the whole assertion: the concreteness check beside it is what
    // keeps the pair meaningful. Together they say "every stage resolves to the
    // same, readable, pinned image" -- which stays falsifiable if someone
    // replaces the ARG with two literals.
    const bases = [...new Set(stages.map(stage => stage.from))];
    expect(bases).toHaveLength(1);
    expect(bases[0]).toMatch(/^node:\d+-slim$/);
    expect(stagesOf('FROM node:20-slim AS a\nFROM node:24-slim').map(s2 => s2.from)).toEqual([
      'node:20-slim',
      'node:24-slim',
    ]);

    // A named non-final stage is what `COPY --from=` refers to.
    const final = stages[stages.length - 1];
    const earlier = stages.slice(0, -1);
    expect(earlier.some(stage => stage.name !== null)).toBe(true);
    expect(final.lines.some(line => /COPY\s+--from=/.test(line))).toBe(true);
  });

  it('installs no dependency tree in the final stage', () => {
    const final = stages[stages.length - 1];
    expect(final.lines.filter(line => NPM_INSTALL.test(line))).toEqual([]);

    // ...and does install one somewhere earlier, or the image has no deps.
    const earlier = stages.slice(0, -1).flatMap(stage => stage.lines);
    expect(earlier.filter(line => NPM_INSTALL.test(line)).length).toBeGreaterThan(0);

    // Control: each spelling must be detected, or "no install in the final
    // stage" is a claim about one word rather than about the behaviour.
    for (const sample of [
      'RUN npm ci --omit=dev',
      'RUN npm install --production',
      'RUN npm i tsx',
      'RUN npm add tsx',
    ]) {
      expect(NPM_INSTALL.test(sample)).toBe(true);
    }
    for (const sample of ['RUN npm run build', 'RUN npm ls --depth=0']) {
      expect(NPM_INSTALL.test(sample)).toBe(false);
    }
    // A comment naming an install must not read as one. NPM_INSTALL alone DOES
    // match `# npm ci is below` -- comments are stripped a layer up, by
    // stagesOf, so that is where the guarantee lives and where it is asserted.
    expect(NPM_INSTALL.test('# npm ci is below')).toBe(true);
    expect(stagesOf('FROM node:20-slim\n# RUN npm ci\nRUN true').at(-1)!.lines).toEqual([
      'RUN true',
    ]);
  });

  it('ships no compiler in the final stage', () => {
    const final = stages[stages.length - 1];
    const offenders = final.lines.flatMap(line =>
      installsToolchain(line).map(tool => ({ tool, line }))
    );
    expect(offenders).toEqual([]);

    // Reachability: the toolchain must be installed SOMEWHERE, or this test
    // passes because nothing in the file installs anything and the detector is
    // never driven by the real Dockerfile at all.
    //
    // The literal set, not a self-derived one. This was
    // `expect(found.sort()).toEqual(BUILD_TOOLCHAIN.sort().filter(t =>
    // found.includes(t)))`, which re-derives its own expectation from its own
    // input -- only a duplicate entry could ever have failed it, so the
    // `.length > 0` line beside it was carrying the whole claim. `gcc` is
    // absent on purpose: it is in BUILD_TOOLCHAIN so the final-stage sweep
    // above refuses it, and the `deps` stage installs `g++` instead.
    const earlier = stages.slice(0, -1).flatMap(stage => stage.lines);
    expect(earlier.flatMap(installsToolchain).sort()).toEqual(['g++', 'make', 'python3']);

    // Control: one per tool, driven individually. `g++` is the one a naive
    // regex drops, because `+` is a quantifier.
    for (const tool of BUILD_TOOLCHAIN) {
      expect(installsToolchain(`RUN apt-get install -y ${tool} cron`)).toEqual([tool]);
    }
    // Negative controls: a package whose name merely CONTAINS a tool name, and
    // a line that is not an install at all.
    expect(installsToolchain('RUN apt-get install -y python3-dev')).toEqual([]);
    expect(installsToolchain('RUN make -C /app build')).toEqual([]);
    expect(installsToolchain('# needs python3 make g++ to compile')).toEqual([]);
  });

  it('uses no npm flag that was retired before npm 8', () => {
    // `--production=false` is the npm 6 spelling, and it asked for behaviour
    // npm already had by default: devDependencies install unless
    // NODE_ENV=production, which nothing in this image sets. It was the flag
    // that pulled the whole dev toolchain in while reading like a decision.
    const body = read(DOCKERFILE);
    const runnable = stagesOf(body).flatMap(stage => stage.lines);
    expect(runnable.filter(line => /--production\b/.test(line))).toEqual([]);

    // Control: the pattern fires on the retired flag, and `stagesOf` strips
    // comments, so a mutant that re-adds the flag inside the prose must NOT
    // turn this red. Driven on a synthetic comment rather than on this file's
    // own prose: `expect(body).toMatch(/--production=false/)` asserted that the
    // explanatory comment still contains that exact string, which couples the
    // suite to wording and goes red on a harmless reword.
    expect(/--production\b/.test('RUN npm ci --production=false')).toBe(true);
    expect(runnable.some(line => /--omit=dev/.test(line))).toBe(true);
    expect(
      stagesOf('FROM x\n# RUN npm ci --production=false\nRUN npm ci --omit=dev')
        .flatMap(stage => stage.lines)
        .filter(line => /--production\b/.test(line))
    ).toEqual([]);
  });

  it('runs no build step the container does not read', () => {
    // `monitor.ts` imports `./src/index.ts` and `status-json.ts` imports
    // `./src/status-json.ts`, both directly through tsx. Nothing in the image
    // reads dist/, so building one is dead work -- and the old `|| true`
    // swallowed its failures.
    const runnable = stages.flatMap(stage => stage.lines);
    expect(runnable.filter(line => /\bnpm\s+run\s+build\b/.test(line))).toEqual([]);
    expect(runnable.filter(line => /\|\|\s*true/.test(line))).toEqual([]);
  });

  it('keeps every interpreter the scheduled job needs out of devDependencies', () => {
    const manifest = JSON.parse(read('package.json'));
    const deps = Object.keys(manifest.dependencies ?? {});
    const devDeps = Object.keys(manifest.devDependencies ?? {});

    // Derived from the two files the image installs and runs, not hardcoded.
    const needed = new Set([...npxInvocations(read(CRONTAB)), ...npxInvocations(read(ENTRYPOINT))]);

    // Reachability: an empty set is a subset of anything, so a broken extractor
    // would pass the real assertion silently.
    expect(needed.size).toBeGreaterThan(0);

    // The property: `npm ci --omit=dev` keeps `dependencies` and drops
    // `devDependencies`, so anything the container invokes must be in the first.
    expect([...needed].filter(pkg => !deps.includes(pkg))).toEqual([]);
    expect([...needed].filter(pkg => devDeps.includes(pkg))).toEqual([]);

    // Control for the extractor, per shape it must handle.
    expect([...npxInvocations('0 * * * * cd /app && npx tsx monitor.ts')]).toEqual(['tsx']);
    expect([...npxInvocations('npx --yes tsx status-json.ts')]).toEqual(['tsx']);
    expect([...npxInvocations('npx @scope/runner x.ts')]).toEqual(['@scope/runner']);
    // Negative: a commented-out line is not something the box runs.
    expect([...npxInvocations('# 0 * * * * npx ts-node monitor.ts')]).toEqual([]);
    expect([...npxInvocations('node dist/monitor.js')]).toEqual([]);
  });

  it('excludes the credentials, the host dependency tree, and the dev-only files', () => {
    for (const secret of [
      '.env',
      '.env.local',
      '.env.production',
      'deployment/.env',
      // The four below are the review's finding, and all four SHIPPED out of
      // real BuildKit under the `!deployment` + `**/.env` shape this file had
      // before this commit. Measured, not reasoned -- `FROM busybox` /
      // `COPY . /ctx` / `find /ctx -type f` on docker 29.4:
      //
      //   /ctx/deployment/creds.env           <- shipped
      //   /ctx/deployment/plexpi-secret.yaml  <- shipped
      //   /ctx/src/a.env                      <- shipped
      //
      // Two independent fixes are needed and each was isolated against
      // BuildKit on its own: narrowing `!deployment` to the two named files
      // handles the first two, and `**/*.env` handles the third (re-running the
      // narrowed context with that one line removed ships `src/a.env` again).
      'deployment/creds.env',
      'deployment/plexpi-secret.yaml',
      'deployment/README.md',
      'src/a.env',
      'src/constants/x.env',
    ]) {
      expect({ secret, excluded: isExcluded(secret, patterns) }).toEqual({
        secret,
        excluded: true,
      });
    }

    // The honest limit of the allow-list, asserted so nobody has to discover it
    // by shipping one. `!src` re-admits the whole library, so a NON-secrets-
    // shaped new file under `src/` ships -- real BuildKit shipped
    // `/ctx/src/credentials.json` in the same probe above, and still does.
    // Pinned as `false` deliberately: if someone later makes `src/` fail-closed
    // this test goes red and the `.dockerignore` header needs its caveat
    // deleting.
    expect({
      known_gap: 'src/credentials.json',
      excluded: isExcluded('src/credentials.json', patterns),
    }).toEqual({ known_gap: 'src/credentials.json', excluded: false });

    // node_modules is load-bearing rather than hygiene: the runtime stage
    // copies a dev-free tree from `deps`, and `COPY . .` runs AFTER it, so a
    // host node_modules in the context would overwrite it.
    for (const dropped of [
      'node_modules',
      'node_modules/jest/package.json',
      'node_modules/.package-lock.json',
      '.git/config',
      'dist/index.cjs',
      'dist-types/index.d.ts',
      '__tests__/vehicle.spec.ts',
      'rollup.config.js',
      'babel.config.js',
      'jest.config.cjs',
      '.github/workflows/ci.yaml',
      'README.md',
    ]) {
      expect({ dropped, excluded: isExcluded(dropped, patterns) }).toEqual({
        dropped,
        excluded: true,
      });
    }
  });

  it('keeps every file the runtime actually reads', () => {
    for (const kept of [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'monitor.ts',
      'status-json.ts',
      'alert-backends.ts',
      'src/index.ts',
      'src/vehicle-db.ts',
      'src/controllers/canadian.controller.ts',
      'deployment/crontab',
      'deployment/entrypoint.sh',
    ]) {
      expect({ kept, excluded: isExcluded(kept, patterns) }).toEqual({ kept, excluded: false });
    }

    // Completeness, derived rather than listed: every script the crontab and
    // the entrypoint name must survive the context filter. A listed set cannot
    // see a NEW scheduled script; this can.
    const targets = new Set([
      ...npxScriptTargets(read(CRONTAB)),
      ...npxScriptTargets(read(ENTRYPOINT)),
    ]);
    expect(targets.size).toBeGreaterThan(0);
    for (const target of targets) {
      expect(files).toContain(target);
      expect({ target, excluded: isExcluded(target, patterns) }).toEqual({
        target,
        excluded: false,
      });
    }

    // And the whole library: `src/` is imported wholesale through tsx, so a
    // single dropped file is a runtime crash in a path nothing here executes.
    const dropped = files
      .filter(file => file.startsWith('src/'))
      .filter(file => isExcluded(file, patterns));
    expect(dropped).toEqual([]);
    expect(files.filter(file => file.startsWith('src/')).length).toBeGreaterThan(20);
  });

  it('predicts the image contents that were actually built', () => {
    // The evaluator above is our reimplementation of Docker's glob semantics.
    // Grade it against an OBSERVED listing from the built image rather than
    // against more of its own assertions -- see MEASURED_IMAGE_FILES.
    //
    // Per FILE, not per top-level entry: the ancestor rule and last-match-wins
    // only do anything at depth, so a top-level comparison calls `isExcluded`
    // with single-segment paths exclusively and grades neither.
    const predicted = files.filter(file => !isExcluded(file, patterns)).sort();
    const predictedNonSrc = predicted.filter(file => !file.startsWith(SRC_PREFIX));
    const predictedSrc = predicted.filter(file => file.startsWith(SRC_PREFIX));
    const trackedSrc = files.filter(file => file.startsWith(SRC_PREFIX)).sort();

    // (1) THE RULES -- exact correspondence against the observed listing.
    //
    // Exact, not membership: a too-permissive allow-list shows up as an extra
    // entry, a too-strict one as a missing entry, and a BARE `toContain` loop
    // catches only the second. **Measured, not argued** -- with this equality
    // replaced by a `toContain` loop and the length assertion below dropped,
    // re-admitting one unenumerated dev file (`!CHANGELOG.md`) is green 12/12.
    // The equality kills it with or without that length assertion, and no
    // other test in this file sees the re-admission at all.
    //
    // It can afford to be exact because it no longer moves when someone adds a
    // source file -- that was issue #40 and it is now (2)'s business. The repo
    // root is fail-closed (`*`), so a NEW non-`src/` entry here means somebody
    // deliberately edited `.dockerignore`, which is the right moment to
    // re-measure. WHEN THIS GOES RED, read the sign:
    //
    //   `+` (in the image, not in the observation) -- either that deliberate
    //       re-admission, in which case REGENERATE with the command in
    //       MEASURED_IMAGE_FILES's docblock; or the allow-list is admitting a
    //       file nobody intended, which is the defect this file exists for.
    //   `-` (in the observation, not in the image) -- something the runtime
    //       reads stopped shipping. Fix the code, not the observation.
    //
    // Either way: NEVER paste `predicted` into the observation. That makes the
    // control a copy of the thing it grades.
    expect(predictedNonSrc).toEqual([...MEASURED_NON_SRC].sort());

    // (2) `src/` MEMBERSHIP -- derived, never pinned.
    //
    // `!src` re-admits the directory wholesale, so the correct expectation is
    // "every tracked file under `src/`, whatever they happen to be today",
    // which cannot go stale. That is the entire point of issue #42.
    //
    // **This RESTATES the `dropped` assertion in `keeps every file the runtime
    // actually reads` above, and adds no power over it.** `predictedSrc` is
    // filtered out of `files`, so it is a subset of `trackedSrc` whatever the
    // rules say; the equality can only fail in the missing direction, which is
    // exactly `expect(dropped).toEqual([])`. There is no input that separates
    // them. It is here so the three gradings read together, and written as an
    // equality for the failure message -- not because it catches anything the
    // other test does not. A mutation round weakening it to `toContain`
    // survives on its own, for the same reason.
    expect(predictedSrc).toEqual(trackedSrc);

    // (3) ...but (2) and the `dropped` check both derive from the same
    // `git ls-files` the predictor reads, so between them they only prove the
    // evaluator agrees with itself. These paths were OBSERVED in a real build,
    // and keeping them is what makes `!src` answerable to Docker.
    //
    // Intersected with what is tracked TODAY, and that intersection is half of
    // the #42 fix rather than a convenience. #42's problem statement is "every
    // PR that adds, DELETES or RENAMES a file under `src/`": without the
    // filter, deleting or renaming a source file leaves its path in the
    // observation, absent from `predictedSrc`, and the loop below goes red
    // with nothing wrong -- the same false red as the add case, arriving from
    // the other side. A path that is no longer tracked has no claim to make.
    //
    // What survives the filter still has teeth: a file that is tracked and
    // stops shipping stays in the set and fails the loop. So the control holds
    // in the direction that is a defect and yields in the two that are not.
    //
    // WHEN THE LOOP GOES RED, the path it names is tracked and is not
    // predicted to ship, which means the rules stopped admitting something the
    // runtime reads. That is a code defect -- fix `.dockerignore`, not the
    // observation. (And note the remedy for a legitimately stale entry never
    // needs docker: DELETING a line from `MEASURED_IMAGE_FILES` cannot turn
    // the control into a copy of the predictor. Only adding one can.)
    const observedStillTracked = MEASURED_SRC_OBSERVED.filter(file => files.includes(file));

    // The observation must stay broad and DEEP, because the ancestor rule and
    // last-match-wins only do anything below the top level. The depth set is
    // asserted rather than a maximum: trimming the observation to depths 3 and
    // 4 would still clear a `>= 4` max while losing every depth-2 case.
    expect(observedStillTracked.length).toBeGreaterThan(20);
    expect(new Set(observedStillTracked.map(file => file.split('/').length))).toEqual(
      new Set([2, 3, 4])
    );
    for (const observed of observedStillTracked) {
      expect(predictedSrc).toContain(observed);
    }

    // Degenerate input is already handled elsewhere, and this block does NOT
    // repeat it -- an earlier draft claimed it did and was wrong twice over.
    // An empty `files` fails the floor in `beforeAll` and this test never
    // runs; an all-admitting evaluator fails (1)'s equality above. Both of the
    // inputs that draft named die before reaching here.
    //
    // What is left is one piece of insurance and one live assertion. The
    // length check is implied by (1)'s equality TODAY and exists only to keep
    // the hole shut if somebody ever weakens that equality to membership --
    // see MEASURED_NON_SRC's docblock, where the measured claim is that an
    // extra entry needs the equality OR an exact length, and removing both is
    // green. The last line is the only one here that can fail as written.
    expect(predictedNonSrc).toHaveLength(MEASURED_NON_SRC.length);
    expect(files.length).toBeGreaterThan(predicted.length);
  });

  it('pins the node major that selects the Canadian got transport', () => {
    // Not style. `canadian.controller.ts` and `canadian.vehicle.ts` both branch
    // on `process.versions.node >= 21`: below it the region uses `got`, at or
    // above it undici's `fetch`. plexpi's container reports v20.20.2 -- measured
    // 2026-10-11 -- so production runs the `got` arm today, which is also the
    // arm CI pins.
    //
    // Bumping this base image is therefore a production transport switch, not a
    // maintenance bump, and issue #32 documents four behavioural divergences
    // between the arms (one reporting a failed lock as successful). Node 20 is
    // past end-of-life and this pin should move -- behind #30 and #32, with the
    // switch as the headline rather than as a rider. See issue #25.
    const major = Number(stages[0].from.match(/node:(\d+)/)?.[1]);
    expect(Number.isInteger(major)).toBe(true);
    expect(major).toBeLessThan(21);
  });

  it('evaluates .dockerignore the way the ordering rules require', () => {
    // Control for isExcluded itself. Each case is a rule this repo's
    // .dockerignore depends on; neutering either rule leaves the real
    // assertions above green on a wrong file set.
    const of = (body: string) => compileIgnore(body);

    // Deny-all, then re-admit: the allow-list shape.
    const allow = of('*\n!src\n!package.json');
    expect(isExcluded('README.md', allow)).toBe(true);
    expect(isExcluded('package.json', allow)).toBe(false);
    // Ancestor rule, both directions.
    expect(isExcluded('src/index.ts', allow)).toBe(false);
    expect(isExcluded('docs/a/b.md', allow)).toBe(true);

    // Last-match-wins: a later deny beats an earlier re-admit. This is what
    // makes the trailing `.env` rules effective after `!deployment`.
    expect(isExcluded('deployment/.env', of('*\n!deployment\n**/.env'))).toBe(true);
    expect(isExcluded('deployment/.env', of('*\n**/.env\n!deployment'))).toBe(false);

    // `*` must not cross a slash, or `*` alone would match every path and the
    // ancestor rule would never be exercised.
    expect(compilePattern('*')!.re.test('a/b')).toBe(false);
    expect(compilePattern('**')!.re.test('a/b')).toBe(true);
    expect(compilePattern('.env.*')!.re.test('.env.local')).toBe(true);
    expect(compilePattern('.env.*')!.re.test('.environment/x')).toBe(false);

    // A literal dot is a dot, not "any character".
    expect(compilePattern('.env')!.re.test('aenv')).toBe(false);

    // Comments and blanks contribute no patterns -- otherwise a prose line
    // mentioning `*` would silently deny everything.
    expect(of('# *\n\n!src')).toHaveLength(1);
  });

  it("matches BuildKit's own verdict on the cases that separate `**/` from `.*`", () => {
    // Every row below is an OBSERVED BuildKit verdict, not a derivation. Each
    // was produced on docker 29.4 with a scratch context, `FROM busybox`,
    // `COPY . /ctx` and `RUN find /ctx -type f`, under the `.dockerignore`
    // named in the row. This is the control the file header always claimed to
    // have and did not: the previous outside control was a ten-entry top-level
    // listing, which cannot reach any of these.
    //
    // `**/` is "zero or more directory levels" -- moby compiles it to
    // `((.*/)|([^/]*))`. It was `.*` here, which matches a BARE SUFFIX too, so
    // this evaluator called `src/a.env` excluded while BuildKit shipped it. The
    // divergence was fail-open and invisible, because the four cases the suite
    // did assert are correct under either compilation.
    const IGNORE_BROAD = '*\n!src\n!deployment\n.env\n.env.*\n**/.env\n**/.env.*';
    const IGNORE_NARROW =
      '*\n!src\n!deployment/crontab\n!deployment/entrypoint.sh\n' +
      '.env\n.env.*\n**/.env\n**/.env.*\n**/*.env';
    const IGNORE_NARROW_NO_SUFFIX_RULE =
      '*\n!src\n!deployment/crontab\n!deployment/entrypoint.sh\n' +
      '.env\n.env.*\n**/.env\n**/.env.*';

    const observed: Array<[string, string, boolean]> = [
      // ignore body, path, BuildKit excluded it?
      [IGNORE_BROAD, '.env', true],
      [IGNORE_BROAD, '.env.production', true],
      [IGNORE_BROAD, 'deployment/.env', true],
      [IGNORE_BROAD, 'README.md', true],
      // The four that shipped. These are the whole point of this test.
      [IGNORE_BROAD, 'deployment/creds.env', false],
      [IGNORE_BROAD, 'deployment/plexpi-secret.yaml', false],
      [IGNORE_BROAD, 'src/a.env', false],
      [IGNORE_BROAD, 'src/credentials.json', false],
      // Per-file re-inclusion under an excluded parent WORKS -- it is the
      // documented `!` exception, not an implementation detail, which is what
      // the old `!deployment` comment claimed in order to justify itself.
      [IGNORE_NARROW, 'deployment/crontab', false],
      [IGNORE_NARROW, 'deployment/entrypoint.sh', false],
      [IGNORE_NARROW, 'deployment/creds.env', true],
      [IGNORE_NARROW, 'deployment/plexpi-secret.yaml', true],
      [IGNORE_NARROW, 'src/a.env', true],
      [IGNORE_NARROW, 'src/index.ts', false],
      // `**/*.env` isolated: drop that one line and `src/a.env` ships again.
      [IGNORE_NARROW_NO_SUFFIX_RULE, 'src/a.env', false],
    ];

    for (const [ignore, target, buildkitExcluded] of observed) {
      expect({ target, excluded: isExcluded(target, compileIgnore(ignore)) }).toEqual({
        target,
        excluded: buildkitExcluded,
      });
    }

    // Reachability, so a table of all-`true` or all-`false` rows cannot pass as
    // agreement. Both verdicts have to be represented or this proves nothing
    // about the evaluator's ability to say "no".
    expect(observed.some(([, , excluded]) => excluded)).toBe(true);
    expect(observed.some(([, , excluded]) => !excluded)).toBe(true);
  });
});
