# Changelog

## 2026-10-13

- **The Canadian region is deleted.** `CanadianController`, `CanadianVehicle`,
  `src/constants/canada.ts` and `src/tools/runtime.tools.ts` are gone, along
  with the `CA` arm of `src/index.ts`'s dispatch switch, `REGIONS.CA`, the `CA`
  member of the `REGION` union, `ALL_ENDPOINTS.CA`, the `CA` entry in
  `src/util.ts`'s temp-code ranges and `debug.ts`'s `CA` choice. Nothing
  selected it: all three entry points read `process.env.BLUELINK_REGION || 'US'`
  and every deploy doc sets `US`, so the only thing exercising these paths was
  the test suite -- which is also why the four divergences #32 catalogued, one
  of them reporting a failed lock as successful, were never reachable in
  production (issue #32).
- **`undici` is no longer a runtime dependency.** The Canadian controller, the
  Canadian vehicle and `runtime.tools.ts` were its only importers in the shipped
  tree; `got` is unaffected and still used by every remaining region. The
  runtime dependency list goes seven packages to six. Verified by building the
  image and running both entry points inside it: `monitor.ts` resolves its whole
  import graph and stops at "Missing required environment variables",
  `status-json.ts` at an unmounted state volume -- neither at a module
  resolution error.
- **The CI node matrix keeps its three legs and loses its reason.** The legs
  were added either side of major 21 because that is where the Canadian arm
  switched between `got` and undici's `fetch`, so they graded a production
  default that was sensitive to the running major. With the region gone
  **nothing in the suite reads the running major** and the legs run byte-identical assertions on three
  interpreters. `__tests__/node-matrix-gate.spec.ts` is re-pointed at the
  coupling that survives -- CI must carry a leg for whichever major
  `Dockerfile`'s `ARG NODE_IMAGE` resolves to -- and says so in its own
  docblock rather than keeping the retired claim. Whether three legs is still
  the right number is issue #31.
- **The `node:20` pin is no longer load-bearing.** `docker-image.spec.ts`
  asserted the base-image major was below 21, because bumping it would have
  switched the Canadian transport in production. That assertion is removed: it
  now constrains nothing real, and node 20 has been past end-of-life since
  2026-04-30. Bumping the image is now an ordinary maintenance change that needs
  testing against plexpi, not a transport decision. `deployment/README.md` is
  corrected to say so.
- **The repo-wide ban on `NODE_TLS_REJECT_UNAUTHORIZED` survives the deletion**,
  as `__tests__/tls-global-scope.spec.ts`. It was the third `describe` block of
  the deleted `canadian-tls-scope.spec.ts` and was never Canada-specific: it
  walks `src/`, `scripts/` and every root source file -- including
  `jest.config.cjs`, which executes inside the test process -- and bans the
  identifier outright. #32's own analysis named this the one item that holds
  "under every option, including deletion", because "'unreachable' is a weaker
  guarantee than 'absent'". Its two Canada reachability assertions are replaced
  with surviving request paths and its scan floor is re-measured 52 -> 49.
- **`.env.example` no longer advertises `CA` as a legal region**, and
  `__tests__/deploy-docs.spec.ts` now gates that prose against `REGIONS`. The
  comment above `BLUELINK_REGION=US` still listed `CA` after the region was
  deleted, and `src/index.ts` THROWS on an unknown region -- measured in the
  built image, `BLUELINK_REGION=CA npx tsx monitor.ts` dies on an unhandled
  `Your region is not supported yet.` So a stale name in the file
  `deployment/README.md` tells a human to copy is a broken cron job, not a
  typo. The same `CA` example is dropped from the bug-report issue template,
  and the dead `test-ca` npm script -- an upstream leftover pointing at a
  `test-ca.js` that is not in the tree -- is removed.
- **Correction, measured rather than inherited: `ci.yaml` justified its node 25
  leg with "plexpi runs 25", and plexpi has no host node at all.** Not on the
  login-shell PATH, no `/usr/bin/node`, no nvm or fnm install, no `nodejs`
  package; the only node on the box is **v20.20.2 inside the container**. 25 is
  this Mac's version, attributed to the wrong host. The 25 leg therefore has no
  measured justification and never did -- which is input to issue #31 rather
  than a reason to drop it here. The comment now records the measurement.
- **`MEASURED_IMAGE_FILES` re-measured: 46 files**, from a real
  `docker build --platform linux/arm64` on docker 29.8.2 / buildx 0.37.2, down
  from 50 by exactly the four deleted source files. Regenerated from the build rather than
  edited, which is what that constant is for. Counting from its first
  measurement on 2026-10-11, this is the second time an unrelated change to
  `src/` has moved it -- PR #30 added the 50th file, this removes four -- and
  the open design question is issue #42.
- **`push-receiver` is removed.** It was declared in `dependencies` by
  `ae0218a` ("Completed EU login") and the consumer never landed: no tracked
  file imports it, and `git log -S'push-receiver' -- package.json` returns that
  one commit with no later removal. The controllers do register a push token
  with the vendor API (`pushType: 'GCM'`, plus `GCMSenderID` constants), but
  that is the _registration_ half and it uses `got`; nothing ever opened a
  channel to receive. Tom's ruling on #24: "No current plans to receive push
  notifications, so it can go." One line plus the regenerated lockfile, no
  source change, because there is no source (issue #24).
- **Measured on a real `npm ci --omit=dev`, not by walking the lockfile.** The
  production install goes **166 packages to 97** (and 141 top-level
  `node_modules` directories to 88) -- a delta of **-69**, which is 42% of the
  production tree. #24's own body quotes the same -69 but states the absolutes
  as 160 -> 91; both figures were six low, because a lockfile walk and an
  actual install do not count the same set. The `-69` and the prod+dev
  898 -> 843 both reproduce exactly.
- **Four deprecation warnings go, not three, and one stays that the ticket
  never mentioned.** Captured from `npm ci --omit=dev` before and after:
  `request@2.88.2`, `request-promise@4.2.6`, `har-validator@5.1.5` and
  `uuid@3.4.0` all disappear. **`prebuild-install@7.1.3` remains** -- it is a
  `better-sqlite3` build-time dependency and has nothing to do with
  `push-receiver`, so a production install is quieter but not silent. Worth
  knowing before reading the next quiet-install claim.
- No version churn in the lockfile: zero added `"version"` or `"resolved"`
  lines, and `npm ci --dry-run` resolves cleanly. The 44 insertions are
  `"dev": true` markers on the 14 packages that remain reachable from
  `devDependencies`, plus re-hoisted `integrity` lines.

## 2026-10-12

- **The Canadian arm no longer disables TLS certificate verification
  process-wide.** Both Canadian request paths set
  `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` before their `fetch` call,
  and nothing restored it — so once either ran, every later HTTPS call anything
  in the process made skipped certificate verification for the life of that
  process, including the US Bluelink calls `monitor.ts` makes hourly and the
  outdoor-temperature `fetch` in `monitor-helpers.ts`, which carries no
  dispatcher of its own. The per-request undici `Agent` in the same request
  options -- fifteen lines below each assignment, not four as #37 and #32 both
  say -- already did the same relaxation scoped to the one request, so this is a
  deletion rather than a rewrite. Latent, not live: `BLUELINK_REGION`
  defaults to `US` and nothing selects `CA`, so the lines never executed in the
  deployment — they did execute on any node >= 21 running the test suite
  (issue #37).
- Add `checks.trans_cond`, populated from the raw payload's `transCond` via the
  parsed status's new optional `chassis.transmissionCondition`. Migrated in
  place with the same idempotent `ALTER TABLE`; existing rows keep a null.
  Stored as 1 / 0, with **null reserved for "the car never reported it"** —
  `transCondOrNull` refuses non-booleans rather than coercing them, because the
  field arrives through an `as VehicleStatus` cast and a truthy `'false'` string
  would otherwise be recorded as a reading nobody gave. Costs no extra API
  call: `status({ parsed: true })` throws the raw body away, so the value is
  derived in the American parser from the response the hourly check already
  makes (issue #23).
- **Nothing alerts on it, deliberately.** #23 asked to flag the field "if it
  turns on"; it is already on. A read-only probe of the live car on 2026-10-12
  measured `transCond=true` while every fault indicator was clear, and all four
  status mocks agree — so an alert on `true` would fire every hour. The vendor
  documents nothing about the field, so the column exists to find out whether it
  ever moves. The value is also logged to `cron.log` each run, since a column
  nothing surfaces is a history nobody reads.
- `status-json` is **unchanged**: `trans_cond` is deliberately not in the wire
  contract, which the exhaustive `toEqual` in `__tests__/status-json.spec.ts`
  now pins with a non-null fixture.

## 2026-10-11

- **Two-stage Dockerfile.** The runtime image no longer carries the dev
  toolchain. A `deps` stage runs `npm ci --omit=dev` with `python3 make g++`
  available; the runtime stage installs only `cron` and copies the dev-free
  tree across. Measured on the live plexpi image before the change: 1.22 GB,
  458 top-level `node_modules` directories, with `jest`, `rollup`, `eslint`,
  `typescript` and `prettier` in the runtime filesystem alongside `python3`,
  `make` and `g++`. After: **266 MB, 158 directories, none of those present.**
  `better-sqlite3`'s native addon loads and does a real SQLite roundtrip under
  the slimmed tree, and both `monitor.ts` and `status-json.ts` run (issue #25).
- **Add `.dockerignore` — this is a credential fix, not hygiene.** `COPY . .`
  ran with no `.dockerignore` in the repo at all, so every build baked
  `/app/.env` into an image layer: 460 bytes, dated Apr 10 2026, carrying
  `BLUELINK_USERNAME`, `BLUELINK_PASSWORD`, `BLUELINK_PIN` and the ntfy
  credentials. `docker-compose.yml` mounts the real file over it at runtime, so
  it never surfaced; `docker save` and `docker history` read it regardless. The
  new file is an **allow-list** — it denies everything and re-admits only what
  the runtime needs, so a new secret at the repo root is excluded by default
  rather than on somebody remembering. Excluding `node_modules` is load-bearing
  too: the runtime stage copies a dev-free tree from `deps` and `COPY . .` runs
  after it, so a host `node_modules` in the context would overwrite it.
  **The fail-closed guarantee holds at the repo root and inside `deployment/`,
  and NOT inside `src/`** — `!src` re-admits the whole library, so a new file
  there ships unless its name ends in `.env`. The `.dockerignore` header says so
  in those words.
- **Two corrections to that allow-list, both found by review and both measured
  against real BuildKit rather than argued.** (1) `!deployment` admitted the
  whole directory, so `deployment/README.md` shipped and any future
  `deployment/<secret>` would have; it is now `!deployment/crontab` +
  `!deployment/entrypoint.sh`. The reason the broad form gave for itself —
  that per-file re-inclusion under an excluded parent is "a BuildKit
  implementation detail" — is simply false; it is the documented `!` exception
  and a scratch context proves it on docker 29.4. (2) `**/` means "zero or more
  directory levels", so `**/.env` never matched a name merely _ending_ in
  `.env`: `src/a.env` shipped. Added `**/*.env`, isolated by re-running the
  narrowed context without it.
- **`__tests__/docker-image.spec.ts` grew to 12 tests, and its outside control
  is now a deep listing.** Three test-quality fixes from the same review:
  `compilePattern` compiled `**/` to `.*` where moby uses
  `((.*/)|([^/]*))` — a fail-open divergence invisible to every assertion in
  the file, because the four cases it checked are correct under either
  compilation; the observed-listing control was ten _top-level_ entries, so
  `isExcluded` was only ever called with single-segment paths and the two rules
  the file names (ancestor, last-match-wins) were graded solely against its own
  synthetic cases; and a reachability assertion re-derived its expectation from
  its own input, so only a duplicate entry could have failed it. There is now a
  `matches BuildKit's own verdict` test whose every row is an observed
  `docker build` outcome, including the four files that shipped under the old
  shape.
- **`tsx` moves from `devDependencies` to `dependencies`.** The crontab runs
  `npx tsx monitor.ts` and plexpi's parsons-pulse fuel producer runs
  `docker exec bluelinky-fuel-monitor npx tsx /app/status-json.ts`, so
  `--omit=dev` would otherwise strip the interpreter both of them need. Keeping
  the invocation on `tsx` rather than switching to a compiled `dist/` entry also
  keeps the change inside this repo: the producer's command lives in homelab's
  `ansible/group_vars/plexpi/vars.yml`, and changing it would need a lockstep
  deploy with whichever side lands first broken until the other does.
  **Two costs of that trade, neither of which the issue priced.** It forfeits
  #25's own third promised benefit — "a stale-`tsx` surprise can no longer break
  the hourly job" — because `tsx` is still resolved at runtime, just from a
  different section. And this repo is a published npm library, so every consumer
  of `bluelinky` now installs `tsx` + `esbuild` for a transpiler they never
  call. No release has been cut since, so nothing has shipped; if the downstream
  cost matters more than the cross-repo coupling, the remedy is the `dist/`
  route the issue proposed, not a narrower dependency entry.
- **Drop `RUN npm run build || true`.** Nothing in the container read the
  `dist/` it produced — `monitor.ts` imports `./src/index.ts` and
  `status-json.ts` imports `./src/status-json.ts`, both directly through tsx —
  and the `|| true` swallowed failures. The published-library build is
  unaffected; `npm run build` still exists, `ci.yaml`'s `build` job still runs it
  on every push, and the publish path still runs it via `prepublishOnly`.
- **`--production=false` → `--omit=dev`.** The old flag is the npm 6 spelling,
  accepted with a deprecation warning, and it asked for behaviour npm already
  had: devDependencies install by default unless `NODE_ENV=production`, which
  nothing here sets. It was defending against nothing while reading like a
  decision.
- Add `__tests__/docker-image.spec.ts` (11 tests). It asserts on the Dockerfile
  and the build context — the inputs that decide image content — rather than on
  `npm ls --omit=dev`, because that query answers a different question: run
  against the live 1.22 GB image with every dev tool present it printed exactly
  the six runtime dependencies, so issue #25's second success criterion was
  already true of the broken image. The suite evaluates `.dockerignore` with
  Docker's last-match-wins and ancestor rules and grades its prediction against
  an **observed** `ls -A /app` from the built image, so the reimplementation is
  answerable to something outside its own assertions. 21/21 mutants killed
  across deletion, comment-out, addition, negation, repositioning and structural
  axes, including a crontab switched to `npx ts-node` (a devDependency) and a
  second literal `FROM` defeating the single-base `ARG`.
- **No `# syntax=docker/dockerfile:1` directive.** An earlier draft of this
  change added one; it makes every cold build fetch a frontend image from Docker
  Hub, on a box whose whole point is that an unattended `docker compose up -d --build` works. The only BuildKit feature here is the cache mount, and docker
  29.4's built-in frontend honours it — measured `--no-cache` both ways, same
  266 MB image, byte-identical file set.
- Node 20 stays pinned, deliberately and now with a test saying so.
  `canadian.controller.ts` and `canadian.vehicle.ts` both branch on
  `process.versions.node >= 21`; plexpi's container reports v20.20.2, so
  production runs the `got` arm, which is also the arm CI pins. Node 20 is past
  end-of-life and the pin should move, but that is a production transport switch
  and issue #32 lists four behavioural divergences between the arms — it wants
  its own change, behind #30 and #32, with the switch as the headline rather
  than as a rider on an image refactor.

## 2026-10-08

- Move the tracked compose file from `deployment/docker-compose.yml` to the
  checkout root as `docker-compose.yml`, with root-relative `context: .` and
  `./.env`. Compose takes the project name — and so the `bluelinky_fuel-state`
  volume holding the alert state and the SQLite history — from the directory
  the compose file sits in, which `-f deployment/...` does not change. A
  `deployment/`-relative deploy mounts an empty `deployment_fuel-state`
  instead; plexpi has both volumes today, the second one an orphan left by this
  repo's own old instructions (issue #18).
- Fix `deployment/README.md`: all five `~/fuelbot` references →
  `~/bluelinky` (no such directory has ever existed on the box),
  `origin/master` → `origin/main`, `docker-compose` → `docker compose` (plexpi
  has the plugin and no v1 binary), and the crontab examples now name
  `monitor.ts` — the script the tracked crontab actually runs — instead of
  `monitor-fuel.ts`. Adds the one-time switchover the box needs, because the
  new tracked `docker-compose.yml` lands on the path an untracked file already
  occupies and `git pull` refuses to overwrite it.
- Fix `WHATS_FUEL.md`'s file index, which linked the now-moved
  `deployment/docker-compose.yml`, and its deploy step, which said
  `docker-compose up -d`.
- `TZ=UTC` is a no-op for every timestamp the _monitor_ emits — those all go
  through `toISOString()` — and a change for `src/logger.ts`, whose winston
  format renders in local time and so only reaches `cron.log` under
  `LOG_LEVEL=debug`. It moves those to UTC, which is the direction we want.
- Point the README's itguy `compose_dir` at `/home/pi/bluelinky` rather than
  `/home/pi/bluelinky/deployment`.
- Add `__tests__/deploy-docs.spec.ts`, which fails if the compose file moves
  back, grows a `../` path, loses `TZ=UTC`, if a deploy command in either
  README reaches into `deployment/` or invokes `docker-compose`, if
  `origin/master` returns, if a `fuelbot` checkout path reappears anywhere
  tracked, or if the documented schedule drifts off the tracked crontab.

## 2026-10-07

- Fix `monitor-fuel.ts`: its three `sendAlert` calls omitted the `kind`
  discriminant, so `alert-backends.ts` took its TPMS arm and every fuel alert
  rendered as `Tire Pressure Warning` before throwing in
  `formatWheels(undefined)`. Not reachable from the deployed entry point --
  `deployment/crontab` and `entrypoint.sh` both run `monitor.ts`, which passes
  `kind` everywhere -- but `deployment/README.md` documents `monitor-fuel.ts` as
  a live invocation, so anyone following the docs hit it (issue #19).
- Both alert backends now dispatch on an explicit `kind === 'tpms'` and refuse
  anything else with `Unknown alert kind: <kind>`. The old `else`-is-TPMS arm
  was reached by _any_ non-`'fuel'` message: one carrying `wheels` rendered
  silently as a tire alert, which no crash protected against. The refusal takes
  a `never`, so a future member of `AlertMessage` that a backend forgets to
  handle is a compile error at the call site rather than a wrong notification.
- Add `checks.battery_12v_pct`, populated from `status.engine.batteryCharge12v`
  (`battery.batSoc`) — the 12V starter battery's state of charge, which the car
  has always reported and we never stored. Migrated in place with the same
  idempotent `ALTER TABLE`; existing rows keep a null and are never emitted as a
  reading. A reported **0** is stored as 0 (issue #16).
- `status-json` emits two new **optional** keys, omitted rather than nulled when
  unknown: `battery_12v_percent`, and `tire_pressure_warning` with the four
  wheel lamps plus the dash master lamp as booleans. `REQUIRED_STATUS_FIELDS` is
  unchanged, so the producer boundary deploys in either order.
- The tire lamps are read **by** the newest check's id rather than as "the newest
  TPMS row", which were two different polls whenever the newest check had no
  TPMS row. `monitor.ts` writes the check and its TPMS row in one transaction so
  that window no longer opens on a crash.
- Reading the tire lamps cannot cost the required fields: a missing or corrupt
  `tpms_readings` omits `tire_pressure_warning` and nothing else. (A design
  property of the new read, not a fix — the old `status-json` never touched that
  table.) The failure mode it does change: a `tpms_readings` insert that fails
  now rolls its check back, so `status-json` serves the previous hour's range
  rather than this hour's range with no tire state.

## 2026-09-22

- Add `npm run status-json`: one JSON object (`vehicle`, `range_miles`,
  `reported_at`) read from the local SQLite history, for parsons-pulse's fuel
  producer (`FUEL_STATUS_COMMAND`). No extra Hyundai call; opens read-only.
- Add `checks.car_reported_at`, populated from `status.lastupdate`, so the
  history records when the **car** last reported and not only when the monitor
  ran. Migrated in place with an idempotent `ALTER TABLE`; the 3787 existing
  rows keep a null there and are never emitted as a reading.
- Fix the `compose_dir` in README's itguy block: the checkout is
  `/home/pi/bluelinky`, not `/home/pi/fuelbot` (issue #14).

## 2026-04-16

- Fix TypeScript build error: annotate `result` as `string[]` in `newlyLitWheels` so `allLamps` push passes type-check (issue #7, PR #6 CI fix)

## 2026-04-06

- Add CHANGELOG.md and Dispatch project file (first-class project alignment)

## 2026-02-09 (Phase 5 — Production Deployment)

- Replace pluggable alert backends with ntfy; fix cron PATH
- Created Dockerfile for self-contained deployment
- Built deployment/docker-compose.yml for easy container management
- Added deployment/crontab with hourly scheduling
- Created deployment/entrypoint.sh with credential validation
- Configured Docker health checks and auto-restart
- Set up state persistence across container restarts

## 2026-02-09 (Phase 4 — SMS Integration)

- Built alert-backends.ts with AWS SNS and T-Mobile email-to-SMS backends
- Added multi-recipient SMS support
- Added TEST_ALERT environment variable for forcing test alerts
- Successfully tested SMS delivery with actual Twilio/SNS account

## 2026-02-09 (Phase 3 — Docker Deployment)

- Created Dockerfile and deployment/docker-compose.yml
- Added hourly cron schedule via deployment/crontab
- All logs contained within container; state persists across restarts

## 2026-02-09 (Phase 2 — Monitoring Logic)

- Built monitor-fuel.ts with intelligent alert logic
- Dual thresholds: 50 miles (low) and 15 miles (critical)
- Alert deduplication via .fuel-alert-state.json
- Smart reset: alerts clear when fuel goes above 50 miles
- Migrated credentials to environment variables

## 2026-02-09 (Phase 1 — Basic Communication)

- Created get-fuel-level.ts to retrieve fuel/range data from Bluelink API
- Successfully authenticated with Hyundai Bluelink API (US region)
- Confirmed: 330 miles total range retrieved from 2020 Santa Fe
