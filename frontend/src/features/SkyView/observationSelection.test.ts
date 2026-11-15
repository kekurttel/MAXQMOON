import { matchCatalogLocation, observationForLocation, observationFromPlanner, observationStartUtc, observationWindow, resolveLocation } from './observationSelection';

const sites = [
  { id: 'ready-a', name: 'A', lat: -89.4395, lon: -137.1934 },
  { id: 'ready-b', name: 'B', lat: -88, lon: 180 },
];
const time = { date: '2026-11-15', time: '12:30', days: 3 };

test('typed catalog-equivalent custom coordinates use catalog API request', () => {
  expect(observationForLocation({ lat: sites[0].lat, lon: sites[0].lon }, sites, time))
    .toEqual({ ...time, kind: 'catalog', siteId: 'ready-a' });
});

test('globe round trips and longitude wraps preserve catalog identity without siteId', () => {
  expect(matchCatalogLocation({ lat: sites[0].lat + 1e-10, lon: sites[0].lon + 360 }, sites)?.id).toBe('ready-a');
  expect(observationForLocation({ lat: -88, lon: -180 }, sites, time))
    .toEqual({ ...time, kind: 'catalog', siteId: 'ready-b' });
});

test('A/B marks resolve independently and missing metadata cannot lose ready routing', () => {
  const marks = sites.map(site => resolveLocation({ lat: site.lat, lon: site.lon }, sites));
  expect(marks.map(mark => mark.siteId)).toEqual(['ready-a', 'ready-b']);
  marks.forEach((mark, i) => expect(observationForLocation({ lat: mark.lat, lon: mark.lon }, sites, time))
    .toEqual({ ...time, kind: 'catalog', siteId: sites[i].id }));
});

test('nearby arbitrary custom coordinates stay exact, never snap to catalog', () => {
  const location = { lat: sites[0].lat + 0.000001, lon: sites[0].lon + 0.000001 };
  expect(observationForLocation(location, sites, time)).toEqual({ ...time, kind: 'custom', ...location });
  expect(resolveLocation({ ...location, siteId: 'ready-a' } as typeof location, sites).siteId).toBeUndefined();
});

test('new UTC date/time/range apply to current selected location, not previous request', () => {
  const nextTime = { date: '2027-01-02', time: '23:50', days: 7 };
  expect(observationForLocation(sites[1], sites, nextTime))
    .toEqual({ ...nextTime, kind: 'catalog', siteId: 'ready-b' });
  expect(observationForLocation({ lat: -87.1, lon: 12.3 }, sites, nextTime))
    .toEqual({ ...nextTime, kind: 'custom', lat: -87.1, lon: 12.3 });
});

test('planner custom window retains exact coordinate, UTC seconds, end and cadence', () => {
  const input = { lat: -88.12345, lon: 12.34567, start_utc: '2026-11-15T12:03:17.123Z', end_utc: '2026-11-15T15:17:23.456Z', step_seconds: 1800 };
  const request = observationFromPlanner(input);
  expect(request).toMatchObject({ kind: 'custom', lat: input.lat, lon: input.lon, stepSeconds: 1800 });
  expect(observationWindow(request)).toEqual({ start_utc: input.start_utc, end_utc: input.end_utc, step_seconds: input.step_seconds });
});

test('catalog result preserves its own duration rather than previous UI duration', () => {
  const request = observationFromPlanner({ site_id: 'ready-b', start_utc: '2027-01-02T23:50:00Z', end_utc: '2027-01-03T02:20:00Z', step_seconds: 3600 });
  expect(request.kind).toBe('catalog');
  expect(request.days).toBeCloseTo(2.5 / 24);
  expect(observationWindow(request).end_utc).toBe('2027-01-03T02:20:00.000Z');
});

test('invalid exact windows and sample budgets fail before the request', () => {
  expect(() => observationWindow({ ...time, endUtc: '2020-01-01T00:00:00Z' })).toThrow();
  expect(() => observationWindow({ ...time, days: 15, stepSeconds: 600 })).toThrow('2049');
  expect(() => observationFromPlanner({ lat: NaN, lon: 0, start_utc: '2027-01-01T00:00:00Z', end_utc: '2027-01-02T00:00:00Z' })).toThrow();
});

test('UTC start helper accepts minute, second and millisecond clocks without duplicate seconds', () => {
  expect(observationStartUtc(time)).toBe('2026-11-15T12:30:00.000Z');
  expect(observationStartUtc({ date: time.date, time: '12:03:17.123' })).toBe('2026-11-15T12:03:17.123Z');
  expect(() => observationStartUtc({ date: '2026-02-30', time: '00:00' })).toThrow();
});

test('invalid coordinates cannot match catalog', () => {
  expect(matchCatalogLocation({ lat: NaN, lon: 180 }, sites)).toBeUndefined();
  expect(matchCatalogLocation({ lat: -88, lon: Infinity }, sites)).toBeUndefined();
});
