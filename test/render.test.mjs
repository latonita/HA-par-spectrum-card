import test from 'node:test';
import assert from 'node:assert/strict';

const calls = [];

function stubElement() {
  const el = {
    innerHTML: '',
    textContent: '',
    className: '',
    style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(type, handler) {
      this.handlers = this.handlers || {};
      this.handlers[type] = handler;
    },
    getBoundingClientRect: () => ({ width: 700, height: 320, left: 0, top: 0 }),
    getContext: () => new Proxy({}, {
      get: (_, name) => {
        if (name === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (name === 'canvas') return undefined;
        return (...args) => calls.push([name, ...args]);
      },
    }),
    querySelector: () => stubElement(),
  };
  return el;
}

const elements = {};
function elementFor(id) {
  if (!elements[id]) elements[id] = stubElement();
  return elements[id];
}

globalThis.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = { innerHTML: '', getElementById: elementFor };
    return this.shadowRoot;
  }
};
globalThis.customElements = { define() {} };
globalThis.window = { customCards: [], devicePixelRatio: 2 };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#ffffff' });

const { AS734xSpectrumCard, SENSOR_PROFILES } = await import('../as734x-spectrum-card.js');

function hassWith(profile, value) {
  const states = {};
  [...profile.channels, ...profile.aux].forEach((ch, i) => {
    states[`sensor.${ch.key}`] = {
      state: String(value + i),
      attributes: { unit_of_measurement: '#' },
    };
  });
  return { states };
}

function entitiesFor(profile) {
  return Object.fromEntries([...profile.channels, ...profile.aux].map((ch) => [ch.key, `sensor.${ch.key}`]));
}

for (const model of Object.keys(SENSOR_PROFILES)) {
  test(`${model}: a full config renders and draws without throwing`, () => {
    calls.length = 0;
    const profile = SENSOR_PROFILES[model];
    const card = new AS734xSpectrumCard();
    card.attachShadow();

    card.setConfig({ model, entities: entitiesFor(profile) });
    card.hass = hassWith(profile, 100);

    assert.equal(card._channels.length, profile.channels.length);
    assert.equal(card._aux.length, profile.aux.length);
    assert.ok(calls.some(([name]) => name === 'stroke'), 'expected the curve to be stroked');
    assert.ok(calls.some(([name]) => name === 'fillText'), 'expected axis labels to be drawn');

    const yValues = calls.filter(([name]) => name === 'lineTo').map(([, , y]) => y);
    assert.ok(yValues.length > 0);
    assert.ok(yValues.every((y) => Number.isFinite(y)), 'every plotted point must be finite');
  });

  test(`${model}: hovering the chart fills the tooltip`, () => {
    const profile = SENSOR_PROFILES[model];
    const card = new AS734xSpectrumCard();
    card.attachShadow();
    card.setConfig({ model, entities: entitiesFor(profile) });
    card.hass = hassWith(profile, 100);

    const container = elementFor('container');
    assert.ok(container.handlers?.mousemove, 'mousemove handler should be attached');
    assert.doesNotThrow(() => container.handlers.mousemove({ clientX: 350, clientY: 100 }));
    assert.doesNotThrow(() => container.handlers.mousemove({ clientX: 5, clientY: 100 }));
  });
}

test('a partial entity map renders only what is configured', () => {
  const card = new AS734xSpectrumCard();
  card.attachShadow();
  card.setConfig({ model: 'as7343', entities: { f1: 'sensor.f1', f4: 'sensor.f4', f8: 'sensor.f8' } });
  card.hass = {
    states: {
      'sensor.f1': { state: '10', attributes: { unit_of_measurement: '#' } },
      'sensor.f4': { state: '20', attributes: { unit_of_measurement: '#' } },
      'sensor.f8': { state: '30', attributes: { unit_of_measurement: '#' } },
    },
  };
  assert.deepEqual(card._channels.map((ch) => ch.key), ['f1', 'f4', 'f8']);
  assert.equal(card._aux.length, 0);
});

test('unavailable entities do not break the draw', () => {
  const card = new AS734xSpectrumCard();
  card.attachShadow();
  card.setConfig({ model: 'as7341', entities: { f1: 'sensor.f1', f2: 'sensor.missing' } });
  assert.doesNotThrow(() => {
    card.hass = { states: { 'sensor.f1': { state: 'unavailable', attributes: {} } } };
  });
  assert.equal(card._channels[0].available, false);
});
