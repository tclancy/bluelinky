import fs from 'fs';
import path from 'path';

/**
 * Guards the `kind` discriminant at every `sendAlert` call site in the two
 * root-level monitor scripts.
 *
 * #19: `monitor-fuel.ts` sent three fuel alerts with no `kind`, so
 * `alert-backends.ts` took its TPMS arm and died in `formatWheels(undefined)`.
 * Every gate this repo had was structurally blind to it -- `npm run lint` only
 * reaches `src/`, ts-jest runs `isolatedModules: true` and typechecks nothing,
 * rollup's entry never imports these files, and `tsconfig.json` is
 * `include: ["src"]`.
 *
 * These scripts also cannot be imported by a test: both call `process.exit()`
 * at module scope and invoke their own entry point at the bottom. So the
 * invariant is asserted against the source text, which is the only surface a
 * test can reach. A `tsc` project covering these files is the stronger gate and
 * is PR #20's `tsconfig.typecheck.json`; this holds the invariant on `main`
 * until that lands, and keeps holding it for a JS caller afterwards.
 *
 * Two traps are guarded explicitly, because the first one alone is not enough
 * and the review of this file proved it.
 *
 * 1. Vacuous pass -- the same trap `pre-commit-config.spec.ts` documents.
 *    "Every call site carries a kind" is trivially true of *zero* call sites,
 *    so a reformat that defeated the parser would read as a pass. Hence
 *    `MIN_CALL_SITES`.
 * 2. A floor is not a count. `MIN_CALL_SITES` alone passes a *new* call site
 *    the parser cannot see -- `sendAlert(msg)` with the literal hoisted into a
 *    const is an ordinary refactor, and it re-opens #19 with nothing red. So
 *    every `sendAlert(` in the file must also be accounted for by a literal the
 *    parser read. That equality is what actually holds the invariant.
 *
 * Deliberately strict, so a red here may be the guard rather than your code:
 * the discriminant must be spelled as a *literal* `kind: 'fuel'` or
 * `kind: 'tpms'`. Shorthand (`kind,`) and a computed value (`kind: someVar`)
 * both fail, as does a commented-out `sendAlert({ ... })`, which is counted as
 * a live call site. Prettier's `singleQuote` normalises the quoting for us.
 */

const REPO_ROOT = path.join(__dirname, '..');

/** Call-site counts measured on `main` at the time of #19. A file may grow, never shrink below these. */
const MIN_CALL_SITES: Record<string, number> = {
  'monitor.ts': 5,
  'monitor-fuel.ts': 3,
};

/**
 * Extract the object literal of every `sendAlert({ … })` call in `source`.
 *
 * Brace-counted rather than regex-matched so a nested object or a template
 * literal in an argument cannot truncate a call site early and hide a missing
 * `kind` behind a short match.
 */
function sendAlertArguments(source: string): string[] {
  const found: string[] = [];
  const marker = 'sendAlert({';
  let cursor = source.indexOf(marker);

  while (cursor !== -1) {
    let depth = 0;
    let index = cursor + marker.length - 1; // sit on the opening brace
    for (; index < source.length; index++) {
      if (source[index] === '{') depth++;
      else if (source[index] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    found.push(source.slice(cursor + marker.length - 1, index + 1));
    cursor = source.indexOf(marker, index);
  }

  return found;
}

describe('sendAlertArguments can fail', () => {
  it('finds a call site and returns its whole literal, nested braces included', () => {
    const literals = sendAlertArguments(
      "await b.sendAlert({ kind: 'tpms', meta: { a: 1 }, name: 'x' });"
    );
    expect(literals).toHaveLength(1);
    expect(literals[0]).toContain('meta: { a: 1 }');
    expect(literals[0]).toContain("name: 'x'");
  });

  it('returns nothing when there is no call site, so a zero count is distinguishable', () => {
    expect(sendAlertArguments('const x = 1;')).toHaveLength(0);
  });

  it('reports a kind-less literal as kind-less -- the #19 shape', () => {
    const literals = sendAlertArguments("await b.sendAlert({ severity: 'low', range: 45 });");
    expect(literals).toHaveLength(1);
    expect(literals[0]).not.toContain('kind:');
  });
});

describe.each(Object.keys(MIN_CALL_SITES))('%s', filename => {
  const source = fs.readFileSync(path.join(REPO_ROOT, filename), 'utf-8');
  const literals = sendAlertArguments(source);

  it('still has at least as many sendAlert call sites as when #19 was fixed', () => {
    // Non-degeneracy control: without this, the kind assertion below passes
    // vacuously on a file the parser failed to read at all.
    expect(literals.length).toBeGreaterThanOrEqual(MIN_CALL_SITES[filename]);
  });

  it('accounts for every sendAlert call, not only those spelled sendAlert({', () => {
    // Completeness control. The floor above cannot see a NEW call site the
    // parser misses, and `sendAlert(msg)` with the literal hoisted into a const
    // is an ordinary refactor that re-opens #19. Requiring one parsed literal
    // per `sendAlert(` is what turns "nothing I read is kind-less" into "no
    // call site is kind-less". It also catches an unbalanced brace inside a
    // string, which makes one literal swallow the next.
    const calls = source.match(/sendAlert\(/g) ?? [];
    expect(literals.length).toBe(calls.length);
  });

  it("spells a literal kind: 'fuel' or 'tpms' at every sendAlert call site", () => {
    const kindless = literals.filter(literal => !/\bkind:\s*'(fuel|tpms)'/.test(literal));
    expect(kindless).toEqual([]);
  });
});
