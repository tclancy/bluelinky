import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { VehicleDb } from '../src/vehicle-db';

function tmpDb(): { db: VehicleDb; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluelinky-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new VehicleDb(dbPath);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true });
    },
  };
}

describe('VehicleDb', () => {
  it('initialises without error', () => {
    const { db, cleanup } = tmpDb();
    expect(db).toBeDefined();
    cleanup();
  });

  it('inserts and retrieves a check', () => {
    const { db, cleanup } = tmpDb();

    const id = db.insertCheck({
      ts: '2026-04-15T12:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 200,
      temp_f: 55.5,
      is_fillup: 0,
      odometer_mi: null,
    });

    expect(id).toBeGreaterThan(0);

    const last = db.getLastCheck();
    expect(last).not.toBeNull();
    expect(last!.range_mi).toBe(200);
    expect(last!.vehicle_name).toBe('Test Vehicle');
    expect(last!.is_fillup).toBe(0);

    cleanup();
  });

  it('inserts a fill-up check with odometer', () => {
    const { db, cleanup } = tmpDb();

    db.insertCheck({
      ts: '2026-04-15T12:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 380,
      temp_f: 60,
      is_fillup: 1,
      odometer_mi: 42000,
    });

    const last = db.getLastCheck();
    expect(last!.is_fillup).toBe(1);
    expect(last!.odometer_mi).toBe(42000);
    cleanup();
  });

  it('inserts and retrieves a TPMS reading', () => {
    const { db, cleanup } = tmpDb();

    const checkId = db.insertCheck({
      ts: '2026-04-15T12:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 200,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
    });

    db.insertTpms({
      check_id: checkId,
      ts: '2026-04-15T12:00:00Z',
      front_left: 1,
      front_right: 0,
      rear_left: 0,
      rear_right: 0,
      all_lamps: 0,
    });

    const last = db.getLastTpms();
    expect(last).not.toBeNull();
    expect(last!.front_left).toBe(1);
    expect(last!.front_right).toBe(0);
    expect(last!.check_id).toBe(checkId);

    cleanup();
  });

  it('inserts an alert', () => {
    const { db, cleanup } = tmpDb();

    db.insertAlert({
      ts: '2026-04-15T12:00:00Z',
      alert_type: 'tpms_warn',
      details: JSON.stringify({ wheels: ['frontLeft'] }),
    });

    // No crash = pass; we don't expose a getter for alerts in the public API
    cleanup();
  });

  it('returns null from getLastCheck when no data', () => {
    const { db, cleanup } = tmpDb();
    expect(db.getLastCheck()).toBeNull();
    cleanup();
  });

  it('returns null from getLastTpms when no data', () => {
    const { db, cleanup } = tmpDb();
    expect(db.getLastTpms()).toBeNull();
    cleanup();
  });

  it('getLastCheck returns the most recent row', () => {
    const { db, cleanup } = tmpDb();

    db.insertCheck({
      ts: '2026-04-15T10:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 300,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
    });
    db.insertCheck({
      ts: '2026-04-15T11:00:00Z',
      vehicle_name: 'Test Vehicle',
      range_mi: 290,
      temp_f: null,
      is_fillup: 0,
      odometer_mi: null,
    });

    const last = db.getLastCheck();
    expect(last!.range_mi).toBe(290);

    cleanup();
  });
});
