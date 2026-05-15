/**
 * Bluelinky combined vehicle monitor — fuel + TPMS + history.
 *
 * Runs once per invocation (hourly cron). One vehicle.status() call drives
 * both fuel-level checks and tire-pressure-warning-lamp checks. Temperature
 * is fetched from Open-Meteo for correlation and logged alongside readings.
 * Fill-up events trigger a vehicle.odometer() call for mpg tracking.
 *
 * State files (in /app/state/):
 *   .fuel-alert-state.json   — alert deduplication (low/critical sent flags)
 *   vehicle-monitor.db       — SQLite history (checks, tpms_readings, alerts)
 *
 * Required env vars:
 *   BLUELINK_USERNAME, BLUELINK_PASSWORD, BLUELINK_PIN
 *
 * Optional env vars:
 *   BLUELINK_BRAND          (default: hyundai)
 *   BLUELINK_REGION         (default: US)
 *   HOME_LAT / HOME_LON     (Dover NH: 43.2419, -70.9164458) — for temp lookup
 *   FUEL_FILLUP_THRESHOLD   (default: 20) — miles range-increase to detect fill-up
 *   ALERT_BACKEND           (console | ntfy) — default: console
 *   TEST_ALERT              (low | critical | tpms) — forces an alert for testing
 */

import BlueLinky from './src/index.ts';
import * as fs from 'fs';
import * as path from 'path';
import { createAlertBackend, AlertBackend } from './alert-backends.ts';
import { VehicleDb, defaultDbPath } from './src/vehicle-db.ts';
import {
  fetchOutdoorTempF,
  newlyLitWheels,
  tpmsSeverity,
  TpmsLamps,
  TpmsAlertDedup,
} from './src/monitor-helpers.ts';
import { Brand, VehicleStatus } from './src/interfaces/common.interfaces.ts';
import { REGION } from './src/constants.ts';

// ── Credentials ──────────────────────────────────────────────────────────────

const username = process.env.BLUELINK_USERNAME;
const password = process.env.BLUELINK_PASSWORD;
const pin = process.env.BLUELINK_PIN;
const brand = (process.env.BLUELINK_BRAND || 'hyundai') as Brand;
const region = (process.env.BLUELINK_REGION || 'US') as REGION;

if (!username || !password || !pin) {
  console.error('❌ Missing required environment variables:');
  if (!username) console.error('  - BLUELINK_USERNAME');
  if (!password) console.error('  - BLUELINK_PASSWORD');
  if (!pin) console.error('  - BLUELINK_PIN');
  process.exit(1);
}

// ── Configuration ─────────────────────────────────────────────────────────────

const FUEL_THRESHOLD_LOW = 50; // miles
const FUEL_THRESHOLD_CRITICAL = 15;
const FILLUP_THRESHOLD = parseInt(process.env.FUEL_FILLUP_THRESHOLD ?? '20', 10);

const HOME_LAT = process.env.HOME_LAT ?? '43.2419';
const HOME_LON = process.env.HOME_LON ?? '-70.9164458';

const STATE_FILE = path.join(process.cwd(), 'state', '.fuel-alert-state.json');
const DB_PATH = process.env.VEHICLE_DB_PATH ?? defaultDbPath();
const TEST_ALERT = process.env.TEST_ALERT?.toLowerCase();

// ── Alert state (dedup) ───────────────────────────────────────────────────────

interface AlertState {
  alert50Sent: boolean;
  alert15Sent: boolean;
  lastRange: number;
  lastCheck: string;
  tpmsAlertSent: TpmsAlertDedup;
}

function loadState(): AlertState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      // Back-fill tpmsAlertSent for state files written before this feature
      if (!raw.tpmsAlertSent) {
        raw.tpmsAlertSent = {
          frontLeft: false,
          frontRight: false,
          rearLeft: false,
          rearRight: false,
          allLamps: false,
        };
      }
      // Back-fill allLamps field for state files missing it
      if (raw.tpmsAlertSent.allLamps === undefined) {
        raw.tpmsAlertSent.allLamps = false;
      }
      return raw as AlertState;
    }
  } catch (err) {
    console.error('Error loading state file:', err);
  }
  return {
    alert50Sent: false,
    alert15Sent: false,
    lastRange: 0,
    lastCheck: new Date().toISOString(),
    tpmsAlertSent: {
      frontLeft: false,
      frontRight: false,
      rearLeft: false,
      rearRight: false,
      allLamps: false,
    },
  };
}

