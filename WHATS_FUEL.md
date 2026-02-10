# What's Fuel? 🚗⛽

## Project Goal

Build an SMS alert system that monitors our 2020 Hyundai Santa Fe's fuel level via the Bluelink API and sends text message alerts when the gas is running low.

## Current Status

### ✅ Phase 1: Basic Communication (COMPLETE)

We can now successfully communicate with the vehicle via Bluelink!

**What We Built:**

- [config.json](config.json) - Credentials for Bluelink API (US region)
- [get-fuel-level.ts](get-fuel-level.ts) - TypeScript script to retrieve fuel/range data
- npm script: `npm run get-fuel` - Quick command to check current fuel level

**Current Capabilities:**

- ✅ Authenticate with Hyundai Bluelink API
- ✅ Retrieve vehicle status (fuel range, last update time)
- ✅ Works with cached data (doesn't drain car's 12V battery)
- ✅ Returns: 330 miles total range as of Feb 9, 2026

**Technical Details:**

- **Vehicle:** 2020 Santa Fe (VIN: 5NMS5CAA6LH196100)
- **Region:** US (api.telematics.hyundaiusa.com)
- **API Library:** Bluelink v10.0.0
- **Runtime:** tsx (ES module compatible TypeScript runner)
- **Data Freshness:** Uses server cache by default (`refresh: false`)

---

### ✅ Phase 2: Threshold Detection & Monitoring (COMPLETE)

We now have smart monitoring with dual thresholds and alert deduplication!

**What We Built:**
- [monitor-fuel.ts](monitor-fuel.ts) - Intelligent fuel monitoring script
- `.fuel-alert-state.json` - State file to track sent alerts (gitignored)
- npm script: `npm run monitor-fuel` - Run the monitoring check

**Features:**
- ✅ Dual threshold system: 50 miles (low) and 15 miles (critical)
- ✅ Alert deduplication - won't spam you with the same alert
- ✅ Smart reset logic - clears alerts when fuel goes back above 50 miles
- ✅ State persistence across runs
- ✅ Clear console output showing alert status
- ✅ Error handling for API failures

**How It Works:**
1. Check current fuel level from Bluelink
2. Load previous alert state from file
3. If range > 50 miles: Clear all alert flags
4. If range ≤ 15 miles AND not alerted: Send CRITICAL alert
5. If range ≤ 50 miles AND not alerted: Send LOW FUEL warning
6. Save updated state to file
7. Show status summary

**Alert Logic:**
- **Above 50 miles**: All clear, no alerts, flags reset
- **Below 50 miles**: One-time "Low Fuel" alert
- **Below 15 miles**: One-time "Critical" alert (overrides 50-mile alert)
- **After refueling**: Flags clear automatically when above 50 miles

---

## Where We're Driving At 🎯

### ✅ Phase 3: Scheduled Monitoring (COMPLETE)

We now have automated scheduled monitoring via Docker and cron!

**What We Built:**
- [Dockerfile](Dockerfile) - Self-contained container with Node.js, npm, and cron
- [deployment/docker-compose.yml](deployment/docker-compose.yml) - Easy container management
- [deployment/crontab](deployment/crontab) - Hourly fuel check schedule
- [deployment/entrypoint.sh](deployment/entrypoint.sh) - Container startup script with validation
- [deployment/README.md](deployment/README.md) - Complete deployment guide

**Features:**
- ✅ Runs every hour automatically (configurable)
- ✅ Completely self-contained (no host dependency leakage)
- ✅ Works on any Linux system with Docker
- ✅ Persists state across container restarts
- ✅ Automatic health checks
- ✅ UTC timestamps for consistency
- ✅ Comprehensive logging
- ✅ Initial validation check before starting cron

**Deployment:**
1. Copy files to Linux server
2. Create .env with credentials
3. Run `docker-compose up -d`
4. Monitor logs with `docker logs -f bluelinky-fuel-monitor`

---

### ✅ Phase 4: SMS Integration (COMPLETE)

SMS alerts are fully implemented and tested!

**What We Built:**
- [alert-backends.ts](alert-backends.ts) - TwilioSMSAlertBackend with multi-recipient support
- Environment variable configuration for Twilio credentials
- Test mode for validating alerts without waiting for low fuel

