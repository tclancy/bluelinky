/* eslint-disable */
/**
 * Coverage for the Canadian region's HTTP transport fork (#26).
 *
 * `canadian.controller.ts` and `canadian.vehicle.ts` each pick between `got`
 * and undici's `fetch`. That choice used to be an inline `process.versions.node`
 * read, which meant a test run could only ever exercise whichever arm the local
 * interpreter selected — and since every other Canadian test mocks `got`, the
 * `fetch` arm had zero coverage on any Node >= 21 while its tests made real
 * network calls.
 *
 * The seam is now `CanadianController.useFetchTransport`, so both arms are
 * reachable on any interpreter. This file drives the `fetch` arm explicitly;
 * `vehicle.spec.ts` and `controller.spec.ts` drive the `got` arm.
 *
 * The boundary is the **module**, not the global: the controller does
 * `import { fetch } from 'undici'`, so mocking `global.fetch` intercepts
 * nothing. Mock `undici`.
 */
import got from 'got';
import { fetch } from 'undici';
import fs from 'fs';
import path from 'path';

import CanadianVehicle from '../src/vehicles/canadian.vehicle';
import { CanadianController } from '../src/controllers/canadian.controller';
import {
  describeFetchTransport,
  shouldUseFetchTransport,
  FETCH_TRANSPORT_MIN_NODE_MAJOR,
} from '../src/tools/runtime.tools';

jest.mock('got');
jest.mock('undici', () => ({
  fetch: jest.fn(),
  Agent: jest.fn().mockImplementation(() => ({})),
}));

const fetchMock = fetch as unknown as jest.Mock;
const gotMock = got as unknown as jest.Mock;

/** Shape undici's `fetch` resolves to: only `.json()` is consumed. */
const fetchResolving = (body: unknown) => ({ json: async () => body });

const PREAUTH_RESPONSE = { result: { pAuth: 'test' }, responseHeader: { responseCode: 0 } };

const buildCanadianVehicle = (): CanadianVehicle => {
  const controller = new CanadianController({
    username: 'testuser@gmail.com',
    password: 'test',
    region: 'CA',
    autoLogin: true,
    brand: 'hyundai',
    pin: '1234',
    vin: '4444444444444',
    vehicleId: undefined,
  } as any);

  return new CanadianVehicle(
    {
      nickname: 'Jest is best',
      name: 'Jest is best',
      vin: '444',
      regDate: 'test',
      brandIndicator: 'H',
      regId: '123123',
      generation: '2',
      id: 'JEST_VEHICLE_ID',
    } as any,
    controller
  );
};

/** A session whose token is valid, so no request triggers a token refresh. */
const validSession = () => ({
  accessToken: 'JEST_TOKEN',
  refreshToken: 'JEST_TOKEN',
  tokenExpiresAt: Date.now() / 1000 + 300,
  controlTokenExpiresAt: 0,
});

describe('shouldUseFetchTransport', () => {
  it('selects got below the threshold and fetch at or above it', () => {
    expect(shouldUseFetchTransport('20.19.5')).toBe(false);
    expect(shouldUseFetchTransport('21.0.0')).toBe(true);
    expect(shouldUseFetchTransport('25.6.1')).toBe(true);
  });

  it('is keyed to the published threshold, not to a literal', () => {
    const below = `${FETCH_TRANSPORT_MIN_NODE_MAJOR - 1}.0.0`;
    const at = `${FETCH_TRANSPORT_MIN_NODE_MAJOR}.0.0`;

    expect(shouldUseFetchTransport(below)).toBe(false);
    expect(shouldUseFetchTransport(at)).toBe(true);
  });

  it('falls back to got on an unparseable version, as the inline checks did', () => {
    expect(shouldUseFetchTransport('not-a-version')).toBe(false);
  });

  it('defaults to the running interpreter, not to a pinned version', () => {
    // Derived from `process.version` — a different API than the production
    // default reads — so comparing the function against itself (which a
    // hardcoded default would also satisfy) is avoided.
    const runningMajor = Number(process.version.replace(/^v/, '').split('.')[0]);

    expect(shouldUseFetchTransport()).toBe(runningMajor >= FETCH_TRANSPORT_MIN_NODE_MAJOR);
  });
});

describe('describeFetchTransport', () => {
  it('names the version and the arm it selects', () => {
    expect(describeFetchTransport('20.19.5')).toEqual('node 20.19.5 -> got');
    expect(describeFetchTransport('25.6.1')).toEqual('node 25.6.1 -> fetch (undici)');
  });
});

describe('CanadianController.useFetchTransport', () => {
  it('defaults to the running interpreter', () => {
    const vehicle = buildCanadianVehicle();

    expect(vehicle.controller.useFetchTransport).toBe(shouldUseFetchTransport());
  });

  it('is the single decision both request paths read', () => {
    // The point of the seam: one flag, not two inline reads that can drift.
    // Asserted structurally because the two paths are exercised separately
    // below and neither test could notice the other site regressing.
    const sources = [
      'src/controllers/canadian.controller.ts',
      'src/vehicles/canadian.vehicle.ts',
    ].map(rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));

    for (const source of sources) {
      expect(source).toMatch(/useFetchTransport/);
      // An inline version read here is the regression this file exists for:
      // it would be invisible to every assertion above, because the flag would
      // still be set and simply not consulted. `process.version` as well as
      // `process.versions` — banning one spelling passes the other, and a
      // second interpreter check ANDed with the flag reintroduces exactly the
      // drift between the two request paths that #26 is about.
      expect(source).not.toMatch(/process\.version/);
    }
  });
});

