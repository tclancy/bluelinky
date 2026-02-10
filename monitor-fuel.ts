import BlueLinky from './src/index.ts';
import * as fs from 'fs';
import * as path from 'path';
import { createAlertBackend, AlertBackend } from './alert-backends.ts';

// Load credentials from environment variables
const username = process.env.BLUELINK_USERNAME;
const password = process.env.BLUELINK_PASSWORD;
const pin = process.env.BLUELINK_PIN;
const brand = process.env.BLUELINK_BRAND || 'hyundai';
const region = process.env.BLUELINK_REGION || 'US';

// Validate required environment variables
if (!username || !password || !pin) {
  console.error('❌ Missing required environment variables:');
  if (!username) console.error('  - BLUELINK_USERNAME');
  if (!password) console.error('  - BLUELINK_PASSWORD');
  if (!pin) console.error('  - BLUELINK_PIN');
  console.error('\nSet these in your environment or .env file');
  process.exit(1);
}

// Fuel thresholds in miles
const THRESHOLD_LOW = 50;
const THRESHOLD_CRITICAL = 15;

// Create alert backend (console for dev, can be switched to SMS via env var)
const alertBackend: AlertBackend = createAlertBackend();

// Test mode - force an alert for testing
const TEST_ALERT = process.env.TEST_ALERT?.toLowerCase();

// State file to track sent alerts
const STATE_FILE = path.join(process.cwd(), '.fuel-alert-state.json');

interface AlertState {
  alert50Sent: boolean;
  alert15Sent: boolean;
  lastRange: number;
  lastCheck: string;
}

// Load alert state from file
function loadState(): AlertState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading state file:', err);
  }

  // Default state if file doesn't exist or can't be read
  return {
    alert50Sent: false,
    alert15Sent: false,
    lastRange: 0,
    lastCheck: new Date().toISOString(),
  };
}

// Save alert state to file
function saveState(state: AlertState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Error saving state file:', err);
  }
}

// Main monitoring logic
async function monitorFuel() {
  console.log('🔍 Checking fuel level...\n');

  const client = new BlueLinky({
    username,
    password,
    brand,
    region,
    pin,
  });

  client.on('ready', async (vehicles) => {
    try {
      const vehicle = vehicles[0];
      const state = loadState();

      // Get current fuel status
      const status = await vehicle.status({
        refresh: false,  // Use cached status
        parsed: true
      });

      if (!status) {
        console.error('❌ Failed to get vehicle status');
        process.exit(1);
      }

      const currentRange = status.engine.range;
      const lastUpdate = status.lastupdate;

      console.log(`Alert Backend: ${alertBackend.getName()}`);
      console.log(`Vehicle: ${vehicle.name()}`);
      console.log(`Current Range: ${currentRange} miles`);
      console.log(`Last Updated: ${lastUpdate}`);
      console.log(`Previous Range: ${state.lastRange} miles\n`);

      // TEST MODE: Force an alert for testing
      if (TEST_ALERT) {
        console.log('🧪 TEST MODE: Forcing alert...\n');

        const testSeverity = TEST_ALERT === 'critical' ? 'critical' : 'low';
        const testRange = testSeverity === 'critical' ? 10 : 45;

        await alertBackend.sendAlert({
          severity: testSeverity,
          range: testRange,
          vehicleName: vehicle.name(),
          timestamp: new Date(),
        });

        console.log(`✅ Test ${testSeverity} alert sent successfully!\n`);
        console.log('(Set TEST_ALERT=low or TEST_ALERT=critical to test different alert types)\n');
        process.exit(0);
      }

      // LOGIC: Clear alerts if fuel is back above 50 miles
      if (currentRange > THRESHOLD_LOW) {
        if (state.alert50Sent || state.alert15Sent) {
          console.log('✅ Fuel level back above 50 miles - clearing all alerts\n');
        }
        state.alert50Sent = false;
        state.alert15Sent = false;
      }

      // LOGIC: Check 15-mile critical threshold
      if (currentRange <= THRESHOLD_CRITICAL && !state.alert15Sent) {
        await alertBackend.sendAlert({
          severity: 'critical',
          range: currentRange,
          vehicleName: vehicle.name(),
          timestamp: new Date(),
        });
        state.alert15Sent = true;
      }

      // LOGIC: Check 50-mile low threshold
      if (currentRange <= THRESHOLD_LOW && currentRange > THRESHOLD_CRITICAL && !state.alert50Sent) {
        await alertBackend.sendAlert({
          severity: 'low',
          range: currentRange,
          vehicleName: vehicle.name(),
          timestamp: new Date(),
        });
        state.alert50Sent = true;
      }

      // Update state
      state.lastRange = currentRange;
      state.lastCheck = new Date().toISOString();
      saveState(state);

      // Status summary
      console.log('📊 Alert Status:');
      console.log(`   50-mile alert: ${state.alert50Sent ? '🔴 Sent' : '🟢 Clear'}`);
      console.log(`   15-mile alert: ${state.alert15Sent ? '🔴 Sent' : '🟢 Clear'}`);
      console.log(`\n✅ Monitoring complete\n`);

      process.exit(0);
    } catch (error) {
      console.error('❌ Error:', error);
      process.exit(1);
    }
  });

  client.on('error', (err) => {
    console.error('❌ Login error:', err);
    process.exit(1);
  });
}

// Run the monitor
monitorFuel();
