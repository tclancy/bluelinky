# Changelog

## 2026-10-07

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
