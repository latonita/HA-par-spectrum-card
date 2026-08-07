import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = class {};
globalThis.customElements = { define() {} };
globalThis.window = { customCards: [] };

const {
  SENSOR_PROFILES,
  resolveProfileName,
  sortedChannels,
  catmullRom,
  AS734xSpectrumCard,
} = await import('../as734x-spectrum-card.js');

function makeCard(model, channelValues) {
  const profile = SENSOR_PROFILES[model];
  const card = Object.create(AS734xSpectrumCard.prototype);
  card._profile = profile;
  card._config = { entities: {} };
  card._channels = sortedChannels(profile).map((ch) => ({
    ...ch,
    value: channelValues ? channelValues[ch.key] ?? 1 : 1,
    unit: '#',
    available: true,
  }));
  card._curve = card.buildCurve();
  return card;
}


test('every profile lists channels the card can sort unambiguously', () => {
  for (const [name, profile] of Object.entries(SENSOR_PROFILES)) {
    const keys = profile.channels.map((ch) => ch.key);
    assert.equal(new Set(keys).size, keys.length, `${name} has duplicate channel keys`);
    for (const ch of profile.channels) {
      assert.ok(Number.isFinite(ch.wavelength), `${name}.${ch.key} has no wavelength`);
    }
  }
});

test('AS7343 channels sort into wavelength order despite config order', () => {
  const configOrder = SENSOR_PROFILES.as7343.channels.map((ch) => ch.key);
  assert.ok(configOrder.indexOf('f5') < configOrder.indexOf('fy'), 'fixture should hold F5 before FY');

  const sorted = sortedChannels(SENSOR_PROFILES.as7343);
  const wavelengths = sorted.map((ch) => ch.wavelength);
  assert.deepEqual(wavelengths, [...wavelengths].sort((a, b) => a - b));
  assert.deepEqual(
    sorted.map((ch) => ch.key),
    ['f1', 'f2', 'fz', 'f3', 'f4', 'f5', 'fy', 'fxl', 'f6', 'f7', 'f8'],
  );
});

test('AS7343 wavelengths match the driver channel map', () => {
  const expected = { f1: 405, f2: 425, fz: 450, f3: 475, f4: 515, f5: 550, fy: 555, fxl: 600, f6: 640, f7: 690, f8: 745 };
  for (const ch of SENSOR_PROFILES.as7343.channels) {
    assert.equal(ch.wavelength, expected[ch.key], `${ch.key} wavelength`);
  }
  assert.equal(SENSOR_PROFILES.as7343.aux.find((a) => a.key === 'nir').wavelength, 855);
});

test('curve points are strictly ascending for every profile', () => {
  for (const model of Object.keys(SENSOR_PROFILES)) {
    const curve = makeCard(model)._curve;
    for (let i = 1; i < curve.length; i++) {
      assert.ok(
        curve[i].wavelength > curve[i - 1].wavelength,
        `${model}: point ${i} (${curve[i].wavelength}nm) does not advance past ${curve[i - 1].wavelength}nm`,
      );
    }
  }
});

test('curve spans the axis and keeps the last channel inside it', () => {
  for (const model of Object.keys(SENSOR_PROFILES)) {
    const card = makeCard(model);
    const [axisMin, axisMax] = card.axis;
    const last = card._channels[card._channels.length - 1];
    assert.equal(card._curve[0].wavelength, axisMin);
    assert.equal(card._curve[card._curve.length - 1].wavelength, axisMax);
    assert.ok(last.wavelength < axisMax, `${model}: last channel sits on the axis edge`);
  }
});

test('the curve passes through each channel reading and stays finite across the axis', () => {
  const card = makeCard('as7343', { f4: 100 });
  const [axisMin, axisMax] = card.axis;

  assert.ok(Math.abs(card.valueAt(515) - 100) < 1e-6, 'value at F4 should be its own reading');

  for (let wl = axisMin; wl <= axisMax; wl += 1) {
    assert.ok(Number.isFinite(card.valueAt(wl)), `non-finite value at ${wl}nm`);
  }
});

test('a peak at the longest AS7343 channel is not swallowed by the tail', () => {
  const card = makeCard('as7343', { f8: 100 });
  assert.ok(Math.abs(card.valueAt(745) - 100) < 1e-6, `F8 peak lost: got ${card.valueAt(745)}`);
});

test('wavelength and x map round-trip', () => {
  const card = makeCard('as7343');
  const chartWidth = 600;
  for (const wl of [380, 500, 745, 790]) {
    const x = card.wavelengthToX(wl, chartWidth);
    assert.ok(Math.abs(card.xToWavelength(x, chartWidth) - wl) < 1e-9, `round-trip failed at ${wl}nm`);
  }
});

test('profile resolution honours the model, then auto-detects, then defaults', () => {
  assert.equal(resolveProfileName({ model: 'AS7343', entities: {} }), 'as7343');
  assert.equal(resolveProfileName({ entities: { f1: 'x', fy: 'y' } }), 'as7343');
  assert.equal(resolveProfileName({ entities: { fxl: 'x' } }), 'as7343');
  assert.equal(resolveProfileName({ entities: { f1: 'x', f8: 'y', clear: 'z' } }), 'as7341');
  assert.equal(resolveProfileName({ entities: {} }), 'as7341');
  assert.throws(() => resolveProfileName({ model: 'as7999', entities: {} }), /Unknown model/);
});

test('saturation prefers the sensor entity over the full-scale estimate', () => {
  const card = makeCard('as7343', { f4: 100 });
  card._hass = { states: { 'sensor.sat': { state: '42', attributes: {} } } };

  card._config = { entities: { saturation_level: 'sensor.sat' } };
  assert.equal(card.saturationPercent(), 42);

  card._config = { entities: {}, full_scale: 1000 };
  assert.equal(card.saturationPercent(), 10);
});

test('status banner reports darkness, saturation and weak signal', () => {
  const dark = makeCard('as7341', Object.fromEntries(SENSOR_PROFILES.as7341.channels.map((c) => [c.key, 0])));
  dark._hass = { states: {} };
  dark._config = { entities: {} };
  assert.match(dark.statusMessage().text, /No light detected/);

  const hot = makeCard('as7341', { f4: 65000 });
  hot._hass = { states: {} };
  hot._config = { entities: {} };
  assert.equal(hot.statusMessage().level, 'warning');

  const faint = makeCard('as7341', { f4: 2 });
  faint._hass = { states: {} };
  faint._config = { entities: {} };
  assert.match(faint.statusMessage().text, /Signal weak/);
});

test('an empty channel set degrades quietly', () => {
  const card = Object.create(AS734xSpectrumCard.prototype);
  card._profile = SENSOR_PROFILES.as7341;
  card._config = { entities: {} };
  card._channels = [];
  card._curve = card.buildCurve();
  assert.deepEqual(card._curve, []);
  assert.equal(card.valueAt(500), 0);
  assert.match(card.statusMessage().text, /No spectral entities/);
});

