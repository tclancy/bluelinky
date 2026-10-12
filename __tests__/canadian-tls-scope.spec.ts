/* eslint-disable */
/**
 * #37 — the Canadian arm must not disable TLS verification process-wide.
 *
 * `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` is read by node globally and
 * nothing restored it, so once either Canadian request path ran, every later
 * HTTPS call anything in the process made skipped certificate verification --
 * including the US calls `monitor.ts` actually makes and the plain `fetch()` in
 * `monitor-helpers.ts`, which carries no dispatcher of its own.
 *
 * The scoped replacement already existed in the same request options, fifteen
 * lines below each assignment: the per-request undici `Agent` with
 * `connect.rejectUnauthorized: false`. (Issues #37 and #32 both say "four
 * lines"; measured on `main` it is 118 -> 133 and 382 -> 398.) These
 * tests pin both halves -- the global must stay untouched, AND the scoped
 * bypass must still be there, so the env var cannot be "fixed" by deleting the
 * Agent and breaking the handshake instead.
 *
 * The transport fork is chosen by `process.versions.node` at call time, so
 * these tests drive that property directly rather than inheriting the host's
 * node version. CI runs node 20 (the `got` arm) and this Mac runs node 25 (the
 * `fetch` arm); without the forcing, whichever arm CI did not take would be
 * ungated. The descriptor is `configurable: true`, which is what makes it
 * redefinable.
 */
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { fetch, Agent } from 'undici';

import { CanadianController } from '../src/controllers/canadian.controller';
import CanadianVehicle from '../src/vehicles/canadian.vehicle';

jest.mock('got');
jest.mock('undici', () => {
  const actual = jest.requireActual('undici');
  return {
    ...actual,
    fetch: jest.fn(),
    Agent: jest.fn().mockImplementation(options => ({ __agentOptions: options })),
  };
});

const TLS_VAR = 'NODE_TLS_REJECT_UNAUTHORIZED';
const REPO_ROOT = path.join(__dirname, '..');
const FETCH_ARM_NODE = '21.0.0';
const GOT_ARM_NODE = '20.11.1';

const fetchMock = fetch as unknown as jest.Mock;
const agentMock = Agent as unknown as jest.Mock;

const realNodeVersion = process.versions.node;
const realTlsVar = process.env[TLS_VAR];

const forceNodeVersion = (version: string): void => {
  Object.defineProperty(process.versions, 'node', {
    value: version,
    configurable: true,
    enumerable: true,
    writable: false,
  });
};

/** A response shaped like every Canadian endpoint this exercise touches. */
const okResponse = () => ({
  json: async () => ({
    responseHeader: { responseCode: 0, responseDesc: 'ok' },
    result: { pAuth: 'JEST_PAUTH' },
  }),
});

