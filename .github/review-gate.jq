# Review-gate decision logic for `require-review.yml` (issue #35, option (a)).
#
# A pure function: JSON in, verdict out. No network, no `gh`, no state. The
# workflow does the fetching; this file does the deciding, which is why it can
# be unit-tested against fixtures by `__tests__/review-gate.spec.ts`.
#
# This is the deliberately slim alternative to vendoring metaframework's
# 668-line `src/dispatch/review_gate.py` into a fourth repo (see the sizing
# argument on bluelinky#35). Where it differs from that module it is noted
# below; the differences are choices, not omissions.
#
# INPUT
#   {
#     "number":            42,
#     "head_committed_at": "2026-10-23T03:00:00Z" | null,
#     "author":            "<PR author login>",
#     "title":             "<PR title>",
#     "bot_logins":        ["claude[bot]"],
#     "comments":          [ GitHub issue-comment objects ],
#     "reviews":           [ GitHub review objects ]
#   }
#
# OUTPUT
#   { "state": "success" | "failure", "description": "<=140 chars" }

# Timestamps are compared as STRINGS, not parsed. Every value here comes from
# the same GitHub REST API in the same `YYYY-MM-DDTHH:MM:SSZ` shape, and for
# two same-shaped ISO-8601 UTC stamps lexicographic order *is* chronological
# order. `fromdateiso8601` would be more obviously correct and also introduces
# a parse-failure mode (it rejects fractional seconds) into a file whose whole
# job is to return a verdict; string comparison has no failure mode at all.
#
# A null on either side means "cannot be shown to be stale", so the review
# counts -- matching review_gate.py's `_is_stale`, which refuses to invent a
# refusal out of an absent field (a PENDING review has `submitted_at: null`).
def is_fresh($head):
  if . == null or $head == null then true else . >= $head end;

# Whether a review-bot comment represents a review that actually HAPPENED.
#
# The rule is "no outstanding checklist items", and it is intentionally
# different from review_gate.py's rule (which rejects a comment only when it
# BOTH carries the errored-run marker AND has unticked boxes).
#
# `track_progress: true` makes the action post its progress checklist as a
# comment the moment the run starts, then edit it in place as it works. Under
# the upstream rule that comment counts as a review on arrival -- so the gate
# goes green because the reviewer *started*, which is the exact failure #35
# describes ("its absence from a later head renders identically to a pass").
# Keying on the checkboxes instead covers that case and both errored-run cases
# together, in one predicate:
#
#   mid-flight tracking comment   has `- [ ]`  -> not a review  (upstream: IS)
#   completed tracking comment    all `- [x]`  -> a review
#   plain summary comment         no checklist -> a review
#   errored run, died at 1 of 10  has `- [ ]`  -> not a review
#   errored run, finished list    all `- [x]`  -> a review      (keeps #560)
#
# The cost is that the gate's green depends on a comment EDIT, which is why
# `require-review.yml` listens for `issue_comment: [created, edited]` and
# scores comments on `updated_at`. A gate on `created` alone could never see
# the boxes get ticked.
def counts_as_review:
  (. != null)
  and (. != "")
  # Literal markdown task-list item at the start of a line, matching
  # review_gate.py's `_TODO_STEP`. Anchored to a newline on purpose: a review
  # that *discusses* checklists in prose should not be thrown away for quoting
  # the marker mid-sentence.
  and (test("\n- \\[ \\] ") | not);

def truncate140:
  if length > 140 then (.[0:137] + "...") else . end;

def pass($why): { state: "success", description: ($why | truncate140) };
def fail($why): { state: "failure", description: ($why | truncate140) };

# Exemptions mirror the `if:` condition in `claude-code-review.yml` EXACTLY,
# and that coupling is the point rather than an inherited nicety: the reviewer
# declines to review a Dependabot PR and a `chore`-titled PR, so a gate that
# demanded a review on those would be asking for something nothing in this
# repo will ever produce -- a permanent red X with no available remedy. Change
# one list and you must change the other; `__tests__/review-gate.spec.ts`
# parses both files and asserts they agree.
def exempt_reason:
  if .author == "dependabot[bot]"
  then "Review not required: Dependabot PR -- the reviewer skips these by design."
  elif (.title // "" | startswith("chore"))
  then "Review not required: chore PR -- the reviewer skips these by design."
  else null end;

# `index`, not `inside`/`contains`: on arrays those two do SUBSTRING matching
# against each element, so `["claude"] | inside(["claude[bot]"])` is true and
# any login that is a prefix of an allow-listed one would satisfy the gate.
# Measured on jq 1.8.1: `["claude[bot]"] | index("claude")` is null, while
# `["claude[bot]"] | index(["claude[bot]"])` is 0 -- an array argument is a
# subsequence search, a scalar argument is an exact element match.
#
# `. as $l` FIRST, and that line is load-bearing. The obvious spelling,
# `($bots | index(. // ""))`, rebinds `.` to `$bots` as it crosses the pipe, so
# it evaluates `index($bots)` -- the subsequence form above -- and returns 0 for
# every input. That is a predicate that cannot fail: it admitted the login
# `"totally-unrelated"`. Caught by the prefix-login case in
# `__tests__/review-gate.spec.ts`, which is there to keep it caught.
#
# `index(null)` returns null rather than erroring, so a comment with no author
# needs no separate guard.
def is_bot($bots): . as $l | ($bots | index($l)) != null;

def candidates($bots):
  # Comments first, then formal reviews -- so a PR satisfied by a bot review
  # comment reports that rather than a formal review that happens to coexist.
  #
  # `updated_at`, not `created_at`: the tracking comment is created unticked
  # and EDITED to completion, so its creation time is not when the review
  # existed. The trade-off, stated: editing an old comment refreshes it. An
  # edit by the review bot is the self-heal path this gate depends on, and an
  # edit by a human to their own review comment is a deliberate act by the one
  # person the gate exists to apply backpressure for.
  [ ( .comments[]?
      | select(.user.login | is_bot($bots))
      | select(.body | counts_as_review)
      | { ts: .updated_at,
          why: "Review present: comment by \(.user.login // "?") at \(.updated_at // "?")" } ),
    ( .reviews[]?
      | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")
      | { ts: .submitted_at,
          why: "Review present: formal \(.state) by \(.user.login // "?") at \(.submitted_at // "?")" } )
  ];

. as $pr
| ($pr.bot_logins // ["claude[bot]"]) as $bots
| $pr.head_committed_at as $head
| ($pr | exempt_reason) as $exempt
| if $exempt != null then pass($exempt)
  else
    ($pr | candidates($bots)) as $all
    | ($all | map(select(.ts | is_fresh($head)))) as $fresh
    | if ($fresh | length) > 0 then pass($fresh[0].why)
      elif ($all | length) > 0 then
        # Distinct from the no-review-at-all message because the remedies
        # differ, and naming the wrong one sends the reader somewhere useless.
        # `gh pr close && gh pr reopen`, NOT a `/review` comment: a check-run
        # and a commit status both attach to the SHA of their triggering event,
        # so an `issue_comment` run grades the default branch and never moves
        # the PR head's verdict (metaframework#620).
        fail("Re-gate: gh pr close \($pr.number // 0) && gh pr reopen \($pr.number // 0) -- newest review (\(($all | map(.ts) | max) // "?")) predates head (\($head // "?"))")
      else
        fail("No code review on this PR head. Run the reviewer, then re-gate with: gh pr close N && gh pr reopen N")
      end
  end
