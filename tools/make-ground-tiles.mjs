#!/usr/bin/env node
// Remove directional low-frequency banding from the authored grass tile without
// adding a runtime dependency. The decoder intentionally supports only the PNG
// subset used by the project's ground assets: non-interlaced 8-bit RGB/RGBA.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRASS = path.join(ROOT, 'textures/grass.png');
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LUMA = [0.2126, 0.7152, 0.0722];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = -1;
  let sawIhdr = false, sawIend = false;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]));
    if (actualCrc !== expectedCrc) throw new Error(`${type} CRC mismatch`);
    offset += length + 12;
    if (type === 'IHDR') {
      if (length !== 13 || sawIhdr) throw new Error('invalid IHDR');
      sawIhdr = true;
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('only standard compression/filtering and non-interlaced PNGs are supported');
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }
  if (!sawIhdr || !sawIend || !idat.length) throw new Error('PNG is missing IHDR, IDAT, or IEND');
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  if (inflated.length !== height * (stride + 1)) throw new Error('unexpected decompressed PNG size');
  const pixels = Buffer.alloc(width * height * channels);
  let src = 0;
  let previous = Buffer.alloc(stride), current = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    if (filter > 4) throw new Error(`unsupported PNG scanline filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const raw = inflated[src++];
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : paeth(left, up, upLeft);
      current[x] = (raw + predictor) & 255;
    }
    current.copy(pixels, y * stride);
    [previous, current] = [current, previous];
  }
  return { width, height, channels, colorType, pixels };
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return chunk;
}

export function encodePng({ width, height, channels, colorType, pixels }) {
  const stride = width * channels;
  const filtered = Buffer.alloc(height * (stride + 1));
  let dst = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    let best = null, bestFilter = 0, bestScore = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      const candidate = Buffer.allocUnsafe(stride);
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? row[x - channels] : 0;
        const up = previous[x];
        const upLeft = x >= channels ? previous[x - channels] : 0;
        const predictor = filter === 0 ? 0
          : filter === 1 ? left
            : filter === 2 ? up
              : filter === 3 ? Math.floor((left + up) / 2)
                : paeth(left, up, upLeft);
        const value = (row[x] - predictor + 256) & 255;
        candidate[x] = value;
        score += Math.min(value, 256 - value);
      }
      if (score < bestScore) {
        best = candidate; bestFilter = filter; bestScore = score;
      }
    }
    filtered[dst++] = bestFilter;
    best.copy(filtered, dst); dst += stride;
    previous = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType;
  const compressed = zlib.deflateSync(filtered, { level: 9 });
  return Buffer.concat([
    SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pixelLuma(pixels, offset) {
  return LUMA[0] * pixels[offset] + LUMA[1] * pixels[offset + 1] + LUMA[2] * pixels[offset + 2];
}

function harmonic(profile, cycles) {
  let re = 0, im = 0;
  for (let x = 0; x < profile.length; x++) {
    const angle = 2 * Math.PI * cycles * x / profile.length;
    re += profile[x] * Math.cos(angle);
    im -= profile[x] * Math.sin(angle);
  }
  const scale = 2 / profile.length;
  return { cycles, re: re * scale, im: im * scale, amplitude: Math.hypot(re, im) * scale };
}

export function groundTileMetrics(image) {
  const { width, height, channels, pixels } = image;
  const columnMean = new Float64Array(width);
  const luma = new Float64Array(width * height);
  let sum = 0, seam = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const value = pixelLuma(pixels, offset);
      luma[y * width + x] = value;
      columnMean[x] += value; sum += value;
    }
    const first = y * width * channels;
    const last = (y * width + width - 1) * channels;
    for (let c = 0; c < 3; c++) seam += Math.abs(pixels[first + c] - pixels[last + c]) / 3;
  }
  for (let x = 0; x < width; x++) columnMean[x] /= height;
  let dominant = { cycles: 0, amplitude: 0 };
  for (let cycles = 1; cycles <= Math.floor(width / 2); cycles++) {
    const item = harmonic(columnMean, cycles);
    if (item.amplitude > dominant.amplitude) dominant = item;
  }
  // Wrapped first differences reject broad gradients while measuring whether
  // the pixel-scale authored grass detail survived the column-only correction.
  let difference2 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const right = y * width + ((x + 1) % width);
      const down = ((y + 1) % height) * width + x;
      difference2 += (luma[i] - luma[right]) ** 2 + (luma[i] - luma[down]) ** 2;
    }
  }
  return {
    meanLuma: sum / (width * height),
    columnPeakToPeak: Math.max(...columnMean) - Math.min(...columnMean),
    dominantColumn: dominant,
    highFrequencyRms: Math.sqrt(difference2 / (2 * width * height)),
    wrapSeamMad: seam / height,
    columnMean,
  };
}

function removeColumnBanding(image, before) {
  const { width, height, channels, pixels } = image;
  // The authored stripes have a 4-cycle fundamental. Reconstruct the low-order
  // profile plus only that fundamental's harmonic family; unrelated column detail
  // is not part of the correction. The extended harmonic tail follows the sharp
  // stripe shoulders while the first-difference RMS guards fine texture.
  let fundamental = { cycles: 1, amplitude: -Infinity };
  for (let k = 1; k <= 8; k++) {
    const item = harmonic(before.columnMean, k);
    if (item.amplitude > fundamental.amplitude) fundamental = item;
  }
  const selected = [];
  const harmonicLimit = Math.floor(width * 3 / 8);
  for (let k = 1; k <= harmonicLimit; k++) {
    if (k <= 8 || k % fundamental.cycles === 0) selected.push(harmonic(before.columnMean, k));
  }
  const band = new Float64Array(width).fill(before.meanLuma);
  for (const item of selected) {
    for (let x = 0; x < width; x++) {
      const angle = 2 * Math.PI * item.cycles * x / width;
      band[x] += item.re * Math.cos(angle) - item.im * Math.sin(angle);
    }
  }
  // PNG tiles duplicate the boundary sample. Give both edges exactly the same
  // correction so the zero-error authored seam remains zero-error.
  band[width - 1] = band[0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const scale = before.meanLuma / band[x];
      for (let c = 0; c < 3; c++) pixels[offset + c] = Math.max(0, Math.min(255, Math.round(pixels[offset + c] * scale)));
    }
  }
  // Quantisation and rare channel clipping can move the global mean slightly.
  // One global correction keeps the output within a few thousandths of a luma.
  const interim = groundTileMetrics(image);
  const renormalise = before.meanLuma / interim.meanLuma;
  for (let i = 0; i < pixels.length; i += channels) {
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.max(0, Math.min(255, Math.round(pixels[i + c] * renormalise)));
  }
  for (let y = 0; y < height; y++) {
    const first = y * width * channels;
    const last = (y * width + width - 1) * channels;
    for (let c = 0; c < channels; c++) pixels[last + c] = pixels[first + c];
  }
}

function summary(label, metrics, bytes) {
  return `${label}: ${bytes.toLocaleString('en-US')} bytes; mean ${metrics.meanLuma.toFixed(4)}; `
    + `band ${metrics.dominantColumn.amplitude.toFixed(4)} @ ${metrics.dominantColumn.cycles} cycles; `
    + `column p-p ${metrics.columnPeakToPeak.toFixed(4)}; HF RMS ${metrics.highFrequencyRms.toFixed(4)}; `
    + `seam ${metrics.wrapSeamMad.toFixed(4)}`;
}

export function makeGroundTile(file = GRASS) {
  const input = fs.readFileSync(file);
  const image = decodePng(input);
  const before = groundTileMetrics(image);
  console.log(summary('grass input', before, input.length));
  if (before.dominantColumn.amplitude <= 2 && before.columnPeakToPeak <= 12) {
    console.log('grass output: already normalized; file left byte-identical');
    return { changed: false, before, after: before, bytes: input.length };
  }
  removeColumnBanding(image, before);
  const after = groundTileMetrics(image);
  const output = encodePng(image);
  if (Math.abs(after.meanLuma - before.meanLuma) > 0.5) throw new Error('mean luminance drift exceeds 0.5');
  if (after.highFrequencyRms / before.highFrequencyRms < 0.9
    || after.highFrequencyRms / before.highFrequencyRms > 1.1) throw new Error('high-frequency RMS drift exceeds 10%');
  if (after.wrapSeamMad > before.wrapSeamMad + 1e-9) throw new Error('horizontal wrap seam regressed');
  if (after.dominantColumn.amplitude > 2 || after.columnPeakToPeak > 12) throw new Error('column banding target not met');
  if (output.length > input.length) throw new Error(`encoded PNG grew from ${input.length} to ${output.length} bytes`);
  fs.writeFileSync(file, output);
  console.log(summary('grass output', after, output.length));
  return { changed: true, before, after, bytes: output.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    makeGroundTile();
  } catch (error) {
    console.error(`GROUND TILE: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