describe('Canadian fetch transport (Node >= 21 arm)', () => {
  let vehicle: CanadianVehicle;

  beforeEach(() => {
    fetchMock.mockReset();
    gotMock.mockReset();
    vehicle = buildCanadianVehicle();
    vehicle.controller.useFetchTransport = true;
    vehicle.controller.session = validSession() as any;
  });

  it('locks through undici, not through got', async () => {
    fetchMock
      .mockResolvedValueOnce(fetchResolving(PREAUTH_RESPONSE))
      .mockResolvedValueOnce(fetchResolving({ responseHeader: { responseCode: 0 } }));

    expect(await vehicle.lock()).toEqual('Lock successful');
    // Two calls: the PIN pre-auth, then the lock itself. Both must go through
    // undici — if either fell back to `got` the count would drop and the
    // `got` assertion below would fire, which is what makes this a real
    // exercise of the fetch arm rather than a second route to the old one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(gotMock).not.toHaveBeenCalled();
  });

  it('starts the vehicle through undici', async () => {
    fetchMock
      .mockResolvedValueOnce(fetchResolving(PREAUTH_RESPONSE))
      .mockResolvedValueOnce(fetchResolving({ responseHeader: { responseCode: 0 } }));

    expect(await vehicle.start({ igniOnDuration: 10 } as any)).toEqual('Vehicle started!');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(gotMock).not.toHaveBeenCalled();
  });

  it('reports a non-zero responseCode as a failed start', async () => {
    fetchMock
      .mockResolvedValueOnce(fetchResolving(PREAUTH_RESPONSE))
      .mockResolvedValueOnce(
        fetchResolving({ responseHeader: { responseCode: 1, responseDesc: 'failed' } })
      );

    expect(await vehicle.start({ igniOnDuration: 10 } as any)).toEqual('Failed to start vehicle');
    expect(gotMock).not.toHaveBeenCalled();
  });

  it('sends the PIN and the vehicle id in the fetch request', async () => {
    fetchMock
      .mockResolvedValueOnce(fetchResolving(PREAUTH_RESPONSE))
      .mockResolvedValueOnce(fetchResolving({ responseHeader: { responseCode: 0 } }));

    await vehicle.lock();

    // `got` carries the PIN in `body` and the vehicle id in `headers`; the
    // fetch arm has to assemble both by hand, and nothing checked that it did.
    const [, options] = fetchMock.mock.calls[1];
    expect(JSON.parse(options.body)).toMatchObject({ pin: '1234' });
    expect(options.headers).toMatchObject({
      accessToken: 'JEST_TOKEN',
      'Content-Type': 'application/json',
      // The one header unique to the vehicle path, and so the likeliest thing
      // to be dropped by a future edit to that hand-assembled block.
      vehicleId: 'JEST_VEHICLE_ID',
    });
    expect(options.method).toEqual('POST');
  });

  it('lists vehicles through undici', async () => {
    fetchMock.mockResolvedValueOnce(
      fetchResolving({
        responseHeader: { responseCode: 0 },
        result: {
          vehicles: [
            {
              nickName: 'Jest is best',
              vin: '444',
              enrollmentDate: 'test',
              brandIndicator: 'H',
              regid: '123123',
              vehicleId: '1',
              genType: '2',
            },
          ],
        },
      })
    );

    expect(await vehicle.controller.getVehicles()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(gotMock).not.toHaveBeenCalled();
  });

  it('swallows a transport error instead of raising — known divergence (#26)', async () => {
    // Characterisation, not endorsement. The `got` arm throws through
    // `manageBluelinkyError`; the fetch arm's `catch` logs and returns
    // `undefined`, so `lock()` reports success for a lock that never happened.
    // Pinned here so the divergence is visible and so fixing it is a
    // deliberate, test-visible change rather than a silent one.
    fetchMock
      .mockResolvedValueOnce(fetchResolving(PREAUTH_RESPONSE))
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    expect(await vehicle.lock()).toEqual('Lock successful');
    expect(gotMock).not.toHaveBeenCalled();
  });
});

describe('Canadian got transport (Node < 21 arm)', () => {
  let vehicle: CanadianVehicle;

  beforeEach(() => {
    fetchMock.mockReset();
    gotMock.mockReset();
    vehicle = buildCanadianVehicle();
    vehicle.controller.useFetchTransport = false;
    vehicle.controller.session = validSession() as any;
  });

  it('locks through got, not through undici', async () => {
    // The mirror control: proves the flag actually selects, rather than the
    // fetch arm merely being reachable. Without this, a seam hard-wired to
    // `true` would pass every test above.
    gotMock
      .mockReturnValueOnce({
        body: PREAUTH_RESPONSE,
        statusCode: 200,
        json: true,
      })
      .mockReturnValueOnce({
        body: { responseHeader: { responseCode: 0 } },
        statusCode: 200,
        json: true,
      });

    expect(await vehicle.lock()).toEqual('Lock successful');
    expect(gotMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
