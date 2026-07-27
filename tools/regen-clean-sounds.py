#!/usr/bin/env python3
"""Regenerate whistle-contaminated samples with a measure-before-accept loop.

For each target: generate a candidate (ElevenLabs), analyze its spectrum, and
accept ONLY if the whistle/thinness gates pass. If a candidate fails, apply a
targeted notch/lowpass (ffmpeg) at the detected tonal peaks and re-measure.
Up to 3 generation attempts with varied prompts; the old file is only replaced
by a candidate that passed. API key is read from ~/.elevenlabs/api_key and
never printed.
"""
import subprocess, sys, os, json, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
spec = importlib.util.spec_from_file_location(
    "aa", os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio-analyze.py"))
aa = importlib.util.module_from_spec(spec); spec.loader.exec_module(aa)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOUNDS = os.path.join(ROOT, "sounds")
TMP = os.path.join(SOUNDS, "_candidates")
os.makedirs(TMP, exist_ok=True)
KEY = open(os.path.expanduser("~/.elevenlabs/api_key")).read().strip()

TARGETS = [
    {
        "name": "engine-high",
        "dur": 6,
        "prompts": [
            "formula one race car engine sustained at very high rpm, wide open throttle, deep bass-heavy gruff mechanical roar, thick dense growling low end, smooth broadband engine texture, dark muffled top end, steady continuous seamless loop",
            "race car v6 turbo engine screaming lap at full throttle recorded trackside, chest-thumping bass rumble, raspy gruff growl, rich broadband roar with rolled-off treble, constant level seamless loop",
            "high rpm racing engine roar, deep and dark, heavy low-frequency rumble foundation, coarse gravelly growl texture, soft rounded highs, unchanging steady seamless loop",
        ],
        # engines must be bassy and tone-free
        "max_whistle": 4.0, "min_bass_ratio": 0.8, "peak_limit": (900, 14, -24),
        "postfix_shelf": "treble=g=-6:f=3000",
    },
    {
        "name": "gear-shift",
        "dur": 0.6,
        "prompts": [
            "racing car sequential gearbox upshift, deep solid mechanical thunk with a brief muffled ignition cut, low pitched, punchy, very short",
            "heavy metal gear engagement clunk inside a race car transmission, deep dull mechanical impact, short single hit, no ringing",
            "single deep percussive mechanical shift knock, low frequency thud with soft click, very short",
        ],
        "max_whistle": 8.0, "min_bass_ratio": 0, "peak_limit": (3000, 14, -24),
        "postfix_shelf": "lowpass=f=2800",
    },
    {
        "name": "brake-screech",
        "dur": 2,
        "prompts": [
            "heavy racing car carbon brakes under extreme load, deep low-frequency groan and judder rumble, dark grinding moan, no squeal, short",
            "deep brake groan of a race car slowing hard, low rumbling shudder and juddering vibration, dark and bassy, short",
            "low frequency mechanical juddering vibration of hard braking, deep grinding rumble, short",
        ],
        "max_whistle": 10.0, "min_bass_ratio": 3.0, "peak_limit": (1000, 14, -20),
        "postfix_shelf": "lowpass=f=1600",
    },
    {
        "name": "kerb-rumble",
        "dur": 2.5,
        "prompts": [
            "race car tires thudding rapidly over a serrated rumble strip kerb, deep fast rhythmic bass thumping, dark and percussive, continuous steady loop",
            "rapid deep drumming of tires over ridged kerb strips, low frequency rhythmic thudding, muffled, continuous seamless loop",
            "fast heavy rhythmic thumps of a car crossing a rumble strip, bassy percussive knocking, steady continuous loop",
        ],
        "max_whistle": 10.0, "min_bass_ratio": 3.0, "peak_limit": (2000, 14, -22),
        "postfix_shelf": "lowpass=f=2400",
    },
]

def gen(prompt, dur, out):
    body = json.dumps({"text": prompt, "duration_seconds": dur, "prompt_influence": 0.55})
    r = subprocess.run(
        ["curl", "-s", "-w", "%{http_code}", "-o", out,
         "-X", "POST", "https://api.elevenlabs.io/v1/sound-generation",
         "-H", f"xi-api-key: {KEY}", "-H", "Content-Type: application/json",
         "-d", body], capture_output=True, text=True)
    return r.stdout.strip() == "200" and os.path.getsize(out) > 4000

def gates(t, r):
    """Return list of failure strings (empty = pass)."""
    fails = []
    if r["whistle_score"] > t["max_whistle"]:
        fails.append(f"whistle {r['whistle_score']} > {t['max_whistle']}")
    if r["bass_to_high_ratio"] < t["min_bass_ratio"]:
        fails.append(f"bass/high {r['bass_to_high_ratio']} < {t['min_bass_ratio']}")
    fmax, promlim, rellim = t["peak_limit"]
    for p in r["top_tonal_peaks"]:
        if p["hz"] > fmax and p["prominence_db"] > promlim and p["rel_db"] > rellim:
            fails.append(f"tonal peak {p['hz']}Hz prom {p['prominence_db']}dB rel {p['rel_db']}dB")
    return fails

def postfix(t, src, dst, peaks):
    """Notch the detected offending peaks + shelf, re-encode."""
    filters = []
    fmax, promlim, rellim = t["peak_limit"]
    for p in peaks[:4]:
        if p["prominence_db"] > 12 and p["rel_db"] > -30:
            w = max(120, int(p["hz"] * 0.12))
            filters.append(f"bandreject=f={p['hz']}:w={w}")
    filters.append(t["postfix_shelf"])
    af = ",".join(filters)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src, "-af", af,
                    "-codec:a", "libmp3lame", "-q:a", "2", dst], check=True)