function saveState(state: AlertState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Error saving state file:', err);
  }
}

// Pure helpers (newlyLitWheels, tpmsSeverity, fetchOutdoorTempF, TpmsLamps, TpmsAlertDedup)
// are imported from src/monitor-helpers.ts above.

// ── Main monitor ──────────────────────────────────────────────────────────────

async function monitor(): Promise<void> {
  console.log('🔍 Checking vehicle status...\n');

  const alertBackend: AlertBackend = createAlertBackend();
  const db = new VehicleDb(DB_PATH);

  // Ensure state directory exists
  const stateDir = path.dirname(STATE_FILE);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const client = new BlueLinky({ username, password, brand, region, pin });

  client.on('ready', async vehicles => {
    try {
      const vehicle = vehicles[0];
      const state = loadState();
      const ts = new Date().toISOString();

      // One API call covers both fuel + TPMS
      const rawStatus = await vehicle.status({ refresh: false, parsed: true });
      if (!rawStatus) {
        console.error('❌ Failed to get vehicle status');
        process.exit(1);
      }

      const status = rawStatus as VehicleStatus;
      const currentRange = status.engine.range;
      const tpmsLamps = status.chassis.tirePressureWarningLamp;
      const vehicleName = vehicle.name();

      // TEST MODE ──────────────────────────────────────────────────────────────
      if (TEST_ALERT) {
        if (TEST_ALERT === 'tpms') {
          await alertBackend.sendAlert({
            kind: 'tpms',
            severity: 'warn',
            wheels: ['frontLeft'],
            vehicleName,
            timestamp: new Date(),
          });
          console.log('✅ Test TPMS alert sent.\n');
        } else {
          const severity = TEST_ALERT === 'critical' ? 'critical' : 'low';
          const range = severity === 'critical' ? 10 : 45;
          await alertBackend.sendAlert({
            kind: 'fuel',
            severity,
            range,
            vehicleName,
            timestamp: new Date(),
          });
          console.log(`✅ Test fuel ${severity} alert sent.\n`);
        }
        db.close();
        process.exit(0);
      }

      // Fetch temperature (non-blocking — null on failure)
      const tempF = await fetchOutdoorTempF(HOME_LAT, HOME_LON);
      console.log(`Alert Backend: ${alertBackend.getName()}`);
      console.log(`Vehicle: ${vehicleName}`);
      console.log(`Current Range: ${currentRange} miles`);
      console.log(`Previous Range: ${state.lastRange} miles`);
      console.log(`Temperature: ${tempF !== null ? `${tempF}°F` : 'unavailable'}`);
      console.log(
        `TPMS: FL=${tpmsLamps.frontLeft} FR=${tpmsLamps.frontRight} RL=${tpmsLamps.rearLeft} RR=${tpmsLamps.rearRight} ALL=${tpmsLamps.all}\n`
      );

      // ── Fill-up detection ──────────────────────────────────────────────────
      const isFillup = state.lastRange > 0 && currentRange > state.lastRange + FILLUP_THRESHOLD;
      let odometerMi: number | null = null;

      if (isFillup) {
        console.log(`⛽ Fill-up detected! Range rose ${currentRange - state.lastRange} miles.`);
        try {
          const odo = await vehicle.odometer();
          if (odo && typeof odo === 'object' && 'value' in odo) {
            odometerMi = (odo as { value: number }).value;
            console.log(`   Odometer: ${odometerMi} miles`);
          }
        } catch (err) {
          console.warn('   Could not fetch odometer:', err);
        }
        // Clear fuel dedup on fill-up so low-fuel alerts can fire again next cycle
        state.alert50Sent = false;
        state.alert15Sent = false;
      }

      // ── Write check to DB ──────────────────────────────────────────────────
      const checkId = db.insertCheck({
        ts,
        vehicle_name: vehicleName,
        range_mi: currentRange,
        temp_f: tempF,
        is_fillup: isFillup ? 1 : 0,
        odometer_mi: odometerMi,
      });

      db.insertTpms({
        check_id: checkId,
        ts,
        front_left: tpmsLamps.frontLeft ? 1 : 0,
        front_right: tpmsLamps.frontRight ? 1 : 0,
        rear_left: tpmsLamps.rearLeft ? 1 : 0,
        rear_right: tpmsLamps.rearRight ? 1 : 0,
        all_lamps: tpmsLamps.all ? 1 : 0,
      });

      // ── Fuel alerts ────────────────────────────────────────────────────────
      if (currentRange > FUEL_THRESHOLD_LOW) {
        if (state.alert50Sent || state.alert15Sent) {
          console.log('✅ Fuel level back above 50 miles — clearing alerts');
        }
        state.alert50Sent = false;
        state.alert15Sent = false;
      }

      if (currentRange <= FUEL_THRESHOLD_CRITICAL && !state.alert15Sent) {
        await alertBackend.sendAlert({
          kind: 'fuel',
          severity: 'critical',
          range: currentRange,
          vehicleName,
          timestamp: new Date(),
        });
        state.alert15Sent = true;
        db.insertAlert({
          ts,
          alert_type: 'fuel_critical',
          details: JSON.stringify({ range: currentRange }),
        });
      }

      if (
        currentRange <= FUEL_THRESHOLD_LOW &&
        currentRange > FUEL_THRESHOLD_CRITICAL &&
        !state.alert50Sent
      ) {
        await alertBackend.sendAlert({
          kind: 'fuel',
          severity: 'low',
          range: currentRange,
          vehicleName,
          timestamp: new Date(),
        });
        state.alert50Sent = true;
        db.insertAlert({
          ts,
          alert_type: 'fuel_low',
          details: JSON.stringify({ range: currentRange }),
        });
      }

      if (isFillup) {
        db.insertAlert({
          ts,
          alert_type: 'fillup',
          details: JSON.stringify({
            range: currentRange,
            prev_range: state.lastRange,
            odometer_mi: odometerMi,
          }),
        });
      }

      // ── TPMS alerts ────────────────────────────────────────────────────────
      const newWheels = newlyLitWheels(tpmsLamps, state.tpmsAlertSent);
      if (newWheels.length > 0) {
        const severity = tpmsSeverity(newWheels, tpmsLamps.all);
        // Filter out the 'allLamps' sentinel — it's used for dedup only, not a wheel name
        const displayWheels = newWheels.filter(w => w !== 'allLamps');
        await alertBackend.sendAlert({
          kind: 'tpms',
          severity,
          wheels: displayWheels.length > 0 ? displayWheels : ['all wheels'],
          vehicleName,
          timestamp: new Date(),
        });
        // Mark as sent for each newly-lit wheel / flag
        for (const w of newWheels) {
          if (w === 'allLamps') {
            state.tpmsAlertSent.allLamps = true;
          } else {
            state.tpmsAlertSent[w as 'frontLeft' | 'frontRight' | 'rearLeft' | 'rearRight'] = true;
          }
        }
        db.insertAlert({
          ts,
          alert_type: severity === 'critical' ? 'tpms_critical' : 'tpms_warn',
          details: JSON.stringify({ wheels: newWheels }),
        });
      }

      // Clear TPMS dedup for any wheels/flags that are now off
      const wheels: Array<'frontLeft' | 'frontRight' | 'rearLeft' | 'rearRight'> = [
        'frontLeft',
        'frontRight',
        'rearLeft',
        'rearRight',
      ];
      for (const w of wheels) {
        if (!tpmsLamps[w]) {
          state.tpmsAlertSent[w] = false;
        }
      }
      if (!tpmsLamps.all) {
        state.tpmsAlertSent.allLamps = false;
      }

      // ── Persist state ──────────────────────────────────────────────────────
      state.lastRange = currentRange;
      state.lastCheck = ts;
      saveState(state);

      console.log('\n📊 Alert Status:');
      console.log(`   50-mile fuel: ${state.alert50Sent ? '🔴 Sent' : '🟢 Clear'}`);
      console.log(`   15-mile fuel: ${state.alert15Sent ? '🔴 Sent' : '🟢 Clear'}`);
      console.log(`   TPMS FL: ${state.tpmsAlertSent.frontLeft ? '🔴 Sent' : '🟢 Clear'}`);
      console.log(`   TPMS FR: ${state.tpmsAlertSent.frontRight ? '🔴 Sent' : '🟢 Clear'}`);
      console.log(`   TPMS RL: ${state.tpmsAlertSent.rearLeft ? '🔴 Sent' : '🟢 Clear'}`);
      console.log(`   TPMS RR: ${state.tpmsAlertSent.rearRight ? '🔴 Sent' : '🟢 Clear'}`);
      console.log(`\n✅ Monitoring complete\n`);

      db.close();
      process.exit(0);
    } catch (error) {
      console.error('❌ Error:', error);
      db.close();
      process.exit(1);
    }
  });

  client.on('error', err => {
    console.error('❌ Login error:', err);
    process.exit(1);
  });
}

monitor();
