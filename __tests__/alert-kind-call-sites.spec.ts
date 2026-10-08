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
 * The vacuous-pass trap is the thing to watch here, and it is the same one
 * `pre-commit-config.spec.ts` documents: "every call site carries a kind" is
 * trivially true of *zero* call sites, so a reformat that defeated the parser
 * would read as a pass. Hence the explicit non-degeneracy assertions below --
 * each file must yield at least as many call sites as it had when this was
 * written, and the parser is proven able to fail on a synthetic negative.
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
export function sendAlertArguments(source: string): string[] {
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
    cursor = source.indexOf(marker, index === source.length ? source.length : index);
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
    // vacuously on a file the parser failed to read.
    expect(literals.length).toBeGreaterThanOrEqual(MIN_CALL_SITES[filename]);
  });

  it('passes a kind discriminant at every sendAlert call site', () => {
    const kindless = literals.filter(literal => !/\bkind:\s*'(fuel|tpms)'/.test(literal));
    expect(kindless).toEqual([]);
  });
});
