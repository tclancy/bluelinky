import BlueLinky from './src/index.ts';

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

const client = new BlueLinky({
  username,
  password,
  brand,
  region,
  pin,
});

client.on('ready', async (vehicles) => {
  try {
    const vehicle = vehicles[0]; // or use client.getVehicle(config.vin)

    console.log(`Vehicle: ${vehicle.name()}`);
    console.log(`VIN: ${vehicle.vin()}`);

    // Get cached status (doesn't drain 12V battery)
    const status = await vehicle.status({
      refresh: false,  // Use server cache
      parsed: true     // Get nicely formatted data
    });

    if (status) {
      console.log('\n=== Fuel/Range Status ===');
      console.log(`Total Range: ${status.engine.range} miles`);
      if (status.engine.rangeGas) {
        console.log(`Gas Range: ${status.engine.rangeGas} miles`);
      }
      if (status.engine.rangeEV) {
        console.log(`EV Range: ${status.engine.rangeEV} miles`);
      }
      console.log(`Last Updated: ${status.lastupdate}`);
    } else {
      console.error('Failed to get vehicle status');
    }
  } catch (error) {
    console.error('Error:', error);
  }

  process.exit(0);
});

client.on('error', (err) => {
  console.error('Login error:', err);
  process.exit(1);
});
