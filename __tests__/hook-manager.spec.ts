import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Pins issue #11's answer: **pre-commit owns this repo's git hooks, husky is
 * retired.** Tom's call, 2026-10-10 -- "Drop husky, use pre-commit".
 *
 * Why this needs a test rather than a sentence in a doc. Between 2026-02-09 and
 * 2026-10-10 this repo carried 19 husky files in `.git/hooks` -- 17 hook shims,
 * two of them renamed `.legacy`, plus husky's own `husky.sh` and
 * `husky.local.sh` -- and **no husky configuration anywhere**, so a push ran a
 * hook that resolved to nothing and exited 0. It was not a gate; it was a file
 * shaped like one. The fleet gate audit did report it (`INERT`, naming the
 * foreign hook); what the shape blocked was the automated *remediation*, which
 * deliberately refuses to overwrite a pre-push hook it did not generate. The
 * dead shim also survived arming pre-commit -- `pre-commit install` runs in
 * migration mode and chains to a foreign hook as `<hook>.legacy` rather than
 * replacing it.
 *
 * `.pre-commit-config.yaml` is guarded separately by `pre-commit-config.spec.ts`,
 * which pins the declaration. This file pins the other half: that nothing else
 * is competing to manage the same hooks.
 *
 * The two halves of what is asserted here are enforced very differently, and the
 * comments say which is which:
 *
 *   package.json      -- tracked, so CI enforces it. This is where husky would
 *   package-lock.json    actually come back: one `npm i -D husky`. The lockfile
 *                        is asserted too because its copy of the root manifest
 *                        was still declaring `devDependencies.husky: ^4.2.5`
 *                        after husky left `package.json`, so a reader grepping
 *                        the repo found a live declaration.
 *   .git/hooks        -- untracked local state, and the canary over it is
 *                        **vacuous in CI by construction**: a checkout there has
 *                        no live hook files at all, so the scan opens zero files
 *                        and passes. Its value is on a developer machine, where
 *                        the 19 files above sat for eight months. Do not read it
 *                        as a gate, and do not read the directory-resolution
 *                        test as its reachability control -- that control proves
 *                        the directory resolved, not that any file was read.
 */

const ROOT = path.join(__dirname, '..');
const PACKAGE = path.join(ROOT, 'package.json');
const LOCKFILE = path.join(ROOT, 'package-lock.json');

/**
 * Every manifest key npm installs from.
 *
 * Asserting `dependencies` and `devDependencies` alone would leave husky one
 * `--save-optional` away from being back, and `optionalDependencies` installs by
 * default. `peerDependencies` does too since npm 7.
 */
const DEPENDENCY_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/** A dependency this repo certainly has, used as the reader's control. */
const CONTROL_DEPENDENCY = 'typescript';

