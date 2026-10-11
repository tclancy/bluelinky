import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Pins issue #11's answer: **pre-commit owns this repo's git hooks, husky is
 * retired.** Tom's call, 2026-10-10 -- "Drop husky, use pre-commit".
 *
 * Why this needs a test rather than a sentence in a doc. Between 2026-02-09 and
 * 2026-10-10 this repo had 19 husky v4 shims in `.git/hooks` and **no husky
 * configuration anywhere**, so every push ran a hook that resolved to nothing
 * and exited 0. It was not a gate; it was a file shaped like one, and that shape
 * is what made the fleet gate audit skip this repo instead of reporting it
 * unarmed. The dead shim also survived arming pre-commit -- `pre-commit install`
 * runs in migration mode and chains to a foreign hook as `<hook>.legacy` rather
 * than replacing it.
 *
 * `.pre-commit-config.yaml` is guarded separately by `pre-commit-config.spec.ts`,
 * which pins the declaration. This file pins the other half: that nothing else
 * is competing to manage the same hooks.
 *
 * The two halves of what is asserted here are enforced very differently, and the
 * comments say which is which:
 *
 *   package.json  -- tracked, so CI enforces it. This is where husky would
 *                    actually come back: one `npm i -D husky`.
 *   .git/hooks    -- untracked local state. A fresh clone and CI both have only
 *                    `.sample` files there, so that assertion is a canary for a
 *                    developer machine, not a CI gate. It is still worth having:
 *                    the 19 shims above lived there for eight months.
 */

const ROOT = path.join(__dirname, '..');
const PACKAGE = path.join(ROOT, 'package.json');

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

  it('git resolves a hooks directory for this checkout', () => {
    // Reachability control for the test below, which cannot tell "no husky
    // shims" from "never looked".
    const directory = hooksDirectory();
    expect(directory).not.toBeNull();
    expect(fs.existsSync(directory!)).toBe(true);
    // A real hooks directory always has git's own `.sample` files in it. An
    // empty one means we resolved somewhere unexpected.
    expect(fs.readdirSync(directory!).length).toBeGreaterThan(0);
  });

  it('local canary: no husky shim in the directory git runs hooks from', () => {
    const directory = hooksDirectory();
    if (directory === null || !fs.existsSync(directory)) {
      return; // Already a failure in the control above; do not double-report.
    }

    // `.sample` files are git's own and are never executed. Everything else in
    // here is live, including the `<hook>.legacy` files `pre-commit install`
    // creates when it chains to a foreign hook -- which is exactly the shape
    // that kept husky running here after pre-commit was armed.
    const live = fs
      .readdirSync(directory)
      .filter(entry => !entry.endsWith('.sample'))
      .filter(entry => fs.statSync(path.join(directory, entry)).isFile());

    const husky = live.filter(entry =>
      /husky/i.test(fs.readFileSync(path.join(directory, entry), 'utf8'))
    );

    // Named rather than counted, so the failure message tells a developer which
    // files to delete. Remedy: `rm` them -- they are untracked local state and
    // nothing in this repo recreates them.
    expect(husky).toEqual([]);
  });
});
