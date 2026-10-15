# Bluelinky Fuel Monitor -- deployment image for plexpi (linux/arm64, 905 MB RAM).
#
# TWO STAGES, and the split is about image CONTENT rather than build speed.
# Measured on the live image on 2026-10-11, before this change: 1.22 GB, 458
# top-level node_modules directories, and `jest`, `rollup`, `eslint`,
# `typescript` and `prettier` all present in the runtime filesystem alongside
# `python3`, `make` and `g++`. The runtime list was six packages at that
# measurement; this change took it to seven by promoting `tsx`, issue #32 took
# it back to six by removing `undici`, and issue #24 takes it to five by
# removing `push-receiver`.
#
# What this does NOT fix, so nobody reads a speed promise into it: the `npm ci`
# layer's cache key is the CONTENT of package.json and package-lock.json, and
# `npm ci` requires both. The 13-minute install on 2026-10-10 was NOT a lockfile
# change -- PR #20 touched `package.json` only (+1 -0), and at that point the
# lockfile had not moved since `98ab73c` on 2026-04-15. (It has moved since:
# `10fb15e`, PR #29, -473 lines, 2026-10-11. So the next build after that merge
# re-runs the install for a reason unrelated to this change -- don't read it as
# this layout failing.) Any one-line edit to package.json -- a new npm script, a
# version bump -- still invalidates the install, in this layout exactly as in the
# old one. The npm cache mount below is what softens that; building the image off
# this box entirely is what would remove it.
#
# Also NOT fixed, and the plan listed it as a benefit: "a stale-`tsx` surprise
# can no longer break the hourly job". Keeping the crontab on `tsx` forfeits
# that outright -- `tsx` is still resolved at runtime, just from `dependencies`
# now. See the note on the COPY below for why that trade was taken.

ARG NODE_IMAGE=node:20-slim

# ---------------------------------------------------------------------------
# deps -- resolve and compile the RUNTIME dependency tree, then be discarded.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps

# `better-sqlite3` is a Node-API native addon. It publishes prebuilds and npm
# fetches one when the ABI/arch matches, but falls back to compiling from source
# when it does not -- which needs a toolchain, and on this box is minutes. The
# toolchain lives here so a missing prebuild degrades to a slow build instead of
# a failed one, and the runtime image still never sees a compiler.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests only, so this layer and the install below survive a source edit.
COPY package.json package-lock.json ./

# `--omit=dev`, not `--production=false`. The old flag is the npm 6 spelling,
# accepted with a deprecation warning, and it asked for the behaviour npm
# already had: devDependencies install by default unless NODE_ENV=production,
# which nothing here sets. So it was defending against nothing while reading
# like a deliberate choice.
#
# The cache mount keeps npm's tarball cache across builds, so a package.json
# edit re-runs the resolve against a warm cache rather than re-downloading the
# tree. Needs BuildKit, which both boxes have -- but they are no longer the
# same version, and this line used to say they were. Re-measured 2026-10-13:
# plexpi is docker 29.4.3 / buildx 0.33.0, this Mac is 29.8.2 / 0.37.2. The
# stale "both 29.4" reading got copied into a test docblock as an observed
# provenance figure before review caught it (issue #40), so: read it off
# `docker version`, do not quote this comment.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---------------------------------------------------------------------------
# runtime -- cron, the dev-free dependency tree, and the TypeScript sources.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE}

# cron only. No python3/make/g++: nothing in the runtime image compiles.
RUN apt-get update && \
    apt-get install -y --no-install-recommends cron && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# No `# syntax=docker/dockerfile:1` directive above, deliberately. It would
# make every cold build fetch a frontend image from Docker Hub, on a box whose
# whole point is that an unattended `docker compose up -d --build` works. The
# only thing here that needs BuildKit is the cache mount, and the built-in
# frontend honours it on both versions above: measured `--no-cache` both ways
# on 29.4, same 266 MB image, byte-identical file set, `RUN --mount=type=cache`
# executed.

# The dev-free tree, including better-sqlite3's resolved native binding.
COPY --from=deps /app/node_modules ./node_modules

# Sources. `.dockerignore` is an allow-list, so this copies the entrypoints,
# src/ and deployment/ and NOT node_modules (which would overwrite the line
# above), .git, dist/, the test suite, or `.env`.
#
# There is deliberately no `npm run build` step. The old image ran
# `npm run build || true` to produce dist/, and nothing in the container ever
# read it: `monitor.ts` imports `./src/index.ts` and `status-json.ts` imports
# `./src/status-json.ts`, both directly, both through tsx. The `|| true` also
# meant a broken build shipped silently.
COPY . .

# Cron schedule. `deployment/crontab` runs `npx tsx monitor.ts`, which is why
# `tsx` is a RUNTIME dependency in package.json rather than a devDependency --
# `--omit=dev` would otherwise strip the interpreter the scheduled job needs.
#
# Keeping the crontab on tsx rather than switching it to a compiled dist/ entry
# is a scope decision, not an oversight: plexpi's parsons-pulse fuel producer
# runs `docker exec bluelinky-fuel-monitor npx tsx /app/status-json.ts`
# (homelab `ansible/group_vars/plexpi/vars.yml`), so changing the invocation
# here requires a homelab change deployed in lockstep, with whichever side lands
# first broken until the other does. See issue #25.
COPY deployment/crontab /etc/cron.d/fuel-monitor
RUN chmod 0644 /etc/cron.d/fuel-monitor && \
    crontab /etc/cron.d/fuel-monitor

RUN mkdir -p /var/log/fuel-monitor /app/state

COPY deployment/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
