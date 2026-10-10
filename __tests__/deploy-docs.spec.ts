import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Guards the deploy surface against the drift that issue #18 found: the docs
 * and the box had disagreed about where the checkout lives and which compose
 * file runs, and nothing could tell.
 *
 * The expensive half of that drift was not the wrong path in prose. It was the
 * compose file's LOCATION, because Docker Compose derives the project name
 * from the directory containing the compose file -- not from the working
 * directory you invoke it from. Measured on compose v5.1.2 (local) against a
 * scratch checkout named `bluelinky`:
 *
 *   <checkout>/docker-compose.yml              -> project `bluelinky`
 *                                              -> volume  `bluelinky_fuel-state`
 *   <checkout>/deployment/docker-compose.yml   -> project `deployment`
 *   (even invoked as `docker compose -f deployment/... ` from the root)
 *                                              -> volume  `deployment_fuel-state`
 *
 * `bluelinky_fuel-state` is the volume the running container is mounted from;
 * it holds the alert state and the SQLite history. A `deployment/`-relative
 * deploy therefore does not merely look different -- it reaches for a
 * different, empty volume. Measured against a container already up under
 * project `bluelinky`, `docker compose up -d` from `deployment/` creates
 * `deployment_fuel-state` and then FAILS on the `container_name` conflict,
 * leaving the old container running; remove the container first and the same
 * command starts over on the empty volume. So the loud case is an orphan
 * volume plus a conflict, and the silent case is a reset history.
 *
 * Both volumes exist on plexpi today, `deployment_fuel-state` empty -- which is
 * the first of those two outcomes, fossilised. Its origin is a guess (some
 * earlier run from inside `deployment/`); the fact is measured, the mechanism
 * is not.
 *
 * These tests therefore pin the location, the root-relativity of its paths, and
 * the deploy commands in the docs that a human copies.
 */

const REPO_ROOT = path.join(__dirname, '..');

/** Where the compose file that the box runs must live, relative to the root. */
const COMPOSE_PATH = 'docker-compose.yml';

/** Where it used to live. Keeping a copy here re-opens the project-name split. */
const RETIRED_COMPOSE_PATH = 'deployment/docker-compose.yml';

/**
 * Every filename Compose will pick up as a project file.
 *
 * `compose.yaml` and `compose.yml` are searched FIRST, ahead of
 * `docker-compose.yml`, so a narrower pattern here is not a style nit: a
 * tracked root `compose.yaml` would be the file that actually runs while every
 * assertion below kept reading `docker-compose.yml`. That defeated the
 * location, the `../`, the `context:` and the `TZ` assertions simultaneously
 * in review.
 */
const COMPOSE_FILENAME = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/;

/** The tracked crontab the image installs; the scheduled entrypoint of record. */
const CRONTAB_PATH = 'deployment/crontab';

/** Every doc whose shell blocks a human copies when deploying. */
const DEPLOY_DOCS = ['README.md', 'deployment/README.md'];

/** The repo's default branch, so `git pull origin <x>` in the docs resolves. */
const DEFAULT_BRANCH = 'main';

/**
 * This spec, excluded from the `fuelbot` scan below.
 *
 * It carries every banned spelling as a positive-control sample, so scanning it
 * makes the guard fail on its own definition the moment the file is tracked.
 * That is not hypothetical -- the mutation round that graded these assertions
 * caught it, because every single mutant (including the comment-only control)
 * killed the scan for this reason and nothing else.
 *
 * The exclusion is one named path, not a pattern, and `beforeAll` asserts the
 * path is really tracked: rename the file without updating this constant and
 * the suite fails loudly rather than quietly scanning nothing.
 */
const SELF = '__tests__/deploy-docs.spec.ts';

/**
 * The files allowed to name a retired path at all, and then only in prose: the
 * ones that exist to record that it was wrong.
 *
 * An earlier draft tried to allow any mention whose line also read "not" or
 * "until". That heuristic is about English, not about the repo, and it failed
 * on this PR's own changelog entry ("...(no such directory...)"). The rule is
 * structural instead: prose in the narrative files may name it, and no runnable
 * command anywhere may.
 */
