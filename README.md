# AS734x Spectrum Card

A Home Assistant Lovelace card that plots the output of a multi-channel spectral sensor as a spectrum chart.

Supports the **AS7341** (8 plotted bands) and the **AS7343** (11 plotted bands). Adding another sensor means adding
one entry to a table, not touching the drawing code.

![Screenshot](Screenshot%202025-11-10%20183434.png)

This is a fork of [goatboynz/HA-par-spectrum-card](https://github.com/goatboynz/HA-par-spectrum-card), which
supports the AS7341 only.

## Installation

### HACS

1. HACS → Frontend → three-dot menu → Custom repositories
1. Add `https://github.com/latonita/HA-par-spectrum-card`, category **Lovelace**
1. Install **AS734x Spectrum Card**
1. Reload your browser

### Manual

1. Copy `as734x-spectrum-card.js` to `config/www/`
1. Settings → Dashboards → Resources → Add Resource
1. URL `/local/as734x-spectrum-card.js`, type **JavaScript Module**
1. Restart Home Assistant

> Upgrading from the original card? The resource filename changed from `as7341-spectrum-card.js` to
> `as734x-spectrum-card.js`. Update the resource URL, then reload. Existing dashboard cards keep working, see
> [Compatibility](#compatibility).

## Card Configuration

```yaml
type: custom:as734x-spectrum-card
title: Light Spectrum
model: as7343
entities:
  f1: sensor.as7343_f1
  f2: sensor.as7343_f2
  fz: sensor.as7343_fz
  f3: sensor.as7343_f3
  f4: sensor.as7343_f4
  fy: sensor.as7343_fy
  f5: sensor.as7343_f5
  fxl: sensor.as7343_fxl
  f6: sensor.as7343_f6
  f7: sensor.as7343_f7
  f8: sensor.as7343_f8
  clear: sensor.as7343_clear
  nir: sensor.as7343_nir
  saturation_level: sensor.as7343_saturation
```

| Option | Type | Default | Description |
|---|---|---|---|
| `entities` | map | **required** | Channel key to entity id. Every key is optional; only what you list is drawn. |
| `model` | string | auto | `as7341` or `as7343`. Detected from the channel keys when omitted. |
| `title` | string | `<model> Light Spectrum` | Card heading. |
| `axis` | `[min, max]` | per model | Wavelength range of the x-axis, in nm. |
| `full_scale` | number | `65535` | Highest count a channel can report, used for the saturation hint when no `saturation_level` entity is given. |
| `mode` | string | `reconstruction` | `reconstruction` sums a Gaussian per channel; `interpolation` draws a spline through the channel readings. |

`clear` and `nir` are read but not plotted, since neither has a single centre wavelength inside the visible
range. They appear in the tooltip.

`saturation_level` is optional. When present the card uses it directly instead of guessing from `full_scale`.
ESPHome's `as734x` platform can publish it.

## How the Curve Is Drawn

A spectral sensor is not a set of point samples. Each channel is a band-pass filter with its own width, so a
wide channel collects more light than a narrow one looking at the same spectrum. Joining the readings with a
line treats them as if they measured the same thing, which is wrong wherever the widths differ.

The default `reconstruction` mode instead gives every channel a Gaussian centred on its wavelength, as wide as
its FWHM, with an area equal to its reading. Adding those together produces spectral density, counts per nm.
Wide channels spread their counts out and sit lower, narrow channels sit higher, and the result is smooth by
construction.

This matters most on the AS7343, where `f5` (550nm, 35nm wide) and `fy` (555nm, 100nm wide) are 5nm apart. Drawn
as a spline the pair can produce a near-vertical wall that is mostly a bandwidth artefact. Reconstruction
removes it: on a real reading the step across that pair falls from about 22% of the chart height to under 1%,
and the F5/FY ratio drops from 4.1x to 1.4x once bandwidth is accounted for.

Set `mode: interpolation` for the original spline if you prefer it.

## Channels

The card only needs the channel keys; wavelengths and FWHM come from the built-in profile.

### AS7341

| Key | `f1` | `f2` | `f3` | `f4` | `f5` | `f6` | `f7` | `f8` | `nir` |
|---|---|---|---|---|---|---|---|---|---|
| nm | 415 | 445 | 480 | 515 | 555 | 590 | 630 | 680 | 910 |
| FWHM | 26 | 30 | 36 | 39 | 39 | 40 | 50 | 52 | n/a |

### AS7343

| Key | `f1` | `f2` | `fz` | `f3` | `f4` | `f5` | `fy` | `fxl` | `f6` | `f7` | `f8` | `nir` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| nm | 405 | 425 | 450 | 475 | 515 | 550 | 555 | 600 | 640 | 690 | 745 | 855 |
| FWHM | 30 | 22 | 55 | 30 | 40 | 35 | 100 | 80 | 50 | 55 | 60 | 54 |

> The AS7343 is not an AS7341 with extra channels. The two sensors carry different filter sets, so the same key
> means a different wavelength on each. Note also that `f5` (550nm) sits **below** `fy` (555nm) even though
> ESPHome lists `fy` first; the card sorts by wavelength, so config order does not matter.

## ESPHome

```yaml
i2c:
  sda: GPIOXX
  scl: GPIOXX

sensor:
  - platform: as734x
    type: AS7343
    gain: X8
    atime: 29
    astep: 599
    update_interval: 10s
    counts:
      f1: { name: "F1" }
      f2: { name: "F2" }
      fz: { name: "FZ" }
      f3: { name: "F3" }
      f4: { name: "F4" }
      fy: { name: "FY" }
      f5: { name: "F5" }
      fxl: { name: "FXL" }
      f6: { name: "F6" }
      f7: { name: "F7" }
      f8: { name: "F8" }
      nir: { name: "NIR" }
      clear: { name: "Clear" }
    saturation_level:
      name: "Saturation"
```

Use `type: AS7341` for the AS7341. The older `as7341` platform works too, but reports its counts byte-swapped;
prefer `as734x`.

Full scale for a reading is `(atime + 1) x (astep + 1)`, capped at 65535, so the defaults above top out at
18000. Set `full_scale` on the card to match, or wire up `saturation_level` and let the card read it.

## Compatibility

Dashboards using `type: custom:as7341-spectrum-card` keep working. That element name stays registered and
resolves to the same card, and with no `model:` the AS7341 profile is selected. Nothing to change.

## Adding Another Sensor

Add an entry to `SENSOR_PROFILES` at the top of `as734x-spectrum-card.js`:

```js
as7999: {
  label: 'AS7999',
  axis: [350, 800],
  channels: [
    { key: 'a1', name: 'A1', wavelength: 360, fwhm: 25, color: '#8B00FF' },
  ],
  aux: [
    { key: 'clear', name: 'Clear', color: '#CCCCCC' },
  ],
},
```

Sorting, axis range, curve endpoints, tick labels, tooltips and the stub config all derive from that entry.
Channels may be listed in any order. `fwhm` comes from the sensor datasheet and is what reconstruction needs; a
profile whose channels lack it falls back to interpolation automatically.

## Development

```bash
npm test     # unit tests, no browser needed
npm run build
```

## Credits

Original card by [goatboynz](https://github.com/goatboynz). AS7343 support and the profile-driven rework in this
fork. Channel wavelengths and FWHM are from the ams-osram AS7341 (DS000504) and AS7343 (DS001046) datasheets.

## License

MIT
