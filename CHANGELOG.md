# Changelog

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
