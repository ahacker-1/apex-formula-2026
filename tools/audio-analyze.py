#!/usr/bin/env python3
"""Objective 'listening' rig: spectral analysis of game audio.

Detects the defects a human ear reports:
  - whistle/whine: narrow high-frequency tonal peaks with high prominence
  - thin/screechy: high band energy dominating the bass bands

Usage:
  audio-analyze.py file.mp3 [file2.wav ...]      # per-file report
  audio-analyze.py --gate file.wav               # exit 1 if whistle/thinness gates fail
"""
import subprocess, sys, os, json
import numpy as np

SR = 24000

def decode(path):
    """Decode any audio file to mono float32 PCM via ffmpeg."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
         "-f", "f32le", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)

def welch_spectrum(x, nfft=8192):
    """Averaged magnitude spectrum (Hann windows, 50% overlap)."""
    if len(x) < nfft:
        x = np.pad(x, (0, nfft - len(x)))
    win = np.hanning(nfft)
    hop = nfft // 2
    n = max(1, (len(x) - nfft) // hop + 1)
    acc = np.zeros(nfft // 2 + 1)
    for i in range(n):
        seg = x[i * hop:i * hop + nfft] * win
        acc += np.abs(np.fft.rfft(seg)) ** 2
    spec = acc / n
    freqs = np.fft.rfftfreq(nfft, 1 / SR)
    return freqs, spec

def band_energy(freqs, spec, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    return float(spec[m].sum())

def tonal_peaks(freqs, spec, fmin=700, fmax=9000):
    """Find narrow tonal peaks: bins that tower over the local median floor.

    A whistle is a narrow peak >= ~14 dB above its surrounding spectrum.
    Returns [(freq, prominence_db, rel_level_db)] sorted by prominence.
    """
    m = (freqs >= fmin) & (freqs <= fmax)
    f, s = freqs[m], spec[m]
    sdb = 10 * np.log10(s + 1e-20)
    total_peak = sdb.max()
    # local median floor over +/- ~180 Hz
    w = max(3, int(180 / (freqs[1] - freqs[0])))
    floor = np.array([np.median(sdb[max(0, i - w):i + w]) for i in range(len(sdb))])
    prom = sdb - floor
    peaks = []
    i = 1
    while i < len(sdb) - 1:
        if sdb[i] >= sdb[i - 1] and sdb[i] >= sdb[i + 1] and prom[i] > 8:
            # merge to the local max within ~60 Hz
            j = i
            while j + 1 < len(sdb) and f[j + 1] - f[i] < 60:
                j += 1
                if sdb[j] > sdb[i]:
                    i = j
            peaks.append((float(f[i]), float(prom[i]), float(sdb[i] - total_peak)))
            i = j + 1
        else:
            i += 1
    peaks.sort(key=lambda p: -p[1])
    return peaks

def whistle_score(peaks):
    """0 = clean. A peak only counts as a whistle if it's BOTH prominent over the
    local floor (narrow) and loud relative to the overall spectrum top."""
    score = 0.0
    for f, prom, rel in peaks:
        if prom > 14 and rel > -26:
            score += (prom - 14) * (1 + max(0, (rel + 26) / 10))
    return score

def analyze(path):
    x = decode(path)
    if len(x) < SR // 4:
        return {"file": os.path.basename(path), "error": "too short"}
    freqs, spec = welch_spectrum(x)
    total = spec.sum() + 1e-20
    bands = {
        "sub<120": band_energy(freqs, spec, 20, 120),
        "bass120-300": band_energy(freqs, spec, 120, 300),
        "low-mid300-800": band_energy(freqs, spec, 300, 800),
        "mid800-2k": band_energy(freqs, spec, 800, 2000),
        "presence2k-5k": band_energy(freqs, spec, 2000, 5000),
        "high5k+": band_energy(freqs, spec, 5000, 11000),
    }
    bandpct = {k: round(100 * v / total, 1) for k, v in bands.items()}
    peaks = tonal_peaks(freqs, spec)
    ws = whistle_score(peaks)
    lowsum = bands["sub<120"] + bands["bass120-300"] + bands["low-mid300-800"]
    hisum = bands["presence2k-5k"] + bands["high5k+"]
    return {
        "file": os.path.basename(path),
        "dur_s": round(len(x) / SR, 1),
        "bands_pct": bandpct,
        "bass_to_high_ratio": round(lowsum / (hisum + 1e-20), 2),
        "whistle_score": round(ws, 1),
        "top_tonal_peaks": [
            {"hz": round(f), "prominence_db": round(p, 1), "rel_db": round(r, 1)}
            for f, p, r in peaks[:5]],
    }

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    gate = "--gate" in sys.argv
    fail = False
    for path in args:
        r = analyze(path)
        print(json.dumps(r, indent=1))
        if gate and "error" not in r:
            if r["whistle_score"] > 4:
                print(f"GATE FAIL {r['file']}: whistle_score {r['whistle_score']} > 4")
                fail = True
            if r["bass_to_high_ratio"] < 0.8 and "engine" in r["file"]:
                print(f"GATE FAIL {r['file']}: bass/high {r['bass_to_high_ratio']} < 0.8 (thin)")
                fail = True
    sys.exit(1 if fail else 0)

if __name__ == "__main__":
    main()