interface Manifest {
  husky?: unknown;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

function manifest(): Manifest {
  return JSON.parse(fs.readFileSync(PACKAGE, 'utf8')) as Manifest;
}

interface Lockfile {
  packages?: Record<string, Manifest>;
  dependencies?: Record<string, unknown>;
}

function lockfile(): Lockfile {
  return JSON.parse(fs.readFileSync(LOCKFILE, 'utf8')) as Lockfile;
}

/**
 * Every package name the lockfile declares as a direct dependency of the root
 * project -- i.e. `packages[""]`, which is the lockfile's own copy of
 * `package.json`'s dependency keys, not the flat install tree.
 */
function lockDeclaredPackages(): string[] {
  const root = lockfile().packages?.[''] ?? {};
  return DEPENDENCY_KEYS.flatMap(key => Object.keys((root[key] as object | undefined) ?? {}));
}

/** Every package name declared across all four dependency keys. */
function declaredPackages(): string[] {
  const parsed = manifest();
  return DEPENDENCY_KEYS.flatMap(key => Object.keys((parsed[key] as object | undefined) ?? {}));
}

/**
 * The directory git actually runs hooks from for this checkout.
 *
 * Not `path.join(ROOT, '.git', 'hooks')`: in a linked worktree `.git` is a FILE
 * (a `gitdir:` pointer) so that path does not exist, and `core.hooksPath` can
 * move the directory somewhere else entirely. Asking git covers both -- and
 * confirms the shared-directory case, because every worktree of this repo
 * resolves to the same answer.
 *
 * Returns null when there is no git checkout to ask (a tarball, an export). The
 * test above the one that uses this asserts non-null, so a null here is a
 * reported failure rather than a silent skip.
 */
function hooksDirectory(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

describe('husky is retired; pre-commit owns the hooks', () => {
  it('reachability control: the manifest parses and the reader finds a known dependency', () => {
    // Without this, every `not.toContain` below would also pass against an
    // empty list -- a renamed key, a reader that returns [], a manifest that
    // moved. The control and the assertions share one code path on purpose.
    expect(fs.existsSync(PACKAGE)).toBe(true);
    expect(declaredPackages()).toContain(CONTROL_DEPENDENCY);
  });

  it('does not declare husky in any dependency key', () => {
    // Asserted per key as well as over the union, so a failure names the key
    // somebody added it to.
    const parsed = manifest();
    for (const key of DEPENDENCY_KEYS) {
      expect(Object.keys((parsed[key] as object | undefined) ?? {})).not.toContain('husky');
    }
    expect(declaredPackages()).not.toContain('husky');
  });

  it('carries no husky configuration surface', () => {
    // husky v4 reads a `husky` key in package.json or a `.huskyrc*` file; v9
    // reads a `.husky/` directory and is normally armed from a `prepare` script.
    // Banning only the v4 spelling would pass every v9 shape, so all three are
    // asserted.
    expect(manifest().husky).toBeUndefined();

    const rootEntries = fs.readdirSync(ROOT);
    expect(rootEntries.filter(entry => entry.startsWith('.huskyrc'))).toEqual([]);
    expect(rootEntries).not.toContain('.husky');

    // A script that *invokes* husky is the same thing as declaring it -- and it
    // is how v9 gets installed. Scan every script body, not a named few.
    const scripts = manifest().scripts ?? {};
    const invoking = Object.entries(scripts)
      .filter(([, body]) => /husky/i.test(body))
      .map(([name]) => name);
    expect(invoking).toEqual([]);
  });

  it('reachability control: the lockfile parses and declares the known dependency', () => {
    // Same shape as the manifest control, and needed for the same reason: every
    // lockfile assertion below is a `not.toContain`, which an empty reader
    // satisfies. This fails if `packages[""]` is renamed or the file moves.
    expect(fs.existsSync(LOCKFILE)).toBe(true);
    expect(lockDeclaredPackages()).toContain(CONTROL_DEPENDENCY);
  });

  it('does not declare or record husky anywhere in the lockfile', () => {
    // 1. The lockfile's copy of the root manifest. This is the one that was
    //    wrong for months: `devDependencies.husky: ^4.2.5` survived there after
    //    husky left package.json, so the repo still *declared* husky.
    expect(lockDeclaredPackages()).not.toContain('husky');

    const lock = lockfile();

    // 2. The install tree -- `node_modules/husky` and anything nested under it.
    const installed = Object.keys(lock.packages ?? {}).filter(key =>
      /(^|\/)node_modules\/husky(\/|$)/.test(key)
    );
    expect(installed).toEqual([]);

    // 3. The legacy `dependencies` mirror. lockfileVersion 2 carries both
    //    shapes, and asserting only `packages` leaves half the file unread.
    expect(Object.keys(lock.dependencies ?? {})).not.toContain('husky');

    // 4. Text backstop, because the three structured reads above each assume a
    //    schema. A package legitimately named `*husky*` would trip this; none
    //    exists, and a false red here is cheap next to a silent miss.
    expect(fs.readFileSync(LOCKFILE, 'utf8').toLowerCase()).not.toContain('husky');
  });

  it('git resolves a hooks directory for this checkout', () => {
    // Reachability control for the test below, which cannot tell "no husky
    // shims" from "never looked".
    const directory = hooksDirectory();
    expect(directory).not.toBeNull();
    expect(fs.existsSync(directory!)).toBe(true);
    expect(fs.statSync(directory!).isDirectory()).toBe(true);
    // Deliberately no assertion on the CONTENTS. The obvious one -- "a real
    // hooks directory has git's own `.sample` files" -- is false on this fleet:
    // `init.templateDir` is set, and a fresh `git init` here produces a hooks
    // directory holding exactly one file and no samples at all. Measured.
    // So this test proves only that the path resolved and is a directory, which
    // is all it can prove, and the canary below says what it therefore cannot.
  });

  it('local canary (vacuous in CI): no husky shim among the live hook files', () => {
    const directory = hooksDirectory();
    // `throw`, not `return`. A bare return is a silent pass, and under a `-t`
    // filter the control test it defers to is skipped rather than run -- so
    // "already a failure above" would be false exactly when it mattered.
    if (directory === null || !fs.existsSync(directory)) {
      throw new Error(`no hooks directory to scan: ${directory}`);
    }

    // `.sample` files are git's own and are never executed. Everything else in
    // here is live, including the `<hook>.legacy` files `pre-commit install`
    // creates when it chains to a foreign hook -- which is exactly the shape
    // that kept husky running here after pre-commit was armed.
    // `lstatSync`, not `statSync`: a dangling symlink in the hooks directory
    // makes `statSync` throw ENOENT, which takes this test down as an error
    // rather than as a readable verdict. A symlinked hook is still a hook.
    const live = fs
      .readdirSync(directory)
      .filter(entry => !entry.endsWith('.sample'))
      .filter(entry => {
        const stat = fs.lstatSync(path.join(directory, entry));
        return stat.isFile() || stat.isSymbolicLink();
      });

    const husky = live.filter(entry => {
      try {
        return /husky/i.test(fs.readFileSync(path.join(directory, entry), 'utf8'));
      } catch {
        return false; // broken symlink: not a husky shim, and not this test's problem
      }
    });

    // Named rather than counted, so the failure message tells a developer which
    // files to delete. Remedy: `rm` them -- they are untracked local state and
    // nothing in this repo recreates them.
    expect(husky).toEqual([]);
  });
});