const getController = (): CanadianController => {
  const controller = new CanadianController({
    username: 'testuser@gmail.com',
    password: 'test',
    region: 'CA',
    brand: 'hyundai',
    autoLogin: false,
    pin: '1234',
    vin: '4444444444444',
    vehicleId: undefined,
  } as any);

  // Far-future expiry: refreshAccessToken() must not re-enter login().
  (controller as any).session = {
    accessToken: 'JEST_TOKEN',
    refreshToken: 'JEST_TOKEN',
    tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  return controller;
};

const getVehicle = (): CanadianVehicle =>
  new CanadianVehicle(
    {
      nickname: 'Jest is best',
      name: 'Jest is best',
      vin: '444',
      regDate: 'test',
      brandIndicator: 'H',
      regId: '123123',
      generation: '2',
    } as any,
    getController()
  );

beforeEach(() => {
  fetchMock.mockReset();
  agentMock.mockClear();
  fetchMock.mockImplementation(async () => okResponse());
  delete process.env[TLS_VAR];
});

afterAll(() => {
  forceNodeVersion(realNodeVersion);
  if (realTlsVar === undefined) {
    delete process.env[TLS_VAR];
  } else {
    process.env[TLS_VAR] = realTlsVar;
  }
});

describe('the fetch transport arm leaves TLS verification alone process-wide (#37)', () => {
  beforeEach(() => forceNodeVersion(FETCH_ARM_NODE));

  it('control: the arm under test is the one that actually runs', async () => {
    await getController().getVehicles();

    // Without this the two assertions below pass on an arm nobody entered.
    expect(fetchMock).toHaveBeenCalled();
    expect(agentMock).toHaveBeenCalled();
  });

  it('does not define the global when the controller makes a request', async () => {
    await getController().getVehicles();

    expect(fetchMock).toHaveBeenCalled();
    expect(TLS_VAR in process.env).toBe(false);
  });

  it('does not define the global when the vehicle makes a request', async () => {
    await getVehicle().lock();

    expect(fetchMock).toHaveBeenCalled();
    expect(TLS_VAR in process.env).toBe(false);
  });

  it("preserves an operator's existing value rather than overwriting it", async () => {
    process.env[TLS_VAR] = '1';

    await getController().getVehicles();
    await getVehicle().lock();

    expect(fetchMock).toHaveBeenCalled();
    expect(process.env[TLS_VAR]).toBe('1');
  });

  it('still relaxes verification for its own request, scoped to the dispatcher', async () => {
    await getController().getVehicles();
    await getVehicle().lock();

    expect(agentMock).toHaveBeenCalled();
    for (const [options] of agentMock.mock.calls) {
      expect(options.connect.rejectUnauthorized).toBe(false);
      expect(options.connect.secureOptions).toBe(crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT);
    }
  });

  it('hands that dispatcher to every request it makes', async () => {
    await getController().getVehicles();
    await getVehicle().lock();

    expect(fetchMock).toHaveBeenCalled();
    for (const [, options] of fetchMock.mock.calls) {
      expect(options.dispatcher).toBeDefined();
      expect(options.dispatcher.__agentOptions.connect.rejectUnauthorized).toBe(false);
    }
  });
});

describe('the got transport arm leaves TLS verification alone too (#37)', () => {
  beforeEach(() => forceNodeVersion(GOT_ARM_NODE));

  it('control: forcing the version really selects the other arm', async () => {
    await getController().getVehicles();

    // Discriminates the arms: if this were non-zero the suite above would be
    // proving nothing about arm selection.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not define the global', async () => {
    await getController().getVehicles();
    await getVehicle()
      .lock()
      .catch(() => undefined); // the got mock resolves undefined; the throw is not what we measure

    // Per-path control. Without it, flipping only the VEHICLE's gate to always
    // fetch leaves this green and the vehicle's got arm unproven -- the
    // controller's control above cannot speak for it.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(TLS_VAR in process.env).toBe(false);
  });
});

/**
 * The behavioural suites above only speak for the two request paths they drive.
 * A third caller setting the same variable would reopen #37 with nothing red,
 * so the identifier is also banned outright across every shipped source file.
 *
 * Banning the identifier rather than the assignment is deliberate: a guard that
 * matched `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` literally would pass
 * `process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'` and
 * `Object.assign(process.env, { NODE_TLS_REJECT_UNAUTHORIZED: '0' })`, which do
 * the same thing. Every spelling that reaches the variable has to name it.
 *
 * Two consequences worth stating rather than papering over.
 *
 * It is a text scan, so it counts a *commented-out* assignment as a violation,
 * and it also rejects #37's own sanctioned fallback -- save the prior value,
 * set it, restore it in a `finally` around the one request. That fallback is
 * only needed if some Canadian request bypasses the dispatcher, and none does:
 * both `fetch` call sites in the arm pass it, and undici carries
 * `fetchParams.controller.dispatcher` through redirect follow-ups. Should that
 * ever stop being true, this test is the thing to change, deliberately, rather
 * than the obstacle to work around.
 *
 * And a fully computed key (`process.env[someVariable]`) names nothing, so it
 * is invisible here. The behavioural suites are what cover the paths that
 * matter.
 */
describe('no shipped source file names the process-wide TLS switch (#37)', () => {
  const SOURCE_DIRS = ['src', 'scripts'];
  const SOURCE_EXTENSIONS = ['.ts', '.js', '.cjs', '.mjs'];

  /**
   * Measured on `main` at the time of #37 by running this file's own walk: 42
   * under `src` + `scripts`, plus 10 at the root -- 6 entry scripts and 4
   * configs (`.eslintrc.cjs` counts; `readdirSync` returns dotfiles). The tree
   * may grow, never shrink below this.
   */
  const MIN_FILES_SCANNED = 52;

  const isSource = (name: string): boolean =>
    SOURCE_EXTENSIONS.some(extension => name.endsWith(extension));

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && isSource(entry.name) ? [full] : [];
    });

  /**
   * Derived, never listed. A hardcoded roster of root entry scripts is blind to
   * the next one added, and this repo grows them as a habit -- `monitor.ts`,
   * `monitor-fuel.ts`, `status-json.ts`, `get-fuel-level.ts` and
   * `alert-backends.ts` each arrived separately. The floor below is `>=`, so it
   * can never catch an unscanned newcomer either.
   *
   * Non-`.ts` root files are in scope deliberately: `jest.config.cjs` already
   * sets `process.env.LOG_LEVEL` and executes inside the test process, which
   * makes it the one place the variable could be set with every test still
   * green.
   */
  const rootSourceFiles = (): string[] =>
    fs
      .readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter(entry => entry.isFile() && isSource(entry.name))
      .map(entry => entry.name);

  const namesTheSwitch = (source: string): boolean => source.includes(TLS_VAR);

  const scanned: { relative: string; source: string }[] = [
    ...SOURCE_DIRS.flatMap(dir => walk(path.join(REPO_ROOT, dir))),
    ...rootSourceFiles().map(file => path.join(REPO_ROOT, file)),
  ].map(absolute => ({
    relative: path.relative(REPO_ROOT, absolute),
    source: fs.readFileSync(absolute, 'utf8'),
  }));

  it('control: the detector fires on a source file that does name it', () => {
    // Without this, "no file names it" is indistinguishable from a matcher
    // that can never match anything.
    expect(namesTheSwitch(`process.env.${TLS_VAR} = '0';`)).toBe(true);
    expect(namesTheSwitch(`process.env['${TLS_VAR}'] = '0';`)).toBe(true);
    expect(namesTheSwitch("process.env.SOMETHING_ELSE = '0';")).toBe(false);
  });

  it('control: the scan reaches the files this issue is about', () => {
    // A floor alone passes a glob that quietly stopped matching the two files
    // that carried the defect, so both are named outright.
    const relatives = scanned.map(file => file.relative);
    expect(relatives).toContain(path.join('src', 'controllers', 'canadian.controller.ts'));
    expect(relatives).toContain(path.join('src', 'vehicles', 'canadian.vehicle.ts'));

    // The root list is derived rather than enumerated, so every entry script
    // and every root config file that executes is in scope by construction.
    expect(relatives).toContain('monitor.ts');
    expect(relatives).toContain('jest.config.cjs');

    expect(scanned.length).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
    for (const file of scanned) {
      expect(file.source.length).toBeGreaterThan(0);
    }
  });

  it('names it nowhere', () => {
    const offenders = scanned
      .filter(file => namesTheSwitch(file.source))
      .map(file => file.relative);

    // A comment naming the variable counts, and so does a `finally`-scoped
    // save/restore. Read the docblock above before relaxing this.
    expect(offenders).toEqual([]);
  });
});
