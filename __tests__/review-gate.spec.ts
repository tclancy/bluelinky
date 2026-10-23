import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Grades the review gate added for issue #35, option (a) -- both halves.
 *
 * The gate is two workflows and one decision file:
 *
 *   .github/workflows/claude-code-review.yml  produces a review
 *   .github/workflows/require-review.yml      publishes the verdict as a
 *                                             commit status on the PR head
 *   .github/review-gate.jq                    decides, as a pure function
 *
 * Splitting the decision out of the workflow is what makes it gradeable at
 * all: a workflow can only be exercised by merging it and opening a PR, and
 * worse, a PR that EDITS a review workflow is refused by the action's own
 * anti-tamper validation (`Skipping action due to workflow validation`) while
 * still concluding `success`. So the PR that introduces this gate cannot be
 * reviewed by it, and the run it does produce is a green that means nothing.
 * The jq program has no such problem -- it is JSON in, verdict out.
 *
 * WHAT THESE TESTS BUY, narrowly:
 *
 *   - The decision tests below drive every branch of `review-gate.jq` with
 *     fixtures, including the three cases that distinguish this gate from a
 *     naive one (a mid-flight tracking comment, a stale review, and a login
 *     that is a PREFIX of an allow-listed one).
 *   - The coupling test asserts the exemption list in the jq file matches the
 *     `if:` condition in the reviewer workflow. These two must agree or the
 *     gate demands a review the reviewer declines to perform, which is a
 *     permanent red X with no remedy available to anyone.
 *   - The config pins assert the five independently-silent config layers are
 *     present. Each one fails quietly and only the NEXT layer's failure shows
 *     once the prior is fixed, so they are worth pinning together.
 *
 * WHAT THEY DO NOT BUY, stated so this file cannot overclaim the way
 * `node-matrix-gate.spec.ts` once did: nothing here executes a workflow.
 * `id-token: write` being on the right job, the action resolving its inputs,
 * and the status POST being accepted are all unverifiable from here and are
 * only provable by a merged run. The config assertions are presence checks on
 * comment-stripped text, so they catch a DELETION or a flipped value and would
 * not catch, say, the permission being moved to the wrong job.
 */

const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, '.github', 'review-gate.jq');
const REVIEWER = path.join(ROOT, '.github', 'workflows', 'claude-code-review.yml');
const REQUIRE = path.join(ROOT, '.github', 'workflows', 'require-review.yml');

/** The status context `require-review.yml` publishes; the gate's public name. */
const STATUS_CONTEXT = 'dispatch/require-review';

/** The repo secret both halves read. One name, asserted in both files. */
const TOKEN_SECRET = 'CLAUDE_CODE_OAUTH_TOKEN';

/** The login the reviewer posts under, and the only one the gate trusts. */
const REVIEW_BOT = 'claude[bot]';

const HEAD_AT = '2026-10-23T03:00:00Z';
const AFTER_HEAD = '2026-10-23T03:05:00Z';
const BEFORE_HEAD = '2026-10-22T03:05:00Z';

interface Verdict {
  state: 'success' | 'failure';
  description: string;
}

interface GateInput {
  number?: number;
  head_committed_at?: string | null;
  author?: string;
  title?: string;
  bot_logins?: string[];
  comments?: unknown[];
  reviews?: unknown[];
}

/**
 * Run the real jq program over a fixture.
 *
 * Deliberately shells out to the same file the workflow runs, rather than
 * reimplementing the rules here: a transliterated copy of the logic would
 * agree with itself forever while the shipped file drifted.
 */