**Features:**
- ✅ Sends SMS via Twilio API
- ✅ Supports multiple recipients (comma-separated phone numbers)
- ✅ Different message formats for low vs critical alerts
- ✅ Parallel SMS delivery to all recipients
- ✅ Comprehensive error handling
- ✅ Test mode with `TEST_ALERT` environment variable

**Setup:**
1. Create Twilio account (free trial includes $15 credit)
2. Get a Twilio phone number (~$1/month)
3. Add credentials to .env:
   ```env
   ALERT_BACKEND=sms
   TWILIO_ACCOUNT_SID=your_account_sid
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_FROM_PHONE=+15551234567
   TWILIO_TO_PHONE=+15559876543,+15558675309
   ```
4. Test with `npm run test-alert`

**Cost:** ~$0.01 per SMS message

---

### ✅ Phase 5: Deployment & Production (COMPLETE)

Production-ready deployment system is now in place!

**What We Achieved:**
- ✅ Secure credential storage (environment variables, not config.json)
- ✅ Logging and monitoring (cron logs + Docker logs)
- ✅ Alert fatigue prevention (state file prevents duplicate alerts)
- ✅ Graceful degradation (error handling for API failures)
- ✅ Self-contained deployment (Docker isolates all dependencies)
- ✅ Automatic restarts (Docker restart policy)
- ✅ Health checks (Docker healthcheck configuration)

**Architecture:**
```
┌─────────────────────┐
│  Docker Container   │
│  (isolated)         │
│                     │
│  ┌───────────────┐  │
│  │ cron daemon   │  │  Runs every hour
│  │ (hourly)      │  │
│  └───────┬───────┘  │
│          │          │
│          v          │
│  ┌───────────────┐  │
│  │ monitor-fuel  │  │  Check fuel level
│  │ .ts           │  │  Compare thresholds
│  └───────┬───────┘  │
│          │          │
│          v          │
│     Low fuel?       │
│          │          │
│         Yes         │
│          │          │
│          v          │
│  ┌───────────────┐  │
│  │ Twilio SMS    │  │  Send alert
│  │ Backend       │  │
│  └───────────────┘  │
│                     │
└─────────────────────┘
```

**Deployment:**
- See [deployment/README.md](deployment/README.md) for complete guide
- Works on any Linux server with Docker
- No pollution of host system
- Easy to update and maintain

---

## Technical Architecture (Future State)

```
┌─────────────────┐
│  Scheduler      │  (cron/systemd/launchd)
│  (runs hourly)  │
└────────┬────────┘
         │
         v
┌─────────────────┐
│  monitor-fuel   │  Check fuel level
│  .ts            │  Compare to threshold
└────────┬────────┘
         │
         v
    Low fuel? ────No──> Exit (log status)
         │
        Yes
         │
         v
┌─────────────────┐
│  Twilio SMS     │  Send text message
│  API            │  "⚠️ Fuel low: 40 miles"
└─────────────────┘
```

---

## API Notes

### Bluelink Status Response

**Cached Status** (`refresh: false`):
- Uses server's cached data
- Fast response (< 2 seconds)
- Doesn't wake up vehicle
- Safe to call frequently
- Data may be hours old

**Fresh Status** (`refresh: true`):
- Polls vehicle directly
- Slow response (30-60 seconds)
- Drains 12V battery if used too often
- Use sparingly (max once per hour)
- Data is real-time

**Our Approach:** Use cached status for monitoring, only refresh if we need real-time data for critical decisions.

### Data Fields Available

From `vehicle.status({ parsed: true })`:

```typescript
{
  engine: {
    range: 330,              // Total range in miles
    rangeGas?: number,       // Gas-only range (hybrids)
    rangeEV?: number,        // EV range (hybrids)
    charging?: boolean,      // EV charging status
    batteryCharge?: number,  // 12V battery %
    batteryChargeHV?: number,// HV battery % (EVs)
    ignition: boolean,       // Engine running?
  },
  chassis: {
    locked: boolean,
    hoodOpen: boolean,
    trunkOpen: boolean,
    // ... door statuses
  },
  climate: {
    // ... climate control status
  },
  lastupdate: Date          // When data was retrieved
}
```

**For our use case:** We only care about `engine.range` and `lastupdate`.

---

## Development Notes

