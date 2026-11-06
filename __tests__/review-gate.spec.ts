import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
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

/**
 * The only login whose FORMAL review satisfies the gate.
 *
 * A separate list from `REVIEW_BOT` on purpose, and the separation is the fix
 * for the false green below: a review BOT satisfies the gate by posting a
 * comment, a HUMAN satisfies it by submitting a formal verdict. Merging the
 * two lists would let `claude[bot]` approve the PRs it is supposed to review.
 */
const REVIEWER_HUMAN = 'tclancy';

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
  reviewer_logins?: string[];
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

/**
 * `author_association` is here because every REAL review object carries it, and
 * omitting it made the allow-list guard read stronger than it was. Found in
 * review: adding `or (.author_association != null)` to the formal arm -- the
 * exact widening someone would write to accept "any OWNER/MEMBER/COLLABORATOR"
 * -- left all 89 tests green, while a production-shaped `NONE` payload went
 * straight back to the original false green. A fixture that omits a field
 * cannot contest a rule that reads it.
 */
function review(
  state: string,
  submittedAt: string | null = AFTER_HEAD,
  login = REVIEWER_HUMAN,
  authorAssociation = 'OWNER'
) {
  return {
    user: { login },
    state,
    submitted_at: submittedAt,
    author_association: authorAssociation,
  };
}