function decide(input: GateInput): Verdict {
  const payload: GateInput = {
    number: 7,
    head_committed_at: HEAD_AT,
    author: 'tclancy',
    title: 'feat: a change',
    bot_logins: [REVIEW_BOT],
    comments: [],
    reviews: [],
    ...input,
  };
  const out = execFileSync('jq', ['-f', GATE, '-c'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return JSON.parse(out) as Verdict;
}

function botComment(body: string, updatedAt: string | null = AFTER_HEAD, login = REVIEW_BOT) {
  return { user: { login }, created_at: updatedAt, updated_at: updatedAt, body };
}

function review(state: string, submittedAt: string | null = AFTER_HEAD, login = 'tclancy') {
  return { user: { login }, state, submitted_at: submittedAt };
}

/**
 * Drop full-line and trailing comments before asserting on workflow text.
 *
 * Without this every assertion below is satisfiable by a mention in prose --
 * and these two files are mostly prose, so that is not a hypothetical. A
 * commented-out `track_progress: true` would read as configured.
 *
 * Narrow by construction: it does not understand a `#` inside a quoted string,
 * so it would mangle one. Neither file has one on a line these tests read; if
 * you add one, this reader is what is wrong.
 */
function withoutComments(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(line => (line.trim().startsWith('#') ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n');
}

describe('jq is available to grade the gate', () => {
  /**
   * Its own test so a missing interpreter reads as a missing interpreter
   * rather than as fifteen failed assertions about review logic. jq ships on
   * `ubuntu-latest`, which is also why `require-review.yml` needs no
   * `setup-node` and no `npm ci`.
   */
  it('runs', () => {
    const version = execFileSync('jq', ['--version'], { encoding: 'utf8' });
    expect(version).toMatch(/^jq-/);
  });
});

describe('review-gate.jq — when no review exists', () => {
  it('fails a PR with no comments and no reviews', () => {
    const v = decide({});
    expect(v.state).toBe('failure');
    expect(v.description).toMatch(/No code review/);
  });

  it('ignores a comment from a non-bot login', () => {
    const v = decide({ comments: [botComment('LGTM!', AFTER_HEAD, 'tclancy')] });
    expect(v.state).toBe('failure');
  });

  /**
   * The regression guard for a predicate that could not fail.
   *
   * `is_bot` was first written `($bots | index(. // ""))`, which rebinds `.` to
   * `$bots` as it crosses the pipe and so evaluates `index($bots)` -- the
   * subsequence form -- returning 0 for every input. It admitted the login
   * `"totally-unrelated"`. A prefix is the sharper fixture: it would also be
   * admitted by a `contains`/`inside` spelling, which is the other natural way
   * to write this and is wrong for the same reason in a different direction.
   */
  it('rejects a login that is merely a PREFIX of the allow-listed bot', () => {
    const v = decide({ comments: [botComment('LGTM!', AFTER_HEAD, 'claude')] });
    expect(v.state).toBe('failure');
    expect(v.description).toMatch(/No code review/);
  });

  it('rejects a login that merely CONTAINS the allow-listed bot', () => {
    const v = decide({ comments: [botComment('LGTM!', AFTER_HEAD, 'not-claude[bot]-really')] });
    expect(v.state).toBe('failure');
  });

  it('does not count a COMMENTED review as a review', () => {
    const v = decide({ reviews: [review('COMMENTED')] });
    expect(v.state).toBe('failure');
  });

  it('does not count a DISMISSED review as a review', () => {
    const v = decide({ reviews: [review('DISMISSED')] });
    expect(v.state).toBe('failure');
  });
});

describe('review-gate.jq — when a review exists for this head', () => {
  it('passes on a bot comment newer than the head commit', () => {
    const v = decide({ comments: [botComment('Reviewed; nothing to flag.')] });
    expect(v.state).toBe('success');
    expect(v.description).toContain(REVIEW_BOT);
  });

  it('passes on a formal APPROVED review', () => {
    const v = decide({ reviews: [review('APPROVED')] });
    expect(v.state).toBe('success');
    expect(v.description).toMatch(/APPROVED/);
  });

  it('passes on a formal CHANGES_REQUESTED review', () => {
    const v = decide({ reviews: [review('CHANGES_REQUESTED')] });
    expect(v.state).toBe('success');
  });

  /**
   * `>=`, not `>`: a review submitted in the same second as the push is a
   * review OF that push. Mirrors review_gate.py's `_is_stale`, which uses `<`.
   */
  it('counts a review submitted in the same second as the head commit', () => {
    const v = decide({ comments: [botComment('Reviewed.', HEAD_AT)] });
    expect(v.state).toBe('success');
  });

  /**
   * Missing data on either side means "cannot be shown to be stale", so it
   * counts. A PENDING review genuinely has `submitted_at: null`, so this is a
   * real input rather than a defensive flourish.
   */
  it('counts a review whose timestamp is null', () => {
    const v = decide({ reviews: [review('APPROVED', null)] });
    expect(v.state).toBe('success');
  });

  it('counts a review when the head commit date is unavailable', () => {
    const v = decide({
      head_committed_at: null,
      comments: [botComment('Reviewed.', BEFORE_HEAD)],
    });
    expect(v.state).toBe('success');
  });
});

describe('review-gate.jq — staleness', () => {
  it('fails when every review predates the head commit', () => {
    const v = decide({ comments: [botComment('Reviewed.', BEFORE_HEAD)] });
    expect(v.state).toBe('failure');
  });

  /**
   * The two refusals have DIFFERENT remedies -- run the reviewer vs. re-gate
   * the existing one -- and the description is published as the commit-status
   * text, which makes it the highest-traffic instruction site in the gate.
   * Collapsing them sends the reader to the wrong fix.
   */
  it('names the re-gate remedy, not the run-the-reviewer one', () => {
    const v = decide({ comments: [botComment('Reviewed.', BEFORE_HEAD)] });
    expect(v.description).toMatch(/gh pr close 7 && gh pr reopen 7/);
    expect(v.description).not.toMatch(/No code review/);
  });

  /**
   * `/review` is NOT the remedy and must not be suggested. A check-run and a
   * commit status both attach to the SHA of their triggering event, so an
   * `issue_comment` run grades the default branch and never moves the PR
   * head's verdict (metaframework#620). Pinned because the earlier, wrong
   * advice is the natural thing to write here.
   */
  it('does not offer /review as the remedy in either refusal', () => {
    expect(decide({ comments: [botComment('Reviewed.', BEFORE_HEAD)] }).description).not.toMatch(
      /\/review/
    );
    expect(decide({}).description).not.toMatch(/\/review/);
  });

  it('passes when a stale review is accompanied by a fresh one', () => {
    const v = decide({
      comments: [botComment('Old pass.', BEFORE_HEAD), botComment('New pass.', AFTER_HEAD)],
    });
    expect(v.state).toBe('success');
  });
});

describe('review-gate.jq — a run that started is not a review', () => {
  /**
   * The case this gate exists for, and the one place it is deliberately
   * STRICTER than metaframework's `review_gate.py`.
   *
   * `track_progress: true` posts the progress checklist as a comment the
   * moment the run starts and edits it in place while it works. Upstream's
   * rule rejects a bot comment only when it both carries the errored-run
   * marker AND has unticked boxes, so a mid-flight checklist counts as a
   * review on arrival -- the gate goes green because the reviewer STARTED.
   * That is the failure #35 describes in its own words.
   */
  it('fails on a tracking comment with outstanding checklist items', () => {
    const v = decide({
      comments: [botComment('Working on it\n- [x] Read the diff\n- [ ] Post findings')],
    });
    expect(v.state).toBe('failure');
    expect(v.description).toMatch(/No code review/);
  });

  it('passes once every checklist item is ticked', () => {
    const v = decide({
      comments: [botComment('Done\n- [x] Read the diff\n- [x] Post findings')],
    });
    expect(v.state).toBe('success');
  });

  it('fails on an errored run that died partway through its checklist', () => {
    const v = decide({
      comments: [
        botComment('Claude encountered an error\n- [x] Read the diff\n- [ ] Post findings'),
      ],
    });
    expect(v.state).toBe('failure');
  });

  /**
   * Keeps metaframework#560: an `error_max_turns` run that read the diff and
   * posted findings before blowing its budget IS a review. Three substantive
   * reviews on the fleet carry the error marker.
   */
  it('passes an errored run that finished its checklist anyway', () => {
    const v = decide({
      comments: [
        botComment('Claude encountered an error\n- [x] Read the diff\n- [x] Post findings'),
      ],
    });
    expect(v.state).toBe('success');
  });

  /**
   * Pins `updated_at` as the timestamp that counts, against `created_at`.
   *
   * Every other fixture here sets the two to the same value, which makes them
   * an uncontested pair: a mutant swapping one for the other would pass the
   * whole file. This is the case that separates them, and it is the normal
   * shape of the self-heal path -- a tracking comment created before the
   * current head and edited to completion after it.
   */
  it('scores a bot comment on when it was last edited, not when it was created', () => {
    const v = decide({
      comments: [
        {
          user: { login: REVIEW_BOT },
          created_at: BEFORE_HEAD,
          updated_at: AFTER_HEAD,
          body: 'Done\n- [x] Read the diff\n- [x] Post findings',
        },
      ],
    });
    expect(v.state).toBe('success');
  });

  it('passes a plain summary comment that carries no checklist at all', () => {
    const v = decide({ comments: [botComment('Reviewed. Two notes inline, nothing blocking.')] });
    expect(v.state).toBe('success');
  });

  /**
   * Anchored to a line start, so a review that DISCUSSES an unticked checkbox
   * in prose is not thrown away for quoting the marker.
   */
  it('counts a review that mentions "- [ ]" mid-sentence', () => {
    const v = decide({
      comments: [botComment('The README renders `- [ ] foo` oddly, but that is pre-existing.')],
    });
    expect(v.state).toBe('success');
  });

  it('does not count an empty comment body', () => {
    const v = decide({ comments: [botComment('')] });
    expect(v.state).toBe('failure');
  });
});

describe('review-gate.jq — exemptions mirror the reviewer', () => {
  it('exempts a Dependabot PR', () => {
    const v = decide({ author: 'dependabot[bot]', title: 'bump got from 1 to 2' });
    expect(v.state).toBe('success');
    expect(v.description).toMatch(/not required/i);
  });

  it('exempts a chore-titled PR', () => {
    const v = decide({ title: 'chore: bump the lockfile' });
    expect(v.state).toBe('success');
    expect(v.description).toMatch(/not required/i);
  });

  it('does not exempt a title that merely contains "chore"', () => {
    const v = decide({ title: 'fix: the chore scheduler drops a job' });
    expect(v.state).toBe('failure');
  });

  /**
   * THE COUPLING, and the reason it is asserted rather than trusted. The
   * reviewer's `if:` declines Dependabot and `chore` PRs. If the gate did not
   * exempt the same two, those PRs would demand a review that nothing in this
   * repo will ever produce: a red X whose only remedy is Tom reviewing by
   * hand. Each side is read out of its own file, so editing one without the
   * other is red.
   */
  it('exempts exactly the authors and titles the reviewer workflow skips', () => {
    const reviewerIf = withoutComments(REVIEWER);
    const gateSource = fs.readFileSync(GATE, 'utf8');

    expect(reviewerIf).toContain("github.event.pull_request.user.login != 'dependabot[bot]'");
    expect(gateSource).toContain('dependabot[bot]');

    expect(reviewerIf).toContain("!startsWith(github.event.pull_request.title, 'chore')");
    expect(gateSource).toContain('startswith("chore")');
  });
});

describe('review-gate.jq — the published description', () => {
  /**
   * GitHub truncates a commit-status description at 140 characters, so the
   * gate truncates first and marks that it did.
   *
   * Both tests here FIRST failed to fail. The original fixtures put the long
   * string in a formal review while also supplying a bot comment -- and
   * comments are reported ahead of reviews, so the long name never reached
   * the description and a mutant raising the cap to 1400 survived the round.
   * The fixture below carries no comment at all, and the first assertion is a
   * reachability control: it proves the input really does overflow, so the
   * second assertion is grading truncation rather than grading a short string.
   */
  const LONG_LOGIN = 'a'.repeat(300);

  it('control: the fixture really does overflow 140 characters', () => {
    const untruncated = `Review present: formal APPROVED by ${LONG_LOGIN} at ${AFTER_HEAD}`;
    expect(untruncated.length).toBeGreaterThan(140);
  });

  it('never exceeds 140 characters', () => {
    const v = decide({ reviews: [review('APPROVED', AFTER_HEAD, LONG_LOGIN)] });
    expect(v.description.length).toBeLessThanOrEqual(140);
  });

  it('truncates with an ellipsis rather than silently cutting', () => {
    const v = decide({ reviews: [review('APPROVED', AFTER_HEAD, LONG_LOGIN)] });
    expect(v.description.endsWith('...')).toBe(true);
  });

  it('leaves a description that already fits completely alone', () => {
    const v = decide({ comments: [botComment('Reviewed.')] });
    expect(v.description.endsWith('...')).toBe(false);
    expect(v.description).toBe(`Review present: comment by ${REVIEW_BOT} at ${AFTER_HEAD}`);
  });
});

describe('require-review.yml — the status half', () => {
  const text = withoutComments(REQUIRE);

  it('publishes to the agreed status context', () => {
    expect(text).toContain(`context="${STATUS_CONTEXT}"`);
  });

  /**
   * The verdict must be POSTed to the PR head SHA, not left as the job's own
   * check. An `issue_comment` run executes in the default-branch context, so
   * its implicit check lands on `main`'s tip and never moves the PR's state.
   */
  it('posts the status to the resolved head SHA', () => {
    expect(text).toMatch(/statuses\/\$\{SHA\}/);
    expect(text).toContain('statuses: write');
  });

  /**
   * Coupled to the gate's checklist rule: the tracking comment is CREATED
   * unticked and EDITED to completion, so a trigger list without `edited`
   * could never observe the boxes get ticked and the gate could not go green
   * on the self-heal path.
   */
  it('listens for edited comments, not only created ones', () => {
    const commentTypes = text.match(/issue_comment:\s*\n\s*types:\s*\[([^\]]*)\]/);
    expect(commentTypes).not.toBeNull();
    const types = (commentTypes as RegExpMatchArray)[1].split(',').map(t => t.trim());
    expect(types).toContain('created');
    expect(types).toContain('edited');
  });

  it('re-evaluates when a formal review is submitted', () => {
    expect(text).toContain('pull_request_review:');
    expect(text).toMatch(/types:\s*\[submitted\]/);
  });

  /**
   * GitHub paints a CANCELLED run red on the PR even when the authoritative
   * status is green, which made three metaframework PRs read UNSTABLE with
   * every real check passing (metaframework#511).
   */
  it('queues concurrent runs instead of cancelling them', () => {
    expect(text).toContain('cancel-in-progress: false');
    expect(text).not.toContain('cancel-in-progress: true');
  });

  /**
   * Layer 0. The repo has no Actions secrets as of 2026-10-23, so without
   * this branch the gate is a red X whose only remedy is Tom. `pending` is
   * neither a false green nor an unactionable red.
   */
  it('publishes pending, not failure, when the reviewer token is unset', () => {
    expect(text).toContain(`REVIEWER_TOKEN: \${{ secrets.${TOKEN_SECRET} }}`);
    expect(text).toMatch(/if \[ -z "\$\{REVIEWER_TOKEN\}" \]/);
    expect(text).toMatch(/publish pending/);
  });

  /**
   * A cross-repository PR's token is read-only, so the status POST would 403
   * and turn every outside contribution into a red workflow run -- worse than
   * no gate.
   */
  it('skips cross-repository PRs', () => {
    expect(text).toContain("steps.fork.outputs.fork != 'true'");
    expect(text).toContain('head_repo" = "$REPO"');
  });

  /**
   * `--paginate` without `--jq` emits one array PER PAGE, which is not a
   * single JSON document. Any PR with more than one page of comments would
   * feed the gate a parse error, and the gate's job is to return a verdict.
   */
  it('reassembles EVERY paginated list response into one document', () => {
    // Counted, not merely found. There are two paginated calls here, so a
    // single `toMatch` is a floor: it stays green while one of the two loses
    // its reassembly, which is the one-page-works / two-pages-parse-error bug
    // this is guarding. One reassembly per `--paginate`, or red.
    const paginated = text.match(/--paginate/g) ?? [];
    const reassembled = text.match(/--paginate --jq '\.\[\]' \| jq -s '\.'/g) ?? [];
    expect(paginated.length).toBeGreaterThan(0);
    expect(reassembled.length).toBe(paginated.length);
  });

  it('runs the committed jq program rather than an inline copy of it', () => {
    expect(text).toContain('jq -f .github/review-gate.jq');
    expect(text).toContain('sparse-checkout: .github/review-gate.jq');
  });
});

/**
 * The regression guard for the trap that would have made this entire gate a
 * no-op in this repo, discovered by dry-running the pipeline against the four
 * open PRs before merging anything.
 *
 * `head.repo.fork` answers "is the head repo a fork of something" -- a
 * property of the REPO. `tclancy/bluelinky` IS a fork, so the field is `true`
 * for every same-repo branch in it. Measured 2026-10-23: PRs #46, #47, #50 and
 * #51 all report `head.repo.fork=true` with
 * `head.repo.full_name == base.repo.full_name == tclancy/bluelinky`, while a
 * PR in the non-fork `tclancy/metaframework` reports `false`. Keying the skip
 * on it would have excluded 100% of this repo's PRs -- and a gate that skips
 * everything renders exactly like a gate that passes everything, which is the
 * failure issue #35 was opened about.
 *
 * It is pinned in BOTH files because both halves need the same answer, and it
 * is pinned as an ABSENCE because the wrong spelling is the one the
 * `claude-code-action-review-gate` skill's own template ships, so it is what
 * the next person copying a working example will reach for.
 */
describe('neither half keys the skip on head.repo.fork', () => {
  it.each([
    ['claude-code-review.yml', REVIEWER],
    ['require-review.yml', REQUIRE],
  ])('%s uses head.repo.full_name, not head.repo.fork', (_name, file) => {
    const body = withoutComments(file);
    expect(body).not.toMatch(/head\.repo\.fork/);
    expect(body).toMatch(/head\.repo\.full_name/);
  });

  it('control: both files DO mention head.repo.fork in their comments', () => {
    // Without this, the assertion above passes just as happily on a file that
    // stopped discussing the trap at all -- or on a path that no longer
    // resolves. It proves the files were read and that the stripper is what
    // removed the match, not an empty read.
    for (const file of [REVIEWER, REQUIRE]) {
      expect(fs.readFileSync(file, 'utf8')).toMatch(/head\.repo\.fork/);
    }
  });
});

describe('claude-code-review.yml — the five config layers', () => {
  const text = withoutComments(REVIEWER);

  /** Layer 0: an unset secret interpolates to "" and fails the action's own validation. */
  it('layer 0 — gates itself on the token secret being non-empty', () => {
    expect(text).toContain(`REVIEWER_TOKEN: \${{ secrets.${TOKEN_SECRET} }}`);
    expect(text).toMatch(/if \[ -n "\$\{REVIEWER_TOKEN\}" \]/);
    expect(text).toMatch(/steps\.gate\.outputs\.ready == 'yes'/);
  });

  /** Layer 1: the action exchanges a GitHub OIDC token for its App token. */
  it('layer 1 — grants id-token: write', () => {
    expect(text).toContain('id-token: write');
  });

  /**
   * Layer 2: tools default-deny.
   *
   * Asserted against the `--allowed-tools` ARGUMENT, not against the file.
   * The first version of this test grepped the whole workflow, and the tool
   * name also appears in the reviewer `prompt:` ("Post findings ... with
   * mcp__github_inline_comment__..."). So a mutant deleting it from the
   * allow-list -- which is the entire failure layer 2 names -- survived the
   * mutation round on the prose mention alone.
   */
  it('layer 2 — allow-lists the inline-comment tool in claude_args', () => {
    const args = text.match(/--allowed-tools "([^"]*)"/);
    expect(args).not.toBeNull();
    const tools = (args as RegExpMatchArray)[1].split(',').map(t => t.trim());
    expect(tools).toContain('mcp__github_inline_comment__create_inline_comment');
  });

  /**
   * Layer 3, the non-obvious one: `--allowed-tools` only FILTERS registered
   * MCP servers, it does not register them. Without `track_progress` the
   * inline-comment server never connects and the tool is denied even while
   * correctly allow-listed.
   */
  it('layer 3 — registers the inline-comment server with track_progress', () => {
    expect(text).toMatch(/track_progress:\s*true/);
  });

  /** Layer 4: bot actors are blocked by default, which is a no-op gate for agent PRs. */
  it('layer 4 — allows the dispatch bot to trigger a review', () => {
    expect(text).toMatch(/allowed_bots:\s*'metaframework-dispatch-bot'/);
  });

  /** Defaults to TRUE and has documented buffering bugs. */
  it('pins classify_inline_comments off', () => {
    expect(text).toMatch(/classify_inline_comments:\s*false/);
  });

  /**
   * 32 turns is the measured requirement from itguy's runs under a cap of 25;
   * three of five runs there completed a real review and were failed anyway by
   * the action's post-check. Asserted as a floor, not an equality: raising it
   * further is fine, dropping back to 25 is the regression.
   */
  it('budgets at least the measured 32 turns', () => {
    // From `claude_args`, not from anywhere in the file: the evidence table
    // in the comments above that line quotes turn counts too, and a check
    // that would match those is a check that cannot see the real value move.
    const cap = text.match(/claude_args:[^\n]*--max-turns (\d+)/);
    expect(cap).not.toBeNull();
    expect(Number((cap as RegExpMatchArray)[1])).toBeGreaterThanOrEqual(32);
  });

  /**
   * `synchronize` would fire one model review per push -- the exact burn
   * metaframework#320 §5 cut. `reopened` is what makes a fix-up push
   * re-gateable at all.
   */
  it('triggers on opened and reopened but not synchronize', () => {
    const prTypes = text.match(/pull_request:\s*\n\s*types:\s*\[([^\]]*)\]/);
    expect(prTypes).not.toBeNull();
    const types = (prTypes as RegExpMatchArray)[1].split(',').map(t => t.trim());
    expect(types).toContain('opened');
    expect(types).toContain('reopened');
    expect(types).not.toContain('synchronize');
  });

  it('queues concurrent runs instead of cancelling them', () => {
    expect(text).toContain('cancel-in-progress: false');
    expect(text).not.toContain('cancel-in-progress: true');
  });

  /** Actions cannot post inline comments back to the base repo from a fork. */
  it('skips cross-repository PRs, as the status half does', () => {
    expect(text).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });

  /**
   * An action pinned to a moving tag is a supply-chain surface; the fleet pins
   * every third-party action to a commit SHA.
   */
  it('pins both third-party actions to a commit SHA', () => {
    const uses = text.match(/uses: [^\s]+/g) ?? [];
    const thirdParty = uses.filter(u => !u.includes('./'));
    expect(thirdParty.length).toBeGreaterThanOrEqual(2);
    for (const u of thirdParty) {
      expect(u).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