const NARRATIVE_FILES = ['README.md', 'CHANGELOG.md', 'WHATS_FUEL.md'];

/**
 * Spellings of `fuelbot` that are a FILESYSTEM PATH rather than a topic name.
 *
 * Banning the bare word would be wrong, not merely over-broad: `fuelbot` is
 * also the ntfy topic in `.env.example` and `alert-backends.ts`, and the AWS SNS
 * topic in `WHATS_FUEL.md`. Those are live names and must survive. Each entry
 * below is a distinct spelling rather than one clever alternation, so a
 * positive control can drive them individually (see the control test).
 */
const PATH_SPELLINGS: Array<[string, RegExp]> = [
  // The `:` in the prefix class is for `scp host:~/fuelbot`.
  ['home-relative', /(?:^|[\s`'"(=:])~\/fuelbot\b/i],
  ['absolute', /\/home\/[A-Za-z0-9_.-]+\/fuelbot\b/i],
  ['clone-target', /\bgit\s+clone\s+\S+\s+fuelbot\b/i],
  ['cd-target', /\bcd\s+fuelbot\b/i],
];

/** Compose subcommands these docs actually tell a human to run. */
const COMPOSE_SUBCOMMANDS = [
  'up',
  'down',
  'stop',
  'start',
  'restart',
  'build',
  'logs',
  'ps',
  'config',
];
const SUBCOMMAND = `(?:${COMPOSE_SUBCOMMANDS.join('|')})`;

/** A compose invocation, either spelling, as a command rather than as a noun. */
const COMPOSE_INVOCATION = new RegExp(
  String.raw`\bdocker[ -]compose\b[^|]*?\s${SUBCOMMAND}\b`,
  'i'
);

/**
 * The v1 binary, as a COMMAND rather than as the word. plexpi has the plugin
 * (v5.1.3) and no `docker-compose` on PATH at all, so an invocation is a
 * `command not found` there -- but prose naming it ("a docker-compose setup",
 * "never `docker-compose`") has to stay legal, or this guard would demand the
 * deletion of its own warning.
 */
const HYPHENATED_INVOCATION = new RegExp(
  String.raw`\bdocker-compose\s+(?:-\S+\s+)*${SUBCOMMAND}\b`,
  'i'
);

/**
 * Ways a shell block can end up in a compose project other than `bluelinky`.
 *
 * Separate spellings rather than one `\bdeployment\b` ban, so each gets its own
 * control and a future `cat deployment/crontab` stays legal.
 *
 * The last two ban `-p` / `--project-name` / `--project-directory` outright
 * rather than banning the value `deployment`, because ANY of those overrides
 * the directory-derived project name and the correct deploy uses none of them.
 * Review proved the value-scoped version let `-p deployment`,
 * `--project-directory deployment` and `pushd deployment` through.
 */
const WRONG_PROJECT_DIR: Array<[string, RegExp]> = [
  ['cd-into-deployment', /\bcd\s+\S*deployment\b/i],
  ['pushd-into-deployment', /\bpushd\s+\S*deployment\b/i],
  ['dash-f-deployment', /-f\s+\S*deployment\//i],
  ['deployment-compose-path', /\bdeployment\/(docker-)?compose(\.[\w-]+)?\.ya?ml\b/i],
  [
    'project-name-override',
    new RegExp(String.raw`\bdocker[ -]compose\b[^\n]*?\s(?:-p|--project-name)[\s=]`, 'i'),
  ],
  [
    'project-directory-override',
    new RegExp(String.raw`\bdocker[ -]compose\b[^\n]*?\s--project-directory[\s=]`, 'i'),
  ],
];

/**
 * `git` commands pinned to the pre-rename default branch. Two halves, each
 * driven by its own control below -- neutering either one silently disarmed the
 * whole check in review.
 */
const GIT_COMMAND = /\bgit\s+(?:pull|reset|fetch|checkout)\b/;
const RETIRED_BRANCH = /\bmaster\b/;

type Hit = { file: string; line: number; text: string; spelling: string };

/** Tracked text files, by path relative to the repo root. */
function trackedTextFiles(): string[] {
  const raw = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return raw
    .split('\0')
    .filter(file => file !== '')
    .filter(file => !/\.(png|jpg|jpeg|gif|ico|db|sqlite3?|woff2?)$/i.test(file))
    .filter(file => file !== 'package-lock.json');
}

/** Read a tracked file, relative to the repo root. */
function read(file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/**
 * Lines inside fenced code blocks -- the ones a human copies and runs.
 *
 * The compose scans below must NOT read prose, because the prose is where this
 * PR explains which layouts are wrong, and naming a wrong layout in order to
 * warn about it is the point. Scoping to fenced blocks is what lets the rule
 * be strict about commands and silent about explanations.
 *
 * Known blind spot, the price of that: a command written as INLINE code in a
 * sentence ("deploy with `cd deployment && docker-compose up -d`") is prose to
 * this reader and passes. Widening to inline spans would fail on this repo's
 * own warnings, which quote the wrong commands verbatim. The narrower rule is
 * the one that can be true.
 */
function fencedLines(body: string): Array<{ line: number; text: string }> {
  return fencedBlocks(body).flatMap(block => block);
}

/**
 * The same fenced lines, grouped per block.
 *
 * The compose-location rule has to be read per BLOCK, not per line: the shape
 * this guard exists to catch put `cd deployment` on its own line above the
 * compose command, so a per-line scan of the invocation sees nothing wrong. The
 * mutation round proved that -- that mutant SURVIVED a per-line version.
 */
function fencedBlocks(body: string): Array<Array<{ line: number; text: string }>> {
  const blocks: Array<Array<{ line: number; text: string }>> = [];
  let current: Array<{ line: number; text: string }> | null = null;
  body.split('\n').forEach((raw, index) => {
    if (/^\s*```/.test(raw)) {
      if (current === null) {
        current = [];
      } else {
        blocks.push(current);
        current = null;
      }
      return;
    }
    if (current !== null) current.push({ line: index + 1, text: raw.trim() });
  });
  if (current !== null) blocks.push(current);
  return blocks;
}

