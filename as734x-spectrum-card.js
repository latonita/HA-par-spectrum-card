const SENSOR_PROFILES = {
  as7341: {
    label: 'AS7341',
    axis: [380, 750],
    channels: [
      { key: 'f1', name: 'F1', wavelength: 415, fwhm: 26, color: '#8B00FF' },
      { key: 'f2', name: 'F2', wavelength: 445, fwhm: 30, color: '#4169E1' },
      { key: 'f3', name: 'F3', wavelength: 480, fwhm: 36, color: '#00BFFF' },
      { key: 'f4', name: 'F4', wavelength: 515, fwhm: 39, color: '#00FF00' },
      { key: 'f5', name: 'F5', wavelength: 555, fwhm: 39, color: '#9ACD32' },
      { key: 'f6', name: 'F6', wavelength: 590, fwhm: 40, color: '#FFD700' },
      { key: 'f7', name: 'F7', wavelength: 630, fwhm: 50, color: '#FF8C00' },
      { key: 'f8', name: 'F8', wavelength: 680, fwhm: 52, color: '#FF0000' },
    ],
    aux: [
      { key: 'clear', name: 'Clear', color: '#CCCCCC' },
      { key: 'nir', name: 'NIR', wavelength: 910, color: '#8B0000' },
    ],
  },
  as7343: {
    label: 'AS7343',
    axis: [380, 790],
    channels: [
      { key: 'f1', name: 'F1', wavelength: 405, fwhm: 30, color: '#8B00FF' },
      { key: 'f2', name: 'F2', wavelength: 425, fwhm: 22, color: '#6A0DAD' },
      { key: 'fz', name: 'FZ', wavelength: 450, fwhm: 55, color: '#4169E1' },
      { key: 'f3', name: 'F3', wavelength: 475, fwhm: 30, color: '#00BFFF' },
      { key: 'f4', name: 'F4', wavelength: 515, fwhm: 40, color: '#00FF00' },
      { key: 'f5', name: 'F5', wavelength: 550, fwhm: 35, color: '#7CFC00' },
      { key: 'fy', name: 'FY', wavelength: 555, fwhm: 100, color: '#9ACD32' },
      { key: 'fxl', name: 'FXL', wavelength: 600, fwhm: 80, color: '#FFD700' },
      { key: 'f6', name: 'F6', wavelength: 640, fwhm: 50, color: '#FF8C00' },
      { key: 'f7', name: 'F7', wavelength: 690, fwhm: 55, color: '#FF0000' },
      { key: 'f8', name: 'F8', wavelength: 745, fwhm: 60, color: '#B22222' },
    ],
    aux: [
      { key: 'clear', name: 'Clear', color: '#CCCCCC' },
      { key: 'nir', name: 'NIR', wavelength: 855, fwhm: 54, color: '#8B0000' },
    ],
  },
};

const DEFAULT_PROFILE = 'as7341';
const DEFAULT_FULL_SCALE = 65535;
const CURVE_RESOLUTION = 150;
const CHART_PADDING = 50;

function resolveProfileName(config) {
  if (config.model) {
    const name = String(config.model).toLowerCase();
    if (!SENSOR_PROFILES[name]) {
      throw new Error(`Unknown model '${config.model}'. Known models: ${Object.keys(SENSOR_PROFILES).join(', ')}`);
    }
    return name;
  }
  const keys = Object.keys(config.entities || {});
  const match = Object.entries(SENSOR_PROFILES).find(([name, profile]) => {
    if (name === DEFAULT_PROFILE) return false;
    const distinctive = profile.channels
      .map((ch) => ch.key)
      .filter((key) => !SENSOR_PROFILES[DEFAULT_PROFILE].channels.some((base) => base.key === key));
    return distinctive.some((key) => keys.includes(key));
  });
  return match ? match[0] : DEFAULT_PROFILE;
}

function sortedChannels(profile) {
  return [...profile.channels].sort((a, b) => a.wavelength - b.wavelength);
}

function readEntity(hass, entityId) {
  if (!entityId) return null;
  const entity = hass.states[entityId];
  if (!entity) return { value: 0, unit: '', available: false };
  const available = entity.state !== 'unknown' && entity.state !== 'unavailable';
  const value = available ? parseFloat(entity.state) : 0;
  return {
    value: Number.isNaN(value) ? 0 : value,
    unit: entity.attributes?.unit_of_measurement || '',
    available,
  };
}

