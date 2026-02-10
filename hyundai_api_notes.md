# Hyundai Bluelink API Data Reference

Complete reference of all data available through the Bluelink API.

## Table of Contents

- [Vehicle Status Data](#vehicle-status-data)
- [Location Data](#location-data)
- [Odometer Data](#odometer-data)
- [Trip & Driving History](#trip--driving-history-eu-region)
- [Monthly Reports](#monthly-reports-eu-region)
- [EV Charge Targets](#ev-charge-targets)
- [Raw Status Fields](#raw-status-fields)
- [Usage Examples](#usage-examples)

---

## Vehicle Status Data

**Method:** `vehicle.status({ parsed: true, refresh: false })`

Returns a parsed, structured object with all vehicle information.

### Engine/Power Data

| Field | Type | Description | Notes |
|-------|------|-------------|-------|
| `range` | number | Total range in miles/km | **This is what we use for fuel alerts** |
| `rangeGas` | number | Gas-only range | Hybrid vehicles only |
| `rangeEV` | number | Electric range | Hybrid/EV vehicles only |
| `ignition` | boolean | Engine running status | true = running |
| `accessory` | boolean | Accessory mode status | true = accessory on |
| `charging` | boolean | EV charging status | EVs only |
| `batteryCharge12v` | number | 12V battery percentage | Standard battery |
| `batteryChargeHV` | number | High voltage battery percentage | EVs only |
| `timeToFullCharge` | unknown | Time to full charge | EVs only |
| `plugedTo` | EVPlugTypes | Charging plug type | 0=Unplugged, 1=Fast, 2=Portable, 3=Station |
| `estimatedCurrentChargeDuration` | number | Charge time estimate (current plug) | EVs only |
| `estimatedFastChargeDuration` | number | Fast charge time estimate | EVs only |
| `estimatedPortableChargeDuration` | number | Portable charger time estimate | EVs only |
| `estimatedStationChargeDuration` | number | Station charge time estimate | EVs only |

### Chassis/Security Data

| Field | Type | Description |
|-------|------|-------------|
| `locked` | boolean | Door lock status (true = locked) |
| `hoodOpen` | boolean | Hood status (true = open) |
| `trunkOpen` | boolean | Trunk status (true = open) |
| `openDoors.frontRight` | boolean | Front right door open status |
| `openDoors.frontLeft` | boolean | Front left door open status |
| `openDoors.backLeft` | boolean | Back left door open status |
| `openDoors.backRight` | boolean | Back right door open status |
| `tirePressureWarningLamp.rearLeft` | boolean | Rear left tire pressure warning |
| `tirePressureWarningLamp.frontLeft` | boolean | Front left tire pressure warning |
| `tirePressureWarningLamp.frontRight` | boolean | Front right tire pressure warning |
| `tirePressureWarningLamp.rearRight` | boolean | Rear right tire pressure warning |
| `tirePressureWarningLamp.all` | boolean | Any tire pressure warning |

### Climate Control Data

| Field | Type | Description |
|-------|------|-------------|
| `active` | boolean | Climate control running |
| `steeringwheelHeat` | boolean | Steering wheel heater on |
| `sideMirrorHeat` | boolean | Side mirror heat on |
| `rearWindowHeat` | boolean | Rear window defroster on |
| `defrost` | boolean | Defrost status |
| `temperatureSetpoint` | number\|string | Temperature setting |
| `temperatureUnit` | number | Temperature unit (0=Celsius, 1=Fahrenheit) |

### Metadata

| Field | Type | Description |
|-------|------|-------------|
| `lastupdate` | Date | Timestamp when data was retrieved from vehicle |

### Example Response

```typescript
{
  engine: {
    range: 330,              // Total range in miles
    rangeGas: null,          // Not a hybrid
    rangeEV: null,           // Not a hybrid
    ignition: false,         // Engine off
    accessory: false,
    charging: false,
    batteryCharge12v: 85,    // 12V battery at 85%
    batteryChargeHV: null,   // Not an EV
  },
  chassis: {
    locked: true,            // Doors locked
    hoodOpen: false,
    trunkOpen: false,
    openDoors: {
      frontRight: false,
      frontLeft: false,
      backLeft: false,
      backRight: false,
    },
    tirePressureWarningLamp: {
      rearLeft: false,
      frontLeft: false,
      frontRight: false,
      rearRight: false,
      all: false,           // No tire warnings
    },
  },
  climate: {
    active: false,          // Climate control off
    steeringwheelHeat: false,
    sideMirrorHeat: false,
    rearWindowHeat: false,
    defrost: false,
    temperatureSetpoint: 72,
    temperatureUnit: 1,     // Fahrenheit
  },
  lastupdate: Date('2026-02-09T15:30:00Z')
}
```

---

## Location Data

**Method:** `vehicle.location()`

Returns real-time GPS location. **Note:** This always polls the vehicle directly (no cache).

| Field | Type | Description |
|-------|------|-------------|
| `latitude` | number | GPS latitude |
| `longitude` | number | GPS longitude |
| `altitude` | number | Altitude |
| `speed.value` | number | Current speed value |
| `speed.unit` | number | Speed unit (0=kph, 1=mph) |
| `heading` | number | Direction of travel in degrees |

### Example Response

```typescript
{
  latitude: 37.7749,
  longitude: -122.4194,
  altitude: 52,
  speed: {
    value: 0,
    unit: 1  // mph
  },
  heading: 180  // degrees
}
```

---

## Odometer Data

**Method:** `vehicle.odometer()`

Returns odometer reading.

| Field | Type | Description |
|-------|------|-------------|
| `value` | number | Odometer reading |
| `unit` | number | Unit (0=miles, 1=kilometers) |

### Example Response

```typescript
{
  value: 45230,
  unit: 0  // miles
}
```

---

## Trip & Driving History (EU Region)

### Trip Info

**Method:** `vehicle.tripInfo({ year: 2026, month: 2, day?: 9 })`

Returns trip statistics for a specific day or month.

#### Monthly Trip Data

| Field | Type | Description |
|-------|------|-------------|
| `days` | Array | List of days with trip counts |
| `durations.drive` | number | Total drive time |
| `durations.idle` | number | Total idle time |
| `speed.avg` | number | Average speed |
| `speed.max` | number | Maximum speed |
| `distance` | number | Total distance |

#### Daily Trip Data

Includes all monthly fields plus:

| Field | Type | Description |
|-------|------|-------------|
| `trips` | Array | Individual trip details |
| `trips[].start` | Date | Trip start time |
| `trips[].end` | Date | Trip end time |
| `trips[].distance` | number | Trip distance |
| `trips[].speed.avg` | number | Trip average speed |
| `trips[].speed.max` | number | Trip max speed |
| `trips[].durations.drive` | number | Drive time |
| `trips[].durations.idle` | number | Idle time |

### Drive History (EVs)

**Method:** `vehicle.driveHistory()`

Returns energy consumption and efficiency data.

| Field | Type | Description |
|-------|------|-------------|
| `period` | historyCumulatedTypes | Period type (0=Total, 1=Average, 2=Today) |
| `consumption.total` | number | Total energy consumption |
| `consumption.engine` | number | Engine energy use |
| `consumption.climate` | number | Climate control energy use |
| `consumption.devices` | number | Device energy use |
| `consumption.battery` | number | Battery energy use |
| `regen` | number | Regenerative braking recovery |
| `distance` | number | Distance traveled |

---

## Monthly Reports (EU Region)

**Method:** `vehicle.monthlyReport()`

Returns comprehensive monthly vehicle report.

| Field | Type | Description |
|-------|------|-------------|
| `start` | string | Start date (YYYYMMDD format) |
| `end` | string | End date (YYYYMMDD format) |
| `driving.distance` | number | Total distance driven |
| `driving.startCount` | number | Number of trips started |
| `driving.durations.drive` | number | Total drive time |
| `driving.durations.idle` | number | Total idle time |
| `breakdown` | Array | Vehicle breakdown/fault codes |
| `breakdown[].ecuIdx` | string | ECU index |
| `breakdown[].ecuStatus` | string | ECU status |
| `vehicleStatus.tpms` | boolean | TPMS status |
| `vehicleStatus.tirePressure.all` | boolean | Any tire pressure issues |

---

## EV Charge Targets

### Get Charge Targets

**Method:** `vehicle.getChargeTargets()`

Returns current charge limit settings.

| Field | Type | Description |
|-------|------|-------------|
| `type` | EVChargeModeTypes | Charge mode (0=Fast, 1=Slow) |
| `distance` | number | Estimated range at target level |
| `targetLevel` | number | Target charge percentage |

### Set Charge Targets

**Method:** `vehicle.setChargeTargets({ fast: 80, slow: 90 })`

Sets charge limits for fast and slow charging.

---

## Raw Status Fields

**Method:** `vehicle.status({ parsed: false, refresh: false })`

Returns raw, unparsed status data with additional low-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `lowFuelLight` | boolean | Low fuel warning light status |
| `seatHeaterVentInfo` | object | Seat heater/ventilation settings |
| `lampWireStatus.headLamp` | unknown | Head lamp status |
| `lampWireStatus.stopLamp` | unknown | Stop lamp status |
| `lampWireStatus.turnSignalLamp` | unknown | Turn signal status |
| `windowOpen` | unknown | Window status |
| `engineRuntime` | unknown | Engine runtime data |
| `sleepModeCheck` | boolean | Sleep mode status |
| `remoteIgnition` | boolean | Remote start status |

---

## Usage Examples

### Get Fuel Range (Our Current Use Case)

```typescript
const status = await vehicle.status({
  refresh: false,  // Use cached data (safe, fast)
  parsed: true     // Get structured response
});

console.log(`Range: ${status.engine.range} miles`);
console.log(`Last updated: ${status.lastupdate}`);
```

### Check if Doors are Locked

```typescript
const status = await vehicle.status({ parsed: true });

if (!status.chassis.locked) {
  console.log('⚠️ Warning: Doors are unlocked!');
}

// Check individual doors
if (status.chassis.openDoors.frontLeft) {
  console.log('Front left door is open');
}
```

### Monitor Tire Pressure

```typescript
const status = await vehicle.status({ parsed: true });

if (status.chassis.tirePressureWarningLamp.all) {
  console.log('⚠️ Tire pressure warning!');

  // Check which tire
  if (status.chassis.tirePressureWarningLamp.frontLeft) {
    console.log('Front left tire pressure low');
  }
}
```

### Get Location

```typescript
const location = await vehicle.location();

console.log(`Vehicle is at: ${location.latitude}, ${location.longitude}`);
console.log(`Altitude: ${location.altitude}m`);
console.log(`Heading: ${location.heading}°`);
```

### Check EV Charging Status

```typescript
const status = await vehicle.status({ parsed: true });

if (status.engine.charging) {
  console.log('Vehicle is charging');
  console.log(`Battery: ${status.engine.batteryChargeHV}%`);
  console.log(`Time to full: ${status.engine.timeToFullCharge}`);

  // Check plug type
  if (status.engine.plugedTo === 1) {
    console.log('Using fast charger');
    console.log(`Est. time: ${status.engine.estimatedFastChargeDuration} min`);
  }
}
```

---

## Important Notes

### Refresh vs Cached Status

**Cached Status** (`refresh: false`):
- Uses server's cached data
- Fast response (< 2 seconds)
- Doesn't wake up vehicle
- Safe to call frequently
- Data may be hours old
- **Recommended for monitoring**

**Fresh Status** (`refresh: true`):
- Polls vehicle directly
- Slow response (30-60 seconds)
- Drains 12V battery if used too often
- Use sparingly (max once per hour)
- Data is real-time
- **Use only when necessary**

### Regional Differences

Some features are region-specific:
- **Trip Info / Drive History**: Primarily EU region
- **Monthly Reports**: EU region
- **Charge Targets**: EV vehicles only
- **Location**: Always real-time (no cache)

### Data Freshness

The `lastupdate` field tells you when the data was last retrieved from the vehicle. This is especially important when using cached status (`refresh: false`).

---

## Related Documentation

- **Bluelink Library**: https://bluelinky.readme.io
- **Our Implementation**: [WHATS_FUEL.md](WHATS_FUEL.md)
- **Type Definitions**: [src/interfaces/common.interfaces.ts](src/interfaces/common.interfaces.ts)