### Running the Script

```bash
# Check current fuel level
npm run get-fuel

# Debug with the interactive menu
npm run debug
```

### Testing Without Vehicle

The Bluelink API doesn't have a sandbox mode, so we're testing against the real vehicle. To avoid issues:

- Use cached status (we're already doing this)
- Don't call remote commands (lock/unlock/start) unless intentional
- Monitor API response times to detect issues

### Credential Security

**✅ Now Using Environment Variables!**

All credentials are loaded from environment variables for better security:

1. **Copy the example file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your credentials:**
   ```bash
   BLUELINK_USERNAME=your_email@example.com
   BLUELINK_PASSWORD=your_password
   BLUELINK_PIN=1234
   BLUELINK_BRAND=hyundai
   BLUELINK_REGION=US
   ```

3. **The `.env` file is gitignored** - your credentials stay local

**Required Variables:**
- `BLUELINK_USERNAME` - Your Bluelink account email
- `BLUELINK_PASSWORD` - Your Bluelink account password
- `BLUELINK_PIN` - Your 4-digit PIN

**Optional Variables:**
- `BLUELINK_BRAND` (default: `hyundai`)
- `BLUELINK_REGION` (default: `US`)
- `ALERT_BACKEND` (default: `console`, options: `console` | `sms`)
- `TWILIO_*` variables (required if using SMS backend)

---

## Questions to Answer

- [x] What's the ideal low fuel threshold? **Answered:** 50 miles (low) and 15 miles (critical)
- [x] Should we send one alert or reminder alerts? **Answered:** One alert per threshold until refueling
- [ ] How often should we check? (Hourly? Daily?)
- [ ] What should the SMS message say?
- [ ] Do we care about other alerts? (door unlocked, engine on, etc.)

---

## Resources

- **Bluelink Docs:** https://bluelinky.readme.io
- **Bluelink GitHub:** https://github.com/Hacksore/bluelinky
- **Twilio SMS Docs:** https://www.twilio.com/docs/sms
- **Our Plan:** `/Users/tom/.claude/plans/tender-bouncing-flame.md`

---

## Change Log

### 2026-02-09 (Phase 1)
- ✅ Created config.json with Bluelink credentials
- ✅ Built get-fuel-level.ts script
- ✅ Successfully retrieved fuel status: 330 miles range
- ✅ Verified cached API calls work correctly
- ✅ Documented project in WHATS_FUEL.md

### 2026-02-09 (Phase 2)
- ✅ Built monitor-fuel.ts with intelligent alert logic
- ✅ Implemented dual thresholds: 50 miles (low) and 15 miles (critical)
- ✅ Added alert deduplication with state file (.fuel-alert-state.json)
- ✅ Smart reset: alerts clear when fuel goes back above 50 miles
- ✅ Built pluggable alert backend system (ConsoleAlertBackend + TwilioSMSAlertBackend)
- ✅ Migrated to environment variables for credential security
- ✅ Created .env.example template
- ✅ Switched from WhatsApp to SMS for simpler setup
- ✅ Tested monitoring script successfully

### 2026-02-09 (Phase 3 & 4 - SMS & Testing)
- ✅ Implemented TwilioSMSAlertBackend with actual Twilio API integration
- ✅ Added multi-recipient SMS support (comma-separated phone numbers)
- ✅ Installed twilio npm package
- ✅ Fixed ES module import issues (switched to tsx from ts-node)
- ✅ Added TEST_ALERT environment variable for forcing test alerts
- ✅ Created test-alert and test-alert-critical npm scripts
- ✅ Successfully tested SMS delivery with actual Twilio account
- ✅ Verified alerts send to multiple recipients in parallel

### 2026-02-09 (Phase 5 - Deployment)
- ✅ Created Dockerfile for self-contained deployment
- ✅ Built deployment/docker-compose.yml for easy container management
- ✅ Added deployment/crontab with hourly scheduling
- ✅ Created deployment/entrypoint.sh with credential validation
- ✅ Wrote comprehensive deployment/README.md guide
- ✅ Configured Docker health checks and auto-restart
- ✅ Set up state persistence across container restarts
- ✅ Ensured complete isolation (no host dependency leakage)
- ✅ Added initial validation check before starting cron
- ✅ All deployment logs contained within container