function catmullRom(points, x) {
  if (points.length === 0) return 0;
  if (points.length === 1) return points[0].value;

  let i1 = 0;
  for (let i = 0; i < points.length - 1; i++) {
    if (x >= points[i].wavelength && x <= points[i + 1].wavelength) {
      i1 = i;
      break;
    }
  }

  const p0 = points[Math.max(0, i1 - 1)];
  const p1 = points[i1];
  const p2 = points[Math.min(points.length - 1, i1 + 1)];
  const p3 = points[Math.min(points.length - 1, i1 + 2)];

  const span = p2.wavelength - p1.wavelength;
  if (span <= 0) return p1.value;

  const t = (x - p1.wavelength) / span;
  const t2 = t * t;
  const t3 = t2 * t;

  return 0.5 * (
    2 * p1.value +
    (-p0.value + p2.value) * t +
    (2 * p0.value - 5 * p1.value + 4 * p2.value - p3.value) * t2 +
    (-p0.value + 3 * p1.value - 3 * p2.value + p3.value) * t3
  );
}

const FWHM_TO_SIGMA = 1 / (2 * Math.sqrt(2 * Math.LN2));
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

function spectralDensity(channels, x) {
  let sum = 0;
  for (const ch of channels) {
    const sigma = ch.fwhm * FWHM_TO_SIGMA;
    const offset = x - ch.wavelength;
    sum += (ch.value / (sigma * SQRT_TWO_PI)) * Math.exp(-(offset * offset) / (2 * sigma * sigma));
  }
  return sum;
}

function canReconstruct(channels) {
  return channels.length > 0 && channels.every((ch) => ch.fwhm > 0);
}