/** A review from an account with no relationship to the repo. */
function strangerReview(state: string, login = 'random-passerby') {
  return review(state, AFTER_HEAD, login, 'NONE');
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

/**
 * THE FALSE GREEN, and the regression guard for it.
 *
 * `candidates` has two arms. The COMMENT arm has filtered on `is_bot($bots)`
 * since the first draft of this file; the FORMAL-REVIEW arm shipped with no
 * author filter at all. The two read as symmetrical and were not — found
 * reviewing the port of this file into `parsons-remote` (PR #26) on
 * 2026-11-01, and reproduced against the real program before any fix:
 *
 *   reviews: [{user: {login: 'random-passerby'}, state: 'CHANGES_REQUESTED'}]
 *     -> {"state":"success", ...}
 *
 * `tclancy/bluelinky` is PUBLIC. Any authenticated GitHub account can submit
 * a review on an open PR, and `CHANGES_REQUESTED` needs no write access, so
 * before this fix the gate could be cleared by a stranger who read nothing —
 * and, worse for the gate's actual threat model, by one fleet bot approving
 * another fleet bot's PR, which GitHub permits. All 27 PRs this repo has ever
 * had are `metaframework-dispatch-bot[bot]`, so the cross-bot case is a
 * property of the fleet rather than something observed here yet.
 *
 * Every pre-existing formal-review test that named a plausible reviewer used
 * `tclancy` -- the helper's default -- which is why three all-killed mutation
 * rounds and 71 green tests never saw this. The two truncation tests did pass
 * a different login, but a 300-character one, so they were grading length
 * rather than identity. The fixtures were the defect, again.
 */
describe('review-gate.jq — a formal review only counts from an allow-listed login', () => {
  it('rejects CHANGES_REQUESTED from an account nobody allow-listed', () => {
    const v = decide({ reviews: [strangerReview('CHANGES_REQUESTED')] });
    expect(v.state).toBe('failure');
  });

  it('rejects APPROVED from an account nobody allow-listed', () => {
    const v = decide({ reviews: [strangerReview('APPROVED')] });
    expect(v.state).toBe('failure');
  });

  /**
   * The case the gate exists for. GitHub lets one App approve another App's
   * PR, and this fleet runs two PR-opening bots -- only one of which has
   * opened a PR in this repo so far.
   */
  it("rejects one fleet bot approving another fleet bot's PR", () => {
    const v = decide({
      author: 'dispatch-bot[bot]',
      reviews: [strangerReview('APPROVED', 'metaframework-dispatch-bot[bot]')],
    });
    expect(v.state).toBe('failure');
  });

  /**
   * Control, in both directions: the fixtures above differ from the passing
   * one ONLY in the login. Without this an unrelated change to `review()` —
   * a wrong state string, a stale timestamp — would make the three tests above
   * pass for a reason that has nothing to do with the allow-list.
   */
  it('control: the identical review from the allow-listed login passes', () => {
    const v = decide({ reviews: [review('APPROVED', AFTER_HEAD, REVIEWER_HUMAN)] });
    expect(v.state).toBe('success');
    expect(v.description).toContain(REVIEWER_HUMAN);
  });

  /**
   * The same `index` trap the comment arm is guarded against. `inside` /
   * `contains` do SUBSTRING matching on array elements, so a prefix login
   * would satisfy a naive spelling. Both arms now share `is_bot`, so this
   * guards the sharing as much as the rule.
   */
  it('rejects a login that is merely a PREFIX of the allow-listed reviewer', () => {
    const v = decide({ reviews: [strangerReview('APPROVED', 'tclan')] });
    expect(v.state).toBe('failure');
  });

  it('rejects a login that merely CONTAINS the allow-listed reviewer', () => {
    const v = decide({ reviews: [strangerReview('APPROVED', 'nottclancyatall')] });
    expect(v.state).toBe('failure');
  });

  /**
   * The two lists are not interchangeable, and this pins the direction of the
   * separation rather than just its existence. The review bot satisfies the
   * gate by COMMENTING; a formal verdict from it is not the same act and does
   * not count. Merging the lists would let the reviewer approve the PRs it
   * reviews.
   */
  it('does not let the review BOT satisfy the formal-review arm', () => {
    const v = decide({ reviews: [review('APPROVED', AFTER_HEAD, REVIEW_BOT, 'NONE')] });
    expect(v.state).toBe('failure');
  });

  it('control: that same bot DOES satisfy the gate by commenting', () => {
    const v = decide({ comments: [botComment('Reviewed; nothing to flag.')] });
    expect(v.state).toBe('success');
  });

  /**
   * The allow-list is an INPUT with a default, not a hardcoded literal, so the
   * default itself is worth driving — a `reviewer_logins` the workflow forgot
   * to pass must still land on `["tclancy"]` rather than on `[]` (which would
   * make the arm dead) or on everything (which is the bug above).
   */
  it('honours an explicitly supplied allow-list', () => {
    const v = decide({
      reviewer_logins: ['someone-else'],
      reviews: [review('APPROVED', AFTER_HEAD, 'someone-else')],
    });
    expect(v.state).toBe('success');
  });

  it('falls back to the documented default when the field is absent', () => {
    // `review()` defaults to the human below; the payload omits
    // `reviewer_logins` entirely, so only the jq-side default can pass this.
    const v = decide({ reviews: [review('APPROVED')] });
    expect(v.state).toBe('success');
    expect(v.description).toContain(REVIEWER_HUMAN);
  });

  /**
   * An empty list must reject, not admit. `index($l)` against `[]` is null, so
   * this is the same code path — but a future refactor to `any`/`all` can
   * silently invert it (`all` over an empty list is TRUE in jq), which is the
   * degenerate-value shape that turns a filter into a no-op.
   */
  it('rejects every formal review when the allow-list is empty', () => {
    const v = decide({ reviewer_logins: [], reviews: [review('APPROVED')] });
    expect(v.state).toBe('failure');
  });

  it('rejects a formal review whose user object is missing entirely', () => {
    const v = decide({ reviews: [{ state: 'APPROVED', submitted_at: AFTER_HEAD }] });
    expect(v.state).toBe('failure');
  });
});

describe('review-gate.jq — staleness', () => {
  it('fails when every review predates the head commit', () => {
    const v = decide({ comments: [botComment('Reviewed.', BEFORE_HEAD)] });
    expect(v.state).toBe('failure');
  });

  /**
   * The two refusals have DIFFERENT causes -- no review at all, versus a
   * review that predates this head -- and the description is published as the
   * commit-status text, which makes it the highest-traffic instruction site in
   * the gate. Collapsing them tells the reader the wrong story.
   */
  it('distinguishes a stale review from no review at all', () => {
    const stale = decide({ comments: [botComment(SHAPES.finished, BEFORE_HEAD)] });
    const none = decide({});
    expect(stale.description).toMatch(/predate/i);
    expect(none.description).toMatch(/No code review/i);
    expect(stale.description).not.toBe(none.description);
  });

  /**
   * BOTH refusals name `/review`, and the first draft of this file asserted
   * the opposite -- that `/review` could not be the remedy, citing
   * metaframework#620.
   *
   * That citation was misread, and the distinction is the reason this gate is
   * a commit status rather than a check-run. #620 is about a CHECK-RUN, which
   * attaches to the SHA of its own triggering event: an `issue_comment` run's
   * check lands on the default branch and never marks the PR head reviewed. A
   * COMMIT STATUS attaches to whatever SHA you POST it to, and
   * `require-review.yml` resolves the PR head and posts there from every
   * trigger. So the `/review` chain closes here: the comment fires the
   * reviewer, the reviewer posts as `claude[bot]`, that comment fires the
   * status workflow, and the head's status flips. metaframework's own
   * `require-code-review.yml` calls `/review` "the remedy the gate's own
   * staleness message instructs agents to use", for exactly this reason.
   *
   * This matters beyond the wording: it is the whole reason the gate can drop
   * the `chore`-title exemption without creating a dead end.
   */
  it('offers /review as the remedy in both refusals', () => {
    expect(decide({ comments: [botComment(SHAPES.finished, BEFORE_HEAD)] }).description).toMatch(
      /\/review/
    );
    expect(decide({}).description).toMatch(/\/review/);
  });

  /** The remedy should name the PR it applies to, not a placeholder `N`. */
  it('interpolates the real PR number into the no-review remedy', () => {
    const v = decide({ number: 4242 });
    expect(v.description).toContain('4242');
    expect(v.description).not.toMatch(/PR #N\b/);
  });

  it('passes when a stale review is accompanied by a fresh one', () => {
    const v = decide({
      comments: [botComment('Old pass.', BEFORE_HEAD), botComment('New pass.', AFTER_HEAD)],
    });
    expect(v.state).toBe('success');
  });
});

/**
 * Verbatim bodies, not paraphrases. This is the correction that matters most
 * in this file.
 *
 * The first version of this block hand-wrote its fixtures
 * (`'Working on it\n- [x] Read the diff\n- [ ] Post findings'`) and every one
 * of them carried an unticked box -- so the whole family only ever exercised
 * the shapes the rule already handled. Three mutation rounds came back
 * all-killed against it while the shipped predicate passed BOTH comment
 * shapes the action emits when it has reviewed nothing. A fixture set that
 * contains only the handled shapes cannot find an unhandled one, and mutation
 * inherits that blindness exactly.
 *
 * Shapes 1 and 2 are the ones that were wrong. Provenance for each:
 *
 *   1  the pinned action's own source at 1d6de8c --
 *      src/github/operations/comments/common.ts, createCommentBody()
 *   2  homelab#350 (three consecutive runs) and homelab#351, measured
 *      2026-10-23; metaframework#687 is the same body passing the same gate
 *   3  itguy#207, first comment
 *   4  the metaframework#560 shape: errored, checklist finished anyway
 *   5  sandy#175, the finished tracking comment
 *   6  sandy#175, the separate summary posted via `gh pr comment`
 */
const SHAPES = {
  inflight:
    'Claude Code is working\u2026 <img src="https://github.com/user-attachments/assets/5ac.png" width="14px" />\n\nI\'ll analyze this and get back to you.\n\n[View job run](https://github.com/tclancy/bluelinky/actions/runs/1)',
  erroredNoChecklist:
    "**Claude encountered an error** \u2014\u2014 [View job](https://github.com/tclancy/homelab/actions/runs/2)\n\n---\nI'll analyze this and get back to you.",
  erroredPartialChecklist:
    '**Claude encountered an error after 2m 10s** \u2014\u2014 [View job](https://x)\n\n- [x] Read the diff\n- [ ] Post findings',
  erroredFinishedChecklist:
    '**Claude encountered an error after 9m 1s** \u2014\u2014 [View job](https://x)\n\n- [x] Read the diff\n- [x] Post findings',
  finished:
    "**Claude finished @metaframework-dispatch-bot[bot]'s task in 3m 48s** \u2014\u2014 [View job](https://x)\n\n- [x] Read the diff\n- [x] Post findings",
  plainSummary:
    '### Review: sandy#175 (GIT_* env scrub for repo hygiene tests)\n\nI read the diff and have two notes, neither blocking.',
};

describe('review-gate.jq — a run that started is not a review', () => {
  /**
   * THE REGRESSION THIS GATE EXISTS TO NOT HAVE. `track_progress: true` forces
   * tag mode, which posts this comment at prepare time -- before any review
   * work -- and it carries no checklist at all. A rule keyed only on
   * outstanding checkboxes publishes `success` seconds after the reviewer
   * spawns, and if the run then dies without editing the comment nothing
   * re-fires and the green is permanent.
   */
  it("fails on the action's in-flight comment, which has no checklist at all", () => {
    const v = decide({ comments: [botComment(SHAPES.inflight)] });
    expect(v.state).toBe('failure');
  });

  /**
   * metaframework#687 by its own name: "review_gate counts 'Claude
   * encountered an error' as a code review -- 18 PRs passed the gate with
   * zero reviews". homelab#350 carries three of these in a row, which is a
   * green gate built out of three error messages.
   */
  it('fails on an errored run that posted no checklist', () => {
    const v = decide({ comments: [botComment(SHAPES.erroredNoChecklist)] });
    expect(v.state).toBe('failure');
  });

  it('fails on an errored run that died partway through its checklist', () => {
    const v = decide({ comments: [botComment(SHAPES.erroredPartialChecklist)] });
    expect(v.state).toBe('failure');
  });

  /**
   * Keeps metaframework#560: an `error_max_turns` run has read the diff and
   * posted its findings before blowing its budget, and three substantive
   * fleet reviews carry the error marker. Rejecting these would silently
   * reverse a measured decision.
   */
  it('passes an errored run that finished its checklist anyway', () => {
    const v = decide({ comments: [botComment(SHAPES.erroredFinishedChecklist)] });
    expect(v.state).toBe('success');
  });

  it('passes the finished tracking comment', () => {
    const v = decide({ comments: [botComment(SHAPES.finished)] });
    expect(v.state).toBe('success');
  });

  it('passes a plain summary comment that carries no checklist at all', () => {
    const v = decide({ comments: [botComment(SHAPES.plainSummary)] });
    expect(v.state).toBe('success');
  });

  /**
   * The discriminator between shapes 2 and 6 is the leading status line, not
   * the absence of a checklist -- both lack one. This is the control proving
   * that: same missing checklist, opposite verdicts.
   */
  it('control: shapes 2 and 6 both lack a checklist and are graded oppositely', () => {
    expect(SHAPES.erroredNoChecklist).not.toMatch(/\n- \[[x ]\] /);
    expect(SHAPES.plainSummary).not.toMatch(/\n- \[[x ]\] /);
    expect(decide({ comments: [botComment(SHAPES.erroredNoChecklist)] }).state).toBe('failure');
    expect(decide({ comments: [botComment(SHAPES.plainSummary)] }).state).toBe('success');
  });

  /**
   * Anchored to a line start, so a review that DISCUSSES an unticked checkbox
   * in prose is not thrown away for quoting the marker.
   */
  /**
   * The status-line match is anchored to the START of the body, and dropping
   * that anchor survived a mutation round until this test existed.
   *
   * Unanchored, a genuine summary that happens to QUOTE one of the action's
   * status lines mid-prose becomes a "status comment", and then fails for not
   * saying "finished" -- so a real review is thrown away for discussing a
   * failed run. Which is a thing reviews in this fleet actually do.
   */
  it('counts a summary that quotes an action status line mid-prose', () => {
    const v = decide({
      comments: [
        botComment(
          'I looked at the previous run: it posted `**Claude encountered an error**` and reviewed nothing. This head is fine.'
        ),
      ],
    });
    expect(v.state).toBe('success');
  });

  it('counts a review that mentions "- [ ]" mid-sentence', () => {
    const v = decide({
      comments: [botComment('The README renders `- [ ] foo` oddly, but that is pre-existing.')],
    });
    expect(v.state).toBe('success');
  });

  it('rejects a body that is nothing but an outstanding checklist item', () => {
    // `(^|\n)` rather than `\n` alone: no preceding newline at byte 0.
    const v = decide({ comments: [botComment('- [ ] Post findings')] });
    expect(v.state).toBe('failure');
  });

  it('does not count an empty comment body', () => {
    const v = decide({ comments: [botComment('')] });
    expect(v.state).toBe('failure');
  });

  /**
   * Pins `updated_at` as the timestamp that counts, against `created_at`.
   *
   * Every other fixture sets the two to the same value, which makes them an
   * uncontested pair: a mutant swapping one for the other would pass the whole
   * file. This is the normal shape of the self-heal path -- the in-flight
   * comment is created before the current head and edited into the finished
   * one after it. Real values from sandy#175: created 19:23:05, updated
   * 19:27:08.
   */
  it('scores a bot comment on when it was last edited, not when it was created', () => {
    const v = decide({
      comments: [
        {
          user: { login: REVIEW_BOT },
          created_at: BEFORE_HEAD,
          updated_at: AFTER_HEAD,
          body: SHAPES.finished,
        },
      ],
    });
    expect(v.state).toBe('success');
  });
});

describe('review-gate.jq — the one exemption is on the author', () => {
  it('exempts a Dependabot PR', () => {
    const v = decide({ author: 'dependabot[bot]', title: 'bump got from 1 to 2' });
    expect(v.state).toBe('success');
    expect(v.description).toMatch(/not required/i);
  });

  /**
   * The gate deliberately does NOT exempt a `chore` title, even though the
   * reviewer declines to auto-review one.
   *
   * `review_gate.py`'s comment on `EXEMPT_PR_AUTHORS` calls the title-prefix
   * heuristic the bug that constant replaced: it over-matches (a human
   * `chore:` PR goes unreviewed) and under-matches (a hand-retitled
   * Dependabot PR gets gated again). In a gate whose purpose is backpressure
   * on AGENT PRs, a title prefix is a one-word self-service bypass.
   *
   * It does not create an unremediable red X, because `/review` runs the
   * reviewer and re-publishes this status without Tom -- which the refusal
   * message says, and the test below pins.
   */
  it('does NOT exempt a chore-titled PR — that would be a one-word bypass', () => {
    const v = decide({ title: 'chore: bump the lockfile' });
    expect(v.state).toBe('failure');
    expect(v.description).toMatch(/\/review/);
  });

  it('does not exempt a title that merely contains "chore"', () => {
    const v = decide({ title: 'fix: the chore scheduler drops a job' });
    expect(v.state).toBe('failure');
  });

  /**
   * THE COUPLING, asserted as SET EQUALITY in both directions, because the
   * first version of this test was four presence checks and said "exactly" in
   * its own name. Confirmed by mutation: adding
   * `&& !startsWith(...title, 'docs')` to the reviewer's `if:` left all 56
   * tests green, and a `docs:` PR would then get no auto-review while the gate
   * demanded one.
   *
   * Two separate claims:
   *   1. the AUTHOR exemptions must agree between the two files;
   *   2. the reviewer's TITLE-prefix skips must be exactly {chore} -- because
   *      the gate exempts no title at all, and every title the reviewer skips
   *      is one whose only remedy is `/review`. Adding a prefix there is a
   *      decision, so it should be red here rather than silent.
   */
  it('the reviewer skips exactly one title prefix, and the gate exempts none', () => {
    const reviewer = withoutComments(REVIEWER);
    const prefixes = [
      ...reviewer.matchAll(/!startsWith\(github\.event\.pull_request\.title, '([^']+)'\)/g),
    ].map(m => m[1]);
    expect(new Set(prefixes)).toEqual(new Set(['chore']));

    const gate = withoutComments(GATE);
    expect(gate).not.toMatch(/startswith\("chore"\)/);
    expect(gate).not.toMatch(/\.title/);
  });

  it('the author exemptions agree between the two files', () => {
    const reviewer = withoutComments(REVIEWER);
    const authors = [
      ...reviewer.matchAll(/github\.event\.pull_request\.user\.login != '([^']+)'/g),
    ].map(m => m[1]);
    expect(new Set(authors)).toEqual(new Set(['dependabot[bot]']));

    const gate = withoutComments(GATE);
    const gateAuthors = [...gate.matchAll(/\.author == "([^"]+)"/g)].map(m => m[1]);
    expect(new Set(gateAuthors)).toEqual(new Set(authors));
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

  /**
   * `reviewer_logins: [LONG_LOGIN]` is not decoration. Once the formal-review
   * arm became allow-listed, this fixture stopped PRODUCING the long
   * description at all -- the gate refused the review and returned the short
   * "No code review for this head" instead. `never exceeds 140` then passed
   * vacuously -- the refusal is 106 characters -- while its sibling `truncates
   * with an ellipsis` went RED. Only one of the pair failed to fail, which is
   * the pair's redundancy doing its job. The reachability assertion below is
   * what keeps that visible rather than re-derived.
   */
  const LONG_LOGIN_ALLOWED = { reviewer_logins: [LONG_LOGIN] };

  it('never exceeds 140 characters', () => {
    const v = decide({
      ...LONG_LOGIN_ALLOWED,
      reviews: [review('APPROVED', AFTER_HEAD, LONG_LOGIN)],
    });
    expect(v.description.length).toBeLessThanOrEqual(140);
    // Reachability: the untruncated form really was built, so the assertion
    // above graded truncation rather than a refusal.
    expect(v.state).toBe('success');
  });

  it('truncates with an ellipsis rather than silently cutting', () => {
    const v = decide({
      ...LONG_LOGIN_ALLOWED,
      reviews: [review('APPROVED', AFTER_HEAD, LONG_LOGIN)],
    });
    expect(v.description.endsWith('...')).toBe(true);
  });

  it('leaves a description that already fits completely alone', () => {
    const v = decide({ comments: [botComment('Reviewed.')] });
    expect(v.description.endsWith('...')).toBe(false);
    expect(v.description).toBe(`Review present: comment by ${REVIEW_BOT} at ${AFTER_HEAD}`);
  });
});

/**
 * Read a `name: ["a", "b"]` list out of a file as the quoted strings it holds.
 *
 * Both obvious spellings are wrong on this file's real inputs, which is why
 * this is one shared reader rather than a regex at each call site:
 *
 *   `\[([^\]]*)\]`      stops at the first `]` -- and `["claude[bot]"]` has
 *                        one INSIDE the login, so it yields `claude[bot`.
 *   `\[([\s\S]*?)\]\s*,` needs a comma after the bracket, which the jq-side
 *                        spelling (`// ["tclancy"]) as $reviewers`) has not.
 *
 * So: find the key, take the rest of ITS line, span first `[` to last `]`, and
 * read the quoted strings out of that. Every list this file asks about is on
 * one line in both files.
 */
function parse(text: string, key: string): string[] {
  const line = text.match(new RegExp(`${key}[^\\n]*`));
  if (!line) return [];
  const open = line[0].indexOf('[');
  const close = line[0].lastIndexOf(']');
  if (open === -1 || close <= open) return [];
  return [...line[0].slice(open, close + 1).matchAll(/"([^"]*)"/g)].map(q => q[1]);
}

describe('require-review.yml — the status half', () => {
  const text = withoutComments(REQUIRE);

  /**
   * The guard step's `if:`, and the slice of the file from it onward.
   *
   * Sliced rather than asserted file-wide because every line the guard step
   * adds is a SECOND spelling of a line the main step already has -- the status
   * context, the POST, the SHA lookup. A file-wide `toContain` is satisfied by
   * the first copy and says nothing about the second, which is how four
   * mutants on this step survived a green suite.
   */
  const GUARD_IF = /^\s*if: failure\(\) && steps\.fork\.outputs\.fork != 'true'$/m;
  const guard = text.slice(text.search(GUARD_IF));

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
    expect(text).toMatch(/if \[ "\$state" != "success" \] && \[ -z "\$\{REVIEWER_TOKEN\}" \]/);
    expect(text).toMatch(/publish pending/);
  });

  /**
   * THE ORDERING, and it is a bug fix rather than tidying.
   *
   * The unprovisioned check used to be the FIRST thing in the step, which put
   * it upstream of `exempt_reason` in `review-gate.jq`. Dependabot runs read a
   * separate secret store, so `secrets.CLAUDE_CODE_OAUTH_TOKEN` interpolates
   * EMPTY on a Dependabot event even once the Actions secret exists — and this
   * repo has had no Dependabot PR yet -- `dependabot.yml` only landed in #50 --
   * so these are the PRs it is about to start getting rather than ones it has.
   * Every one of them would have
   * published `pending`, instructing Tom to add a secret that is already
   * there, instead of the `success` its exemption grants it.
   *
   * Asserted as a POSITION, not a presence: both spellings contain the same
   * lines, and only their order differs. The index comparison is what a
   * presence check cannot make.
   */
  it('evaluates the gate BEFORE deciding the reviewer is unprovisioned', () => {
    const gateRun = text.indexOf('jq -f .github/review-gate.jq');
    const tokenCheck = text.search(
      /if \[ "\$state" != "success" \] && \[ -z "\$\{REVIEWER_TOKEN\}" \]/
    );
    expect(gateRun).toBeGreaterThan(-1);
    expect(tokenCheck).toBeGreaterThan(-1);
    expect(tokenCheck).toBeGreaterThan(gateRun);
  });

  /**
   * And the conjunct, separately, because the position alone does not say the
   * exemption survives. With the check moved but left unconditional, a
   * Dependabot event would evaluate the gate, get `success`, and then
   * overwrite it with `pending` — the same wrong description one step later.
   */
  it('lets an exempt verdict through the unprovisioned check', () => {
    expect(text).toMatch(
      /if \[ "\$state" != "success" \] && \[ -z "\$\{REVIEWER_TOKEN\}" \]; then\s*\n\s*publish pending/
    );
    expect(text).toMatch(/publish "\$state" "\$description"/);
  });

  /**
   * The formal-review arm's allow-list, wired from here — see the long note on
   * `candidates` in `.github/review-gate.jq`.
   */
  it('passes a reviewer allow-list that is SEPARATE from the bot list', () => {
    // The list body is read as QUOTED STRINGS, not as `[^\]]*`. A bracket
    // class stops at the first `]` -- which in `["claude[bot]"]` is the one
    // INSIDE the login -- so the naive reader yields `claude[bot` and the
    // assertion fails for a reason that has nothing to do with the gate.
    expect(parse(text, 'bot_logins')).toEqual([REVIEW_BOT]);
    expect(parse(text, 'reviewer_logins')).toEqual([REVIEWER_HUMAN]);
  });

  /**
   * THE COUPLING. The workflow passes the list and the jq file defaults it, so
   * the two can disagree silently: a workflow that stopped passing the field
   * would fall back to the jq default and still grade correctly, while a
   * workflow passing a DIFFERENT list would grade differently from every test
   * in this file (which drives the default). Pinned as equality so the drift
   * is red rather than invisible.
   */
  it('the reviewer allow-list agrees with the jq default it falls back to', () => {
    const fromWorkflow = parse(text, 'reviewer_logins');
    const fromGate = parse(withoutComments(GATE), '\\$pr\\.reviewer_logins //');
    expect(fromWorkflow.length).toBeGreaterThan(0);
    expect(new Set(fromGate)).toEqual(new Set(fromWorkflow));
  });

  /**
   * The ERR trap only covers the step it is declared in. If `Resolve PR number
   * and head SHA` or the cross-repo step dies first — one `gh api` 5xx is
   * enough — nothing publishes and the PR keeps whatever status it had, which
   * on a re-evaluation of an approved-then-pushed PR is a stale GREEN. That is
   * the trap's own failure mode arriving one step earlier than the trap can
   * see it.
   */
  it('publishes an error status when a step BEFORE the gate dies', () => {
    expect(text).toMatch(GUARD_IF);
    expect(guard).toMatch(/state=error/);
    // It must re-resolve the SHA itself: `steps.pr.outputs.sha` is empty
    // precisely when the resolve step is what broke, so reading it would post
    // to nowhere and the guard would be decorative.
    expect(guard).not.toContain('steps.pr.outputs');
    expect(guard).toMatch(/gh api "repos\/\$\{REPO\}\/pulls\/\$\{number\}" --jq \.head\.sha/);
  });

  /**
   * THE CONTEXT, COUNTED. Mutating ONLY the guard step's context to
   * `dispatch/require-review-oops` left all 89 tests green, because the
   * file-level `toContain(context=...)` above is satisfied by the `publish`
   * helper's copy alone. In production that mutant publishes a brand-new red
   * context beside a stale `dispatch/require-review` that still reads green --
   * the precise failure mode the guard step was added to prevent. Found in
   * review, not by the mutation round, which never mutated this line.
   */
  it('the guard step publishes to the SAME status context, not a new one', () => {
    const occurrences = text.match(/context="dispatch\/require-review"/g) ?? [];
    expect(occurrences).toHaveLength(2);
    expect(guard).toContain(`context="${STATUS_CONTEXT}"`);
  });

  /**
   * THE EVENT BRANCHES, AS ADJACENCY. Swapping `number="$ISSUE_NUMBER"` and
   * `number="$PR_NUMBER"` between the two branches also survived 89 green
   * tests: on an `issue_comment` event the swap reads the empty `PR_NUMBER`,
   * the lookup fails into `|| true`, and the step exits 0 having published
   * nothing -- a silent stale verdict on the one trigger this step exists for.
   * Same treatment the fork branches get above, for the same reason.
   */
  it('resolves the PR number per event, and the branches are not invertible silently', () => {
    expect(guard).toMatch(
      /if \[ "\$EVENT_NAME" = "issue_comment" \]; then\s*\n\s*number="\$ISSUE_NUMBER"\s*\n\s*else\s*\n\s*number="\$PR_NUMBER"/
    );
  });

  /**
   * `|| true` on the POST. The job is already red, so this is lower stakes than
   * the two above -- but without it a 403 on a cross-repo PR turns the guard
   * step itself into the thing that fails, and `set -uo pipefail` carries no
   * `-e`, so the intent is explicit rather than incidental.
   */
  it('never lets the guard step itself become the failure', () => {
    expect(guard).toMatch(/-f target_url="\$\{RUN_URL\}" >\/dev\/null \|\| true/);
  });

  /**
   * The guard obeys the same cross-repo rule the rest of the file states: a
   * fork PR's token is read-only, so its POST would 403. `!= 'true'` and not
   * `== 'false'` on purpose -- if the resolve step died before the fork step
   * ran, the output is EMPTY, and publishing on an unknown fork state is the
   * safe direction. A stale green is worse than a 403 `|| true` swallows.
   */
  it('the guard step skips cross-repository PRs, and defaults to publishing', () => {
    expect(text).toMatch(/if: failure\(\) && steps\.fork\.outputs\.fork != 'true'/);
    expect(text).not.toMatch(/if: failure\(\) && steps\.fork\.outputs\.fork == 'false'/);
  });

  /**
   * `publish pending` must STOP. Dropping its `exit 0` survived 89 green tests,
   * and control then falls through to `publish "$state" "$description"`, which
   * overwrites the pending with the non-success verdict -- reinstating exactly
   * the unactionable red X the Layer-0 branch exists to avoid.
   */
  it('stops after publishing pending rather than falling through', () => {
    expect(text).toMatch(/publish pending \\\s*\n\s*"[^"]+"\s*\n\s*exit 0\s*\n\s*fi/);
  });

  /**
   * GitHub truncates a commit-status description at 140 characters and 422s
   * past it, which here would trip the ERR trap and publish `error` over a real
   * verdict. `truncate140` in the jq file only covers the strings IT builds;
   * every literal in this workflow is hand-written and unbounded. The longest
   * today is 136 characters -- four of headroom on the one a future editor is
   * most likely to lengthen.
   */
  it("every hand-written status description fits GitHub's 140-character cap", () => {
    const literals = [
      ...[...text.matchAll(/publish \w+ \\?\s*\n?\s*"([^"]{20,})"/g)].map(m => m[1]),
      ...[...text.matchAll(/-f description="([^"$]{20,})"/g)].map(m => m[1]),
    ];
    // Reachability control: there are four such literals (the pending text, the
    // trap's, and the guard step's), so a reader that found none would pass
    // this vacuously.
    expect(literals.length).toBeGreaterThanOrEqual(3);
    for (const literal of literals) {
      expect(literal.length).toBeLessThanOrEqual(140);
    }
  });

  /**
   * Control for the two position assertions above: prove the reader can see a
   * WRONG order, rather than only a right one. Without it, a matcher that
   * silently found nothing would report both orderings as correct.
   */
  it('control: the ordering reader really does distinguish the two orders', () => {
    const marker = /if \[ "\$state" != "success" \] && \[ -z "\$\{REVIEWER_TOKEN\}" \]/;
    const inverted =
      'if [ "$state" != "success" ] && [ -z "${REVIEWER_TOKEN}" ]\n' +
      'jq -f .github/review-gate.jq gate-input.json\n';
    expect(inverted.search(marker)).toBeLessThan(inverted.indexOf('jq -f .github/review-gate.jq'));
  });

  /**
   * A cross-repository PR's token is read-only, so the status POST would 403
   * and turn every outside contribution into a red workflow run -- worse than
   * no gate.
   */
  /**
   * Asserted as the BRANCH BODIES IN ORDER, not as two presence checks.
   *
   * Confirmed by mutation: swapping the `fork=false` / `fork=true` bodies --
   * so the gate skips every same-repo PR and publishes no status at all --
   * left all 56 tests green under the presence-check version. That inversion
   * is the single mutation that silently disables the whole gate, and this
   * file's own prose calls it the failure that "renders exactly like a gate
   * that passes everything". A swap breaks the adjacency below.
   */
  it('skips cross-repository PRs, and the branches are not invertible silently', () => {
    expect(text).toContain("steps.fork.outputs.fork != 'true'");
    expect(text).toMatch(
      /if \[ "\$head_repo" = "\$REPO" \]; then\s*\n\s*fork=false\s*\n\s*else\s*\n\s*fork=true\s*\n\s*fi/
    );
  });

  /**
   * A gate that cannot be evaluated must not leave the previous verdict
   * standing. Under `set -e` a failed `gh api` just kills the step, so no
   * status is posted and the PR silently keeps whatever it had -- which on a
   * re-evaluation of an approved-then-pushed PR is a stale GREEN.
   */
  it('publishes an error status rather than nothing when evaluation fails', () => {
    // Line-anchored. `toMatch(/trap 'publish error/)` was satisfied by a
    // DISABLED copy of the line -- prefixing `: ` turns the trap into a no-op
    // argument to the null command and the substring still matches, so the
    // mutant survived a round. The trap must be the first thing on its line.
    expect(text).toMatch(/^\s*trap 'publish error/m);
    expect(text).toMatch(/\bERR$/m);
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
/**
 * Syntax-checks every `run:` block in both workflows with `bash -n`.
 *
 * Earned its place immediately: an apostrophe in a YAML comment written INSIDE
 * the single-quoted `jq` program closed the quote and left the rest of the
 * step as one unterminated string. YAML still parsed, `check-yaml` passed, and
 * nothing else in this repo reads a `run:` body -- the break would only have
 * surfaced as a failing job after merge, on a workflow whose failure mode is
 * "no status posted".
 *
 * The block reader is hand-rolled rather than using js-yaml, matching
 * `pre-commit-config.spec.ts`: js-yaml is in node_modules only as an
 * undeclared transitive dependency of eslint, so an eslint bump could remove
 * it and break this test for an unrelated reason.
 */
function runBlocks(file: string): string[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)run: \|\s*$/);
    if (!match) continue;
    const outer = match[1].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const indent = lines[j].search(/\S/);
      if (lines[j].trim() === '') {
        body.push('');
        continue;
      }
      if (indent <= outer) break;
      body.push(lines[j]);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

describe('every workflow run: block is valid shell', () => {
  it.each([
    ['claude-code-review.yml', REVIEWER],
    ['require-review.yml', REQUIRE],
  ])('%s', (_name, file) => {
    const blocks = runBlocks(file);
    // Reachability control: a reader that returned nothing would pass the
    // loop below vacuously, which is the exact shape this file keeps warning
    // about. Both workflows have at least two `run:` steps.
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block.trim().length).toBeGreaterThan(0);
      // `bash -n` parses without executing. Throws on a syntax error, which
      // jest reports as the failure.
      execFileSync('bash', ['-n'], { input: block, encoding: 'utf8' });
    }
  });

  /**
   * No GitHub expression may appear in a `run:` body — not even in a comment.
   *
   * This is two rules that happen to be one check, and the second is the
   * reason the test exists rather than the first.
   *
   *   1. SECURITY, which is the rule the workflows already follow by design:
   *      every value reaches these scripts through `env:`, because a PR title
   *      or comment body interpolated into shell is a command-injection
   *      surface and one of the fields read here IS the PR title.
   *   2. VALIDITY. GitHub evaluates expressions in a `run:` body before the
   *      shell sees the script, so one inside a `#` comment is still parsed.
   *      An earlier draft wrote the token with an EMPTY expression inside it
   *      while explaining rule 1 — and an empty expression is not a valid
   *      expression, so the entire workflow file became invalid.
   *
   * What that failure looked like, because it is worth recognising: a `push`
   * run — an event the workflow has no trigger for — that FAILED with ZERO
   * jobs, no annotation, no log and no check-run to read. `check-yaml`,
   * `prettier` and `@action-validator/cli` all passed the file, including
   * against a known-good control. Located by pushing five cumulative probe
   * workflows in one commit and seeing which ones GitHub refused.
   *
   * One thing that is NOT a tell, though it reads like one: the workflow
   * showing up under its path rather than its `name:` in
   * `gh api actions/workflows`. That is simply how GitHub lists a workflow
   * absent from the DEFAULT branch, and the run that succeeded after the fix
   * displays identically.
   *
   * So this is banned as a TOKEN rather than as a specific malformed
   * expression: the valid spellings are a security problem and the invalid
   * ones are a parse problem, and the design wants zero of either.
   */
  it.each([
    ['claude-code-review.yml', REVIEWER],
    ['require-review.yml', REQUIRE],
  ])('%s has no GitHub expression in any run: body', (_name, file) => {
    const blocks = runBlocks(file);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      expect(block).not.toContain('${{');
    }
  });

  it('control: the run-block reader would actually see an injected expression', () => {
    // The assertion above is an ABSENCE, and the reader it depends on is
    // hand-rolled. Without this, a reader that silently stopped finding run
    // blocks — or a path that no longer resolves — would pass it forever.
    // Proves the reader locates real bodies AND that a planted token is
    // visible to the same code path.
    const planted = fs
      .readFileSync(REQUIRE, 'utf8')
      .replace(/^(\s*)set -euo pipefail$/m, '$1echo "${{ github.event.pull_request.title }}"');
    const tmp = path.join(os.tmpdir(), `review-gate-control-${process.pid}.yml`);
    fs.writeFileSync(tmp, planted);
    try {
      const blocks = runBlocks(tmp);
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      expect(blocks.some(b => b.includes('${{'))).toBe(true);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('control: bash -n really does reject a broken block', () => {
    // Without this the loop above is indistinguishable from a no-op if the
    // shell check ever stops throwing.
    expect(() =>
      execFileSync('bash', ['-n'], { input: "echo 'unterminated", encoding: 'utf8' })
    ).toThrow();
  });
});

describe('both workflows pin their third-party actions to a commit SHA', () => {
  it.each([
    ['claude-code-review.yml', REVIEWER, 2],
    ['require-review.yml', REQUIRE, 1],
  ])('%s', (_name, file, expected) => {
    // `/^\s*-\s+uses: /m`, not `/uses: /`: the bare substring also matches
    // `statuses: write` in require-review.yml's `permissions:` block, which
    // made this test count two actions in a file that has one -- a presence
    // check reading a permission as a pinned action.
    const uses = withoutComments(file).match(/^\s*(?:-\s+)?uses: \S+/gm) ?? [];
    expect(uses.length).toBe(expected);
    for (const u of uses) {
      expect(u).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('control: the uses: matcher does not read a permission as an action', () => {
    // `statuses: write` contains the literal `uses: `. The first version of
    // the matcher above was `/uses: \S+/` and counted it as a second pinned
    // action in a file that has one.
    expect('      statuses: write'.match(/^\s*(?:-\s+)?uses: \S+/gm)).toBeNull();
  });
});

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
});
