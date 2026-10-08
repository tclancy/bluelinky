/**
 * Tests for the alert-kind dispatch in alert-backends.ts.
 *
 * Both backends branch on the `kind` discriminant. Before #19 the branch was
 * `if (kind === 'fuel') … else <TPMS>`, so the else arm was reached by
 * *anything* that was not `'fuel'` — including a message with no `kind` at
 * all, which then threw a TypeError deep inside formatWheels. These tests pin
 * the dispatch to the two kinds it actually knows and require an explicit
 * refusal for anything else.
 */
import { ConsoleAlertBackend, NtfyAlertBackend } from '../alert-backends';
import type { AlertMessage, FuelAlertMessage, TpmsAlertMessage } from '../alert-backends';

const TIMESTAMP = new Date('2026-10-07T23:00:00Z');

/** The exact payload shape monitor-fuel.ts sends, post-#19. */
const fuelAlert: FuelAlertMessage = {
  kind: 'fuel',
  severity: 'low',
  range: 45,
  vehicleName: 'Palisade',
  timestamp: TIMESTAMP,
};

const tpmsAlert: TpmsAlertMessage = {
  kind: 'tpms',
  severity: 'warn',
  wheels: ['frontLeft', 'rearRight'],
  vehicleName: 'Palisade',
  timestamp: TIMESTAMP,
};

/**
 * Messages the type system forbids but a JS caller can still construct. The
 * cast is the point of the test: #19 was a caller doing exactly this.
 */
const kindless = {
  severity: 'low',
  range: 45,
  vehicleName: 'Palisade',
  timestamp: TIMESTAMP,
} as unknown as AlertMessage;

/**
 * An unknown kind that *does* carry wheels. This is the case no TypeError can
 * catch: the old else-arm rendered it as a tire alert and resolved happily.
 */
const unknownKindWithWheels = {
  kind: 'oil',
  severity: 'warn',
  wheels: ['frontLeft'],
  vehicleName: 'Palisade',
  timestamp: TIMESTAMP,
} as unknown as AlertMessage;

describe('ConsoleAlertBackend dispatch', () => {
  let logged: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    logged = [];
    spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterEach(() => spy.mockRestore());

  it('renders a fuel alert as a fuel alert, naming range rather than wheels', async () => {
    await new ConsoleAlertBackend().sendAlert(fuelAlert);
    const out = logged.join('\n');
    expect(out).toContain('Low Fuel Warning');
    expect(out).toContain('45 miles remaining');
    expect(out).not.toContain('Tire');
    expect(out).not.toContain('Wheels');
  });

  it('renders a tpms alert as a tire alert, naming the lit wheels', async () => {
    await new ConsoleAlertBackend().sendAlert(tpmsAlert);
    const out = logged.join('\n');
    expect(out).toContain('Tire Pressure Warning');
    expect(out).toContain('front-left, rear-right');
  });

  it('refuses a message with no kind instead of rendering it as a tire alert', async () => {
    await expect(new ConsoleAlertBackend().sendAlert(kindless)).rejects.toThrow(
      /unknown alert kind/i
    );
    expect(logged.join('\n')).not.toContain('Tire');
  });

  it('refuses an unknown kind that carries wheels, which would otherwise render silently', async () => {
    await expect(new ConsoleAlertBackend().sendAlert(unknownKindWithWheels)).rejects.toThrow(
      /unknown alert kind/i
    );
    expect(logged.join('\n')).not.toContain('Tire');
  });

  it('names the offending kind in the error, so a bad caller is identifiable', async () => {
    await expect(new ConsoleAlertBackend().sendAlert(unknownKindWithWheels)).rejects.toThrow(/oil/);
  });
});

describe('NtfyAlertBackend dispatch', () => {
  const backend = () => new NtfyAlertBackend('https://ntfy.example/fuelbot', 'u', 'p');
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, statusText: 'OK' } as Response);
  });

  afterEach(() => fetchSpy.mockRestore());

  it('posts a fuel alert with the fuel title and the range in the body', async () => {
    await backend().sendAlert(fuelAlert);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['X-Title']).toBe('Low Fuel Warning');
    expect(init.body).toContain('45 miles of range');
  });

  it('posts a tpms alert with the tire title and the wheels in the body', async () => {
    await backend().sendAlert(tpmsAlert);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['X-Title']).toBe('Tire Pressure Warning');
    expect(init.body).toContain('front-left, rear-right');
  });

  it('refuses a message with no kind without sending anything', async () => {
    await expect(backend().sendAlert(kindless)).rejects.toThrow(/unknown alert kind/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an unknown kind that carries wheels without sending anything', async () => {
    await expect(backend().sendAlert(unknownKindWithWheels)).rejects.toThrow(/unknown alert kind/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