def run_target(t):
    name = t["name"]
    for attempt, prompt in enumerate(t["prompts"]):
        cand = os.path.join(TMP, f"{name}-a{attempt}.mp3")
        if not gen(prompt, t["dur"], cand):
            print(f"  {name} a{attempt}: generation failed (HTTP/size)")
            continue
        r = aa.analyze(cand)
        fails = gates(t, r)
        print(f"  {name} a{attempt}: whistle={r['whistle_score']} bass/high={r['bass_to_high_ratio']} -> {'PASS' if not fails else fails}")
        if not fails:
            shutil.copy(cand, os.path.join(SOUNDS, f"{name}.mp3"))
            return ("regenerated", attempt, r)
        # targeted notch fallback
        fixed = os.path.join(TMP, f"{name}-a{attempt}-notched.mp3")
        postfix(t, cand, fixed, r["top_tonal_peaks"])
        r2 = aa.analyze(fixed)
        fails2 = gates(t, r2)
        print(f"  {name} a{attempt}+notch: whistle={r2['whistle_score']} bass/high={r2['bass_to_high_ratio']} -> {'PASS' if not fails2 else fails2}")
        if not fails2:
            shutil.copy(fixed, os.path.join(SOUNDS, f"{name}.mp3"))
            return ("regenerated+notched", attempt, r2)
    # last resort: notch the CURRENT shipped file so it at least stops whistling
    cur = os.path.join(SOUNDS, f"{name}.mp3")
    fixed = os.path.join(TMP, f"{name}-cur-notched.mp3")
    r0 = aa.analyze(cur)
    postfix(t, cur, fixed, r0["top_tonal_peaks"])
    r3 = aa.analyze(fixed)
    print(f"  {name} fallback-notch-current: whistle={r3['whistle_score']} -> {gates(t, r3) or 'PASS'}")
    if not gates(t, r3):
        shutil.copy(fixed, cur)
        return ("current+notched", -1, r3)
    return ("FAILED", -1, r3)

results = {}
only = sys.argv[1:] or None
for t in TARGETS:
    if only and t["name"] not in only:
        continue
    print(f"== {t['name']}")
    results[t["name"]] = run_target(t)

print("\nSUMMARY")
ok = True
for name, (how, attempt, r) in results.items():
    print(f"  {name}: {how} (attempt {attempt}) whistle={r['whistle_score']} bass/high={r['bass_to_high_ratio']}")
    if how == "FAILED":
        ok = False
sys.exit(0 if ok else 1)
