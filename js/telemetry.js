// Stable JSON encoding for browser-exported laps. No wall-clock fields are
// included, so identical seed/input runs produce byte-identical payloads.

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

export function deterministicJSON(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

export function downloadTelemetry(filename, value) {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;
  const blob = new Blob([deterministicJSON(value)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = String(filename || 'apex-formula-telemetry.json').replace(/[^a-z0-9_.-]+/gi, '-');
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