/** Every path-shaped `fuelbot` occurrence across the given files. */
function pathShapedHits(files: string[], fencedOnly = false): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const absolute = path.join(REPO_ROOT, file);
    if (!fs.existsSync(absolute)) continue;
    const body = fs.readFileSync(absolute, 'utf8');
    // Non-markdown files are runnable or config in their entirety; markdown is
    // only runnable inside a fence.
    const everyLine = () => body.split('\n').map((text, index) => ({ line: index + 1, text }));
    const candidates = fencedOnly && file.endsWith('.md') ? fencedLines(body) : everyLine();
    for (const { line, text } of candidates) {
      for (const [spelling, pattern] of PATH_SPELLINGS) {
        if (pattern.test(text)) {
          hits.push({ file, line, text: text.trim(), spelling });
        }
      }
    }
  }
  return hits;
}

/** Lines that look like a crontab schedule entry, from anywhere in a file. */
function cronScheduleLines(body: string): string[] {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[\d*][^#]*\s\*\s+\*\s+\*\s/.test(line));
}

/** The `npx tsx <script>` targets named on the given crontab-shaped lines. */
function cronScriptTargets(lines: string[]): Set<string> {
  const targets = new Set<string>();
  for (const line of lines) {
    const match = line.match(/npx\s+tsx\s+(\S+\.ts)/);
    if (match) targets.add(match[1]);
  }
  return targets;
}

describe('deploy surface (issue #18)', () => {
  let tracked: string[];

  beforeAll(() => {
    tracked = trackedTextFiles();

    // Reachability control. Every absence assertion below is over this list; if
    // `git ls-files` returned nothing useful they would all pass vacuously.
    expect(tracked.length).toBeGreaterThan(20);
    expect(tracked).toContain(COMPOSE_PATH);
    expect(tracked).toContain(CRONTAB_PATH);
    for (const doc of DEPLOY_DOCS) {
      expect(tracked).toContain(doc);
    }

    // The scan excludes exactly this file by name; if it has been renamed, the
    // exclusion no longer matches anything and the scan would trip over its own
    // control samples. Fail here, where the message says what to fix.
    expect(tracked).toContain(SELF);
  });

  it('keeps the tracked compose file at the checkout root', () => {
    // The whole point: project name, and therefore the state volume, follows
    // this file's directory. See the header comment for the measurement.
    expect(fs.existsSync(path.join(REPO_ROOT, COMPOSE_PATH))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, RETIRED_COMPOSE_PATH))).toBe(false);

    // And exactly one compose file anywhere TRACKED, under any of the names
    // Compose itself will pick up. Asserts the whole set, not the absence of
    // one path. Known and deliberate limit: an UNTRACKED stray compose file is
    // invisible here, because `git ls-files` is the right denominator -- the
    // alternative fails this suite on anyone's local scratch file. An untracked
    // compose file is exactly what #18 found on the box, and nothing in a repo
    // can see that; the switchover step in the PR is what removes it.
    expect(tracked.filter(file => COMPOSE_FILENAME.test(file))).toEqual([COMPOSE_PATH]);

    // Control: the filename pattern must match every name Compose searches, or
    // the set assertion above is narrower than it reads.
    for (const name of [
      'docker-compose.yml',
      'docker-compose.yaml',
      'compose.yml',
      'compose.yaml',
      'deployment/docker-compose.yml',
      'deployment/compose.yaml',
      'docker-compose.override.yml',
    ]) {
      expect(COMPOSE_FILENAME.test(name)).toBe(true);
    }
    for (const name of ['deployment/README.md', 'src/compose.ts', 'composer.yaml']) {
      expect(COMPOSE_FILENAME.test(name)).toBe(false);
    }
  });

  it('keeps the root compose file root-relative, so it runs where it sits', () => {
    const compose = read(COMPOSE_PATH);

    // A `..` here means the file is being read from somewhere other than the
    // directory it lives in -- the deployment/ layout by another name.
    expect(compose).not.toMatch(/\.\.\//);

    expect(compose).toMatch(/^\s*context:\s*\.\s*$/m);
    expect(compose).toMatch(/^\s*-\s*\.\/\.env:\/app\/\.env:ro\s*$/m);

    // UTC everywhere is the house rule, and #18 asked for it explicitly. Every
    // timestamp the MONITOR emits goes through toISOString(), the cron
    // expression fires at the same instants under either zone, and the US code
    // path hardcodes its API `offset` header rather than reading the container
    // TZ -- so this is a no-op for the monitor's output and strictly better
    // across a DST transition, where `0 * * * *` under a US zone runs 23 or 25
    // times. (It is NOT a no-op for `src/logger.ts`, whose winston format
    // renders in local time; under LOG_LEVEL=debug that moves cron.log's
    // bracketed stamps to UTC, which is the direction we want.)
    //
    // Assert the whole SET of values, not membership: a second
    // `- TZ=America/New_York` appended below a correct line is the one compose
    // honours, and it passed a `toMatch` check.
    const zones = [...compose.matchAll(/^[ \t]*-[ \t]*TZ=(\S+)[ \t]*$/gm)].map(match => match[1]);
    expect(zones).toEqual(['UTC']);
  });

  it('runs no command that names a ~/fuelbot path', () => {
    const scanned = tracked.filter(file => file !== SELF);
    expect(scanned).toHaveLength(tracked.length - 1);

    // Rule A, the one that bites: nothing a human or a machine EXECUTES may
    // name the retired checkout -- no fenced shell block, and no non-markdown
    // file at all.
    expect(pathShapedHits(scanned, true)).toEqual([]);
  });

  it('names a ~/fuelbot path only in the files that record it was wrong', () => {
    const scanned = tracked.filter(file => file !== SELF);

    // Rule B: prose may say "it is not /home/pi/fuelbot" in the narrative
    // files, because that sentence is why nobody puts it back. Everywhere else,
    // including deployment/README.md -- the file #18 is about -- zero.
    const hits = pathShapedHits(scanned).filter(hit => !NARRATIVE_FILES.includes(hit.file));
    expect(hits).toEqual([]);

    // Reachability for both rules: a narrative file really does carry the
    // correction, so the assertion above is excluding something real rather
    // than passing over a scan that finds nothing anywhere. Deliberately NOT
    // one-per-file: requiring every narrative file to keep a path-shaped
    // mention forever turns an ordinary changelog rewrite red for no reason.
    const narrativeHits = pathShapedHits(NARRATIVE_FILES.filter(file => tracked.includes(file)));
    expect(narrativeHits.length).toBeGreaterThan(0);
  });

  it('detects each path spelling it bans, and spares the topic names', () => {
    // Control for the two tests above: a `toEqual([])` over a scan is
    // indistinguishable from a scan that matches nothing. Drive each spelling.
    const samples: Record<string, string> = {
      'home-relative': 'scp -r ./x user@server:~/fuelbot',
      absolute: 'scp -r ./x user@server:/home/pi/fuelbot',
      'clone-target': 'git clone git@github.com:tclancy/bluelinky.git fuelbot',
      'cd-target': 'cd fuelbot',
    };
    for (const [spelling, pattern] of PATH_SPELLINGS) {
      expect(samples[spelling]).toBeDefined();
      expect(pattern.test(samples[spelling])).toBe(true);
    }
    expect(Object.keys(samples).sort()).toEqual(PATH_SPELLINGS.map(([name]) => name).sort());

    // Negative control: the live topic names must NOT read as paths, or this
    // guard would demand deleting an ntfy URL and an SNS ARN.
    const topics = [
      'NTFY_URL=https://notifications.example.com/fuelbot    # Full topic URL',
      'arn:aws:sns:us-east-1:781158438931:FuelBot',
      ' *   NTFY_URL      - full topic URL, e.g. https://notifications.example.com/fuelbot',
    ];
    for (const topic of topics) {
      for (const [, pattern] of PATH_SPELLINGS) {
        expect(pattern.test(topic)).toBe(false);
      }
    }
  });

  it('links to no retired deployment/ compose path', () => {
    // A different failure from the ones above, needing a different scan: a
    // markdown LINK to `deployment/docker-compose.yml` is a 404 after the move,
    // not a wrong command, so no amount of fenced-block reading finds it.
    // WHATS_FUEL.md carried one, and it survived every other test here.
    //
    // Scoped to link syntax on purpose: three files legitimately NAME that path
    // in prose in order to explain why nothing should point at it.
    const DEAD_LINK = /\]\((?:\.\/)?deployment\/(docker-)?compose(\.[\w-]+)?\.ya?ml\)/i;
    const offenders = tracked
      .filter(file => file !== SELF)
      .flatMap(file =>
        read(file)
          .split('\n')
          .map((text, index) => ({ file, line: index + 1, text: text.trim() }))
          .filter(({ text }) => DEAD_LINK.test(text))
      );
    expect(offenders).toEqual([]);

    // Control: the pattern fires on the link WHATS_FUEL.md actually had, and on
    // the names compose also accepts; it spares the prose that names the path.
    expect(
      DEAD_LINK.test('- [deployment/docker-compose.yml](deployment/docker-compose.yml) - Easy')
    ).toBe(true);
    expect(DEAD_LINK.test('See [the old file](./deployment/compose.yaml) for history')).toBe(true);
    expect(DEAD_LINK.test('`deployment/docker-compose.yml` gets you project `deployment`')).toBe(
      false
    );
    // And it fires on nothing once the link points at the root file.
    expect(DEAD_LINK.test('- [docker-compose.yml](docker-compose.yml) - Easy')).toBe(false);
  });

  it('runs every documented compose command from the checkout root', () => {
    for (const doc of DEPLOY_DOCS) {
      const composeBlocks = fencedBlocks(read(doc)).filter(block =>
        block.some(({ text }) => COMPOSE_INVOCATION.test(text))
      );

      // Reachability: the filter below only means something if these docs
      // really do carry runnable compose commands.
      expect(composeBlocks.length).toBeGreaterThan(0);

      // Read per block, not per line: `cd deployment` sits on its own line
      // above the compose command, and that is the historical shape.
      const offenders = composeBlocks.flatMap(block =>
        block
          .filter(({ text }) => WRONG_PROJECT_DIR.some(([, pattern]) => pattern.test(text)))
          .map(({ line, text }) => ({ line, text }))
      );
      expect({ doc, offenders }).toEqual({ doc, offenders: [] });
    }

    // Control: each spelling must fire on the shape it names. Each of these
    // resolves to a project other than `bluelinky`; the last three survived a
    // value-scoped version of this list.
    const samples: Record<string, string> = {
      'cd-into-deployment': 'cd ~/bluelinky/deployment',
      'pushd-into-deployment': 'pushd deployment && docker compose up -d --build',
      'dash-f-deployment': 'docker compose -f deployment/docker-compose.yml up -d',
      'deployment-compose-path': 'cp deployment/compose.yaml .',
      'project-name-override': 'docker compose -p deployment up -d --build',
      'project-directory-override': 'docker compose --project-directory deployment up -d',
    };
    for (const [spelling, pattern] of WRONG_PROJECT_DIR) {
      expect(samples[spelling]).toBeDefined();
      expect(pattern.test(samples[spelling])).toBe(true);
    }
    expect(Object.keys(samples).sort()).toEqual(WRONG_PROJECT_DIR.map(([name]) => name).sort());
    // And none of them fires on the deploy command the docs are supposed to use.
    for (const [, pattern] of WRONG_PROJECT_DIR) {
      expect(pattern.test('cd ~/bluelinky && docker compose up -d --build')).toBe(false);
    }
  });

  it('invokes only the compose spelling the box has', () => {
    for (const doc of DEPLOY_DOCS) {
      const offenders = fencedLines(read(doc)).filter(({ text }) =>
        HYPHENATED_INVOCATION.test(text)
      );
      expect({ doc, offenders }).toEqual({ doc, offenders: [] });
    }

    // Control: the pattern must catch a real invocation and spare the prose
    // that names the binary in order to warn about it.
    expect(HYPHENATED_INVOCATION.test('docker-compose up -d')).toBe(true);
    expect(HYPHENATED_INVOCATION.test('cd deployment && docker-compose down -v')).toBe(true);
    expect(HYPHENATED_INVOCATION.test('`docker compose`, never `docker-compose`.')).toBe(false);
    expect(
      HYPHENATED_INVOCATION.test('A Dockerfile and docker-compose setup run the monitor')
    ).toBe(false);

    // Same control for the plugin spelling, which the test above depends on.
    expect(COMPOSE_INVOCATION.test('cd ~/bluelinky && docker compose up -d --build')).toBe(true);
    expect(COMPOSE_INVOCATION.test('The `docker compose` plugin (v2 or newer)')).toBe(false);
  });

  it('pulls a branch that exists', () => {
    // `git pull origin master` / `reset --hard origin/master` predate the
    // rename and fail outright on the box.
    for (const doc of DEPLOY_DOCS) {
      const offenders = fencedLines(read(doc))
        .filter(({ text }) => GIT_COMMAND.test(text))
        .filter(({ text }) => RETIRED_BRANCH.test(text));
      expect({ doc, offenders }).toEqual({ doc, offenders: [] });
    }

    // Control, one per half: neutering EITHER regex left this green in review,
    // and `toContain('origin/main')` proves presence, never that a scan fires.
    for (const sample of ['git pull origin master', 'git reset --hard origin/master']) {
      expect(GIT_COMMAND.test(sample)).toBe(true);
      expect(RETIRED_BRANCH.test(sample)).toBe(true);
    }
    expect(GIT_COMMAND.test('npm run master-build')).toBe(false);
    expect(RETIRED_BRANCH.test('git pull --ff-only')).toBe(false);

    expect(read('deployment/README.md')).toContain(`origin/${DEFAULT_BRANCH}`);
  });

  it('documents the schedule against the script the tracked crontab runs', () => {
    const trackedTargets = cronScriptTargets(cronScheduleLines(read(CRONTAB_PATH)));
    const documented = cronScriptTargets(cronScheduleLines(read('deployment/README.md')));

    // Reachability on both sides -- an empty set is a subset of anything.
    expect(trackedTargets.size).toBeGreaterThan(0);
    expect(documented.size).toBeGreaterThan(0);

    // Every documented example must name a script the crontab really schedules.
    // Subset rather than equality on purpose: equality would also forbid adding
    // a second scheduled job to deployment/crontab, which is not this guard's
    // business. Drift to an unscheduled script is still caught, because that
    // script is not in trackedTargets.
    expect([...documented].filter(target => !trackedTargets.has(target))).toEqual([]);
  });
});
