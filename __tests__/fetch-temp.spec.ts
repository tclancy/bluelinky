/**
 * Tests for fetchOutdoorTempF.
 * Uses jest.spyOn to mock global fetch so no real HTTP calls are made.
 */
import { fetchOutdoorTempF } from '../src/monitor-helpers';

function mockFetch(response: object, ok = true): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok,
    json: async () => response,
  } as Response);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchOutdoorTempF', () => {
  it('returns temperature on success', async () => {
    mockFetch({ current: { temperature_2m: 52.3 } });
    const temp = await fetchOutdoorTempF('43.2419', '-70.9164458');
    expect(temp).toBe(52.3);
  });

  it('returns null when fetch returns non-ok status', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false } as Response);
    const temp = await fetchOutdoorTempF('43.2419', '-70.9164458');
    expect(temp).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('network error'));
    const temp = await fetchOutdoorTempF('43.2419', '-70.9164458');
    expect(temp).toBeNull();
  });

  it('returns null when response body is missing temperature field', async () => {
    mockFetch({ current: {} });
    const temp = await fetchOutdoorTempF('43.2419', '-70.9164458');
    expect(temp).toBeNull();
  });
});