class AS734xSpectrumCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  setConfig(config) {
    if (!config.entities) {
      throw new Error('Please define entities');
    }
    this._profileName = resolveProfileName(config);
    this._profile = SENSOR_PROFILES[this._profileName];
    this._config = config;
    this._channels = [];
    this._aux = [];
    this._curve = [];
    this._reconstruct = false;
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    this.update();
  }

  get axis() {
    return this._config.axis || this._profile.axis;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        ha-card {
          padding: 0;
          overflow: hidden;
          background: var(--card-background-color);
          border-radius: 12px;
        }
        .card-header {
          font-size: 22px;
          font-weight: 600;
          padding: 20px 20px 0 20px;
          color: var(--primary-text-color);
          letter-spacing: 0.3px;
        }
        .spectrum-container {
          position: relative;
          width: 100%;
          height: 320px;
          padding: 20px;
          cursor: crosshair;
          background: linear-gradient(180deg,
            var(--card-background-color) 0%,
            rgba(var(--rgb-primary-color, 33, 150, 243), 0.03) 100%);
        }
        canvas {
          width: 100%;
          height: 100%;
          border-radius: 8px;
        }
        .tooltip {
          position: absolute;
          background: linear-gradient(135deg, rgba(0, 0, 0, 0.95), rgba(30, 30, 30, 0.95));
          color: white;
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 12px;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.2s ease;
          z-index: 1000;
          white-space: nowrap;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          border: 1px solid rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(10px);
        }
        .tooltip.show {
          opacity: 1;
        }
        .tooltip-wavelength {
          font-weight: 600;
          margin-bottom: 4px;
          font-size: 13px;
        }
        .tooltip-value {
          font-weight: 500;
        }
        .tooltip-aux {
          font-size: 10px;
          margin-top: 4px;
          color: #CCCCCC;
        }
        .banner {
          margin: 0 20px 20px 20px;
          padding: 12px 16px;
          border-radius: 8px;
          text-align: center;
          font-size: 13px;
          color: white;
          display: none;
        }
        .banner.show {
          display: block;
        }
        .banner.warning {
          background: linear-gradient(135deg, #ff9800, #f57c00);
          box-shadow: 0 2px 8px rgba(255, 152, 0, 0.3);
        }
        .banner.info {
          background: linear-gradient(135deg, #2196F3, #1976D2);
          box-shadow: 0 2px 8px rgba(33, 150, 243, 0.3);
        }
      </style>
      <ha-card>
        <div class="card-header">${this._config.title || `${this._profile.label} Light Spectrum`}</div>
        <div class="spectrum-container" id="container">
          <canvas id="canvas"></canvas>
          <div class="tooltip" id="tooltip">
            <div class="tooltip-wavelength"></div>
            <div class="tooltip-value"></div>
            <div class="tooltip-aux"></div>
          </div>
        </div>
        <div class="banner" id="banner"></div>
      </ha-card>
    `;
    this.attachTooltip();
  }

  update() {
    if (!this._hass || !this._config) return;
    this._channels = this.readChannels();
    this._aux = this.readAux();
    this._curve = this.buildCurve();
    this._reconstruct = this._config.mode !== 'interpolation' && canReconstruct(this._channels);
    this.updateBanner();
    this.draw();
  }

  readChannels() {
    const entities = this._config.entities;
    return sortedChannels(this._profile)
      .filter((ch) => entities[ch.key])
      .map((ch) => ({ ...ch, ...readEntity(this._hass, entities[ch.key]) }));
  }

  readAux() {
    const entities = this._config.entities;
    return this._profile.aux
      .filter((ch) => entities[ch.key])
      .map((ch) => ({ ...ch, ...readEntity(this._hass, entities[ch.key]) }));
  }

  updateBanner() {
    const banner = this.shadowRoot.getElementById('banner');
    if (!banner) return;

    const message = this.statusMessage();
    if (!message) {
      banner.classList.remove('show');
      return;
    }
    banner.className = `banner show ${message.level}`;
    banner.innerHTML = message.text;
  }

  statusMessage() {
    const values = this._channels.map((ch) => ch.value);
    if (values.length === 0) {
      return { level: 'info', text: 'No spectral entities are configured.' };
    }
    if (values.every((v) => v <= 0)) {
      return { level: 'info', text: '💡 No light detected. Ensure the sensor is exposed to a light source.' };
    }

    const saturation = this.saturationPercent();
    if (saturation === null) return null;
    if (saturation >= 95) {
      return { level: 'warning', text: '⚠️ Sensor saturated. Reduce <strong>gain</strong>, <strong>atime</strong> or <strong>astep</strong>.' };
    }
    if (saturation < 1) {
      return { level: 'info', text: '📉 Signal weak. Increase <strong>gain</strong>, <strong>atime</strong> or <strong>astep</strong>.' };
    }
    return null;
  }

  saturationPercent() {
    const entities = this._config.entities;
    if (entities.saturation_level) {
      const reading = readEntity(this._hass, entities.saturation_level);
      return reading.available ? reading.value : null;
    }
    const fullScale = this._config.full_scale || DEFAULT_FULL_SCALE;
    const peak = Math.max(...this._channels.map((ch) => ch.value), 0);
    return (100 * peak) / fullScale;
  }

  buildCurve() {
    if (this._channels.length === 0) return [];
    const [axisMin, axisMax] = this.axis;
    const first = this._channels[0];
    const last = this._channels[this._channels.length - 1];

    const candidates = [
      { wavelength: axisMin, value: 0 },
      { wavelength: Math.max(axisMin, first.wavelength - 20), value: first.value * 0.3 },
      ...this._channels.map((ch) => ({ wavelength: ch.wavelength, value: ch.value })),
      { wavelength: Math.min(axisMax, last.wavelength + 20), value: last.value * 0.3 },
      { wavelength: axisMax, value: 0 },
    ];

    return candidates.reduce((kept, point) => {
      if (kept.length === 0 || point.wavelength > kept[kept.length - 1].wavelength) kept.push(point);
      return kept;
    }, []);
  }

  valueAt(wavelength) {
    return this._reconstruct ? spectralDensity(this._channels, wavelength) : catmullRom(this._curve, wavelength);
  }

  sampleCurve(chartWidth, chartHeight) {
    const [axisMin, axisMax] = this.axis;
    const samples = [];
    for (let i = 0; i <= CURVE_RESOLUTION; i++) {
      const wavelength = axisMin + (i / CURVE_RESOLUTION) * (axisMax - axisMin);
      samples.push({ wavelength, value: Math.max(0, this.valueAt(wavelength)) });
    }
    const peak = Math.max(...samples.map((s) => s.value), Number.MIN_VALUE);
    return samples.map((s) => ({
      x: this.wavelengthToX(s.wavelength, chartWidth),
      y: CHART_PADDING + chartHeight - (s.value / peak) * chartHeight,
    }));
  }

  wavelengthToX(wavelength, chartWidth) {
    const [axisMin, axisMax] = this.axis;
    return CHART_PADDING + ((wavelength - axisMin) / (axisMax - axisMin)) * chartWidth;
  }

  xToWavelength(x, chartWidth) {
    const [axisMin, axisMax] = this.axis;
    return axisMin + ((x - CHART_PADDING) / chartWidth) * (axisMax - axisMin);
  }

  attachTooltip() {
    const container = this.shadowRoot.getElementById('container');
    const canvas = this.shadowRoot.getElementById('canvas');
    const tooltip = this.shadowRoot.getElementById('tooltip');
    if (!container || !canvas || !tooltip) return;

    container.addEventListener('mousemove', (event) => {
      if (!this._channels || this._channels.length === 0) return;

      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const chartWidth = rect.width - CHART_PADDING * 2;

      if (x < CHART_PADDING || x > rect.width - CHART_PADDING) {
        tooltip.classList.remove('show');
        return;
      }

      const wavelength = Math.round(this.xToWavelength(x, chartWidth));
      const nearest = this._channels.find((ch) => Math.abs(ch.wavelength - wavelength) < 15);
      const unit = this._channels[0].unit;

      const labelEl = tooltip.querySelector('.tooltip-wavelength');
      const valueEl = tooltip.querySelector('.tooltip-value');
      const auxEl = tooltip.querySelector('.tooltip-aux');

      if (nearest) {
        labelEl.textContent = `${nearest.name} (${nearest.wavelength}nm)`;
        valueEl.textContent = `${nearest.value.toFixed(1)} ${nearest.unit}`;
        valueEl.style.color = nearest.color;
      } else {
        labelEl.textContent = `${wavelength}nm`;
        valueEl.textContent = `${this.valueAt(wavelength).toFixed(1)} ${unit}`;
        valueEl.style.color = '#4CAF50';
      }

      auxEl.textContent = this._aux
        .map((ch) => `${ch.name}: ${ch.value.toFixed(1)} ${ch.unit}`)
        .join('   ');

      tooltip.style.left = `${x + 15}px`;
      tooltip.style.top = `${y - 40}px`;
      tooltip.classList.add('show');
    });

    container.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
  }

  draw() {
    const canvas = this.shadowRoot.getElementById('canvas');
    if (!canvas || this._channels.length === 0) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const { width, height } = rect;
    const chartWidth = width - CHART_PADDING * 2;
    const chartHeight = height - CHART_PADDING * 2;
    const [axisMin, axisMax] = this.axis;

    ctx.clearRect(0, 0, width, height);

    const curve = this.sampleCurve(chartWidth, chartHeight);

    this.fillBand(ctx, chartWidth, chartHeight, 0.12);

    ctx.beginPath();
    ctx.moveTo(CHART_PADDING, CHART_PADDING + chartHeight);
    curve.forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.lineTo(curve[curve.length - 1].x, CHART_PADDING + chartHeight);
    ctx.closePath();
    this.fillBand(ctx, chartWidth, chartHeight, 0.85, true);

    ctx.beginPath();
    curve.forEach((point, i) => (i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const textColor = getComputedStyle(this).getPropertyValue('--primary-text-color') || '#ffffff';

    ctx.strokeStyle = textColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(CHART_PADDING, CHART_PADDING);
    ctx.lineTo(CHART_PADDING, CHART_PADDING + chartHeight);
    ctx.lineTo(CHART_PADDING + chartWidth, CHART_PADDING + chartHeight);
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const step = 50;
    for (let wl = Math.ceil(axisMin / step) * step; wl <= axisMax; wl += step) {
      ctx.fillText(`${wl}`, this.wavelengthToX(wl, chartWidth), height - 15);
    }

    ctx.save();
    ctx.translate(12, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = '12px sans-serif';
    ctx.fillText('Relative Intensity', 0, 0);
    ctx.restore();

    ctx.font = '12px sans-serif';
    ctx.fillText('Wavelength (nm)', width / 2, height - 2);
  }

  fillBand(ctx, chartWidth, chartHeight, alpha, useCurrentPath = false) {
    const stops = [
      [0.00, [138, 43, 226]],
      [0.15, [75, 0, 130]],
      [0.25, [0, 0, 255]],
      [0.40, [0, 191, 255]],
      [0.50, [0, 255, 0]],
      [0.60, [173, 255, 47]],
      [0.70, [255, 255, 0]],
      [0.80, [255, 165, 0]],
      [0.90, [255, 69, 0]],
      [1.00, [255, 0, 0]],
    ];
    const gradient = ctx.createLinearGradient(CHART_PADDING, 0, CHART_PADDING + chartWidth, 0);
    stops.forEach(([offset, [r, g, b]]) => gradient.addColorStop(offset, `rgba(${r}, ${g}, ${b}, ${alpha})`));
    ctx.fillStyle = gradient;
    if (useCurrentPath) {
      ctx.fill();
    } else {
      ctx.fillRect(CHART_PADDING, CHART_PADDING, chartWidth, chartHeight);
    }
  }

  getCardSize() {
    return 5;
  }

  static getStubConfig() {
    const profile = SENSOR_PROFILES[DEFAULT_PROFILE];
    const entities = {};
    [...profile.channels, ...profile.aux].forEach((ch) => {
      entities[ch.key] = `sensor.${ch.key}`;
    });
    return { model: DEFAULT_PROFILE, entities, title: 'Light Spectrum' };
  }
}

class AS7341SpectrumCard extends AS734xSpectrumCard {}

customElements.define('as734x-spectrum-card', AS734xSpectrumCard);
customElements.define('as7341-spectrum-card', AS7341SpectrumCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'as734x-spectrum-card',
  name: 'AS734x Spectrum Card',
  description: 'Spectrum chart for AS7341 and AS7343 spectral sensors',
});

export { SENSOR_PROFILES, resolveProfileName, sortedChannels, catmullRom, AS734xSpectrumCard };
