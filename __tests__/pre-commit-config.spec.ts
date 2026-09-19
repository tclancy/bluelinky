import fs from 'fs';
import path from 'path';

/**
 * Guards the pre-push gate's declaration -- the half that survives a fresh clone.
 *
 * Two independent pre-commit settings decide whether anything runs on push, and
 * both default in a direction that produces a repo which greps as gated and
 * enforces nothing:
 *
 *   default_install_hook_types  defaults to [pre-commit]  -> no .git/hooks/pre-push
 *   default_stages              defaults to every stage   -> but a narrowing
 *                                                            edit removes the
 *                                                            push battery
 *
 * This repo sat in the first state from 2026-05-15 until #12. These tests pin
 * both knobs, because pinning only the first leaves the same bug one line away.
 *
 * A grep for the string would pass on `default_install_hook_types: []`, so these
 * assert the parsed SET, in both directions.
 */

const CONFIG_PATH = path.join(__dirname, '..', '.pre-commit-config.yaml');

/** The stage this repo's battery must keep running at. */
const PUSH_STAGE = 'pre-push';

/**
 * Read a YAML list, given the line that declares it. Supports single-line flow
 * style (`key: [a, b]`) and indented block style (`key:` then `  - a`).
 *
 * NOT supported, and each raises or reads empty rather than guessing: a flow
 * list spanning several lines, a block sequence at column 0, a blank line
 * between key and first item, an anchor, or a comment on the key line. Those
 * all fail these tests in the safe direction -- if you hit one, it is the
 * reader that is wrong, not the gate.
 *
 * Hand-rolled rather than using js-yaml: js-yaml is in node_modules only as an
 * undeclared transitive dependency of eslint, so an eslint bump could remove it
 * and break this test for an entirely unrelated reason.
 */
function readListAt(lines: string[], index: number, key: string): string[] {
  const inline = lines[index].slice(lines[index].indexOf(`${key}:`) + key.length + 1).trim();

  if (inline.startsWith('[')) {
    const body = inline.slice(1, inline.indexOf(']')).trim();
    if (body === '') return [];
    return body.split(',').map(item => item.trim().replace(/^['"]/, '').replace(/['"]$/, ''));
  }
  if (inline !== '') {
    throw new Error(`${key} is a scalar, not a list: ${inline}`);
  }

  const items: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const match = line.match(/^\s+-\s*([^#]+?)\s*$/);
    if (!match) break;
    items.push(match[1].replace(/^['"]/, '').replace(/['"]$/, ''));
  }
  return items;
}

/** Read a top-level list key. Returns null when the key is absent -- which is a
 * different thing from an empty list, and the tests below depend on the
 * difference. */
function readTopLevelList(yaml: string, key: string): string[] | null {
  const lines = yaml.split('\n');
  const index = lines.findIndex(line => line.startsWith(`${key}:`));
  if (index === -1) return null;
  return readListAt(lines, index, key);
}

/** Every per-hook `stages:` declaration in the file, in document order. */
function readHookStages(yaml: string): string[][] {
  const lines = yaml.split('\n');
  return lines
    .map((line, index) => (/^\s+stages:/.test(line) ? readListAt(lines, index, 'stages') : null))
    .filter((stages): stages is string[] => stages !== null);
}

describe('.pre-commit-config.yaml', () => {
  let yaml: string;

  beforeAll(() => {
    // Reachability control. Every assertion below is about the contents of this
    // file; if it is renamed or moved they must fail loudly here rather than
    // pass vacuously against an empty string.
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    yaml = fs.readFileSync(CONFIG_PATH, 'utf8');
    expect(yaml.trim().length).toBeGreaterThan(0);
  });

  it('declares both hook types, so a fresh clone arms the pre-push path', () => {
    // PyYAML takes the LAST of a duplicated key; findIndex takes the first. Rule
    // the disagreement out rather than resolving it.
    expect(yaml.match(/^default_install_hook_types:/gm)).toHaveLength(1);

    const declared = readTopLevelList(yaml, 'default_install_hook_types');

    expect(declared).not.toBeNull();
    // Set equality, not `toContain`: dropping `pre-push` must fail, and so must
    // silently widening this to a hook type nobody reviewed.
    expect(new Set(declared)).toEqual(new Set(['pre-commit', PUSH_STAGE]));
  });

  it('keeps every declared hook running at the push stage', () => {
    // Arming the push path is worthless if the hooks have been narrowed off it.
    // `default_stages` absent is correct -- pre-commit's own default is every
    // stage. Present is allowed, but only if it still includes pre-push.
    const defaultStages = readTopLevelList(yaml, 'default_stages');
    if (defaultStages !== null) {
      expect(defaultStages).toContain(PUSH_STAGE);
    }

    // Assert the allowed set per hook rather than banning the `stages:` keyword:
    // a hook MAY declare stages, it may not declare itself out of the push
    // battery. `[]` is caught too -- toContain fails on an empty array.
    for (const stages of readHookStages(yaml)) {
      expect(stages).toContain(PUSH_STAGE);
    }
  });

  it('still declares hooks for the push stage to run', () => {
    // Arming an empty battery is the same non-gate by a different route.
    expect(yaml).toMatch(/^repos:/m);
    expect(yaml).toMatch(/^\s+hooks:/m);
    expect(yaml.match(/^\s+- id: /gm)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
});
