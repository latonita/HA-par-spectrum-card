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

function makeCard(model, channelValues, mode) {
  const profile = SENSOR_PROFILES[model];
  const card = Object.create(AS734xSpectrumCard.prototype);
  card._profile = profile;
  card._config = { entities: {}, ...(mode ? { mode } : {}) };
  card._channels = sortedChannels(profile).map((ch) => ({
    ...ch,
    value: channelValues ? channelValues[ch.key] ?? 1 : 1,
    unit: '#',
    available: true,
  }));
  card._curve = card.buildCurve();
  card._reconstruct = mode !== 'interpolation';
  return card;
}

function steepestStep(card, step = 0.5) {
  const [lo, hi] = card.axis;
  let peak = 0;
  for (let wl = lo; wl <= hi; wl += step) peak = Math.max(peak, card.valueAt(wl));
  let worst = 0;
  for (let wl = lo; wl + step <= hi; wl += step) {
    worst = Math.max(worst, Math.abs(card.valueAt(wl + step) - card.valueAt(wl)) / peak);
  }
  return worst;
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
    ['f1', 'f2', 'fz', 'f3', 'f4', 'f5', 'fy', 'fxl', 'f6', 'f7', 'f8', 'nir'],
  );
});

test('AS7343 wavelengths match the driver channel map', () => {
  const expected = { f1: 405, f2: 425, fz: 450, f3: 475, f4: 515, f5: 550, fy: 555, fxl: 600, f6: 640, f7: 690, f8: 745, nir: 855 };
  for (const ch of SENSOR_PROFILES.as7343.channels) {
    assert.equal(ch.wavelength, expected[ch.key], `${ch.key} wavelength`);
  }
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

test('interpolation reproduces channel peaks and stays finite across the axis', () => {
  const card = makeCard('as7343', { f4: 100 }, 'interpolation');
  const [axisMin, axisMax] = card.axis;

  assert.ok(Math.abs(card.valueAt(515) - 100) < 1e-6, 'value at F4 should be its own reading');

  for (let wl = axisMin; wl <= axisMax; wl += 1) {
    assert.ok(Number.isFinite(card.valueAt(wl)), `non-finite value at ${wl}nm`);
  }
});

test('a peak at the longest AS7343 channel is not swallowed by the tail', () => {
  const card = makeCard('as7343', { f8: 100 }, 'interpolation');
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

test('every plotted channel carries a positive FWHM', () => {
  for (const [name, profile] of Object.entries(SENSOR_PROFILES)) {
    for (const ch of profile.channels) {
      assert.ok(ch.fwhm > 0, `${name}.${ch.key} has no FWHM`);
    }
  }
});

test('published FWHM values match the datasheet tables', () => {
  const as7341 = { f1: 26, f2: 30, f3: 36, f4: 39, f5: 39, f6: 40, f7: 50, f8: 52 };
  const as7343 = { f1: 30, f2: 22, fz: 55, f3: 30, f4: 40, f5: 35, fy: 100, fxl: 80, f6: 50, f7: 55, f8: 60, nir: 54 };
  for (const [model, table] of [['as7341', as7341], ['as7343', as7343]]) {
    for (const ch of SENSOR_PROFILES[model].channels.filter((c) => !c.estimated)) {
      assert.equal(ch.fwhm, table[ch.key], `${model}.${ch.key} FWHM`);
    }
  }
});

test('the only estimated width is AS7341 NIR, which the datasheet leaves as n/a', () => {
  const estimated = Object.entries(SENSOR_PROFILES).flatMap(([model, p]) =>
    p.channels.filter((c) => c.estimated).map((c) => `${model}.${c.key}`));
  assert.deepEqual(estimated, ['as7341.nir']);
  assert.ok(SENSOR_PROFILES.as7341.channels.find((c) => c.key === 'nir').fwhm > 0);
});

test('reconstruction removes the AS7343 F5/FY wall that interpolation produces', () => {
  const live = {
    f1: 0.00727, f2: 0.00688, fz: 0.01309, f3: 0.01958, f4: 0.01920, f5: 0.00610,
    fy: 0.02489, fxl: 0.02522, f6: 0.03190, f7: 0.06213, f8: 0.08458, nir: 0.35360,
  };
  const stepAcrossPair = (card) => {
    let visiblePeak = 0;
    for (let wl = 400; wl <= 750; wl += 0.25) visiblePeak = Math.max(visiblePeak, card.valueAt(wl));
    return Math.abs(card.valueAt(555) - card.valueAt(550)) / visiblePeak;
  };

  const spline = stepAcrossPair(makeCard('as7343', live, 'interpolation'));
  const gauss = stepAcrossPair(makeCard('as7343', live));

  assert.ok(spline > 0.15, `fixture should show the wall, got ${(spline * 100).toFixed(1)}%`);
  assert.ok(gauss < 0.02, `reconstruction should flatten it, got ${(gauss * 100).toFixed(1)}%`);
});

test('reconstruction never goes negative and stays smooth', () => {
  for (const model of Object.keys(SENSOR_PROFILES)) {
    const card = makeCard(model, { f4: 100 });
    const [lo, hi] = card.axis;
    for (let wl = lo; wl <= hi; wl += 0.5) {
      assert.ok(card.valueAt(wl) >= 0, `${model}: negative at ${wl}nm`);
    }
    assert.ok(steepestStep(card) < 0.05, `${model}: curve has a step steeper than 5% of height`);
  }
});

test('a lone narrow channel does not out-peak a wide one carrying the same counts', () => {
  const narrow = makeCard('as7343', Object.fromEntries(
    SENSOR_PROFILES.as7343.channels.map((c) => [c.key, c.key === 'f5' ? 1 : 0]),
  ));
  const wide = makeCard('as7343', Object.fromEntries(
    SENSOR_PROFILES.as7343.channels.map((c) => [c.key, c.key === 'fy' ? 1 : 0]),
  ));
  assert.ok(
    narrow.valueAt(550) > wide.valueAt(555),
    'equal counts through a narrower filter must mean a higher spectral density',
  );
});

test('mode: interpolation keeps the original spline behaviour', () => {
  const card = makeCard('as7343', { f4: 100 }, 'interpolation');
  assert.equal(card._reconstruct, false);
  assert.ok(Math.abs(card.valueAt(515) - 100) < 1e-6, 'spline should pass through the channel value');
});

test('reconstruction attributes a lone channel peak to that channel, not a neighbour', () => {
  for (const [model, key] of [['as7343', 'f8'], ['as7343', 'f5'], ['as7343', 'fz'], ['as7341', 'f1'], ['as7341', 'nir']]) {
    const profile = SENSOR_PROFILES[model];
    const lit = profile.channels.find((c) => c.key === key);
    const values = Object.fromEntries(profile.channels.map((c) => [c.key, c.key === key ? 100 : 0]));
    const card = makeCard(model, values);
    const [lo, hi] = card.axis;
    let best = lo;
    for (let wl = lo; wl <= hi; wl += 0.5) if (card.valueAt(wl) > card.valueAt(best)) best = wl;

    const nearest = profile.channels.reduce((a, c) =>
      Math.abs(c.wavelength - best) < Math.abs(a.wavelength - best) ? c : a);
    assert.equal(nearest.key, key,
      `${model}.${key}: peak at ${best}nm sits nearest ${nearest.key} (${nearest.wavelength}nm), not the lit channel`);
  }
});
