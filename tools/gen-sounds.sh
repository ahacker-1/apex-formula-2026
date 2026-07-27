#!/usr/bin/env bash
# Generate the game's sample pack via the ElevenLabs sound-generation API.
# Reads the key from ~/.elevenlabs/api_key (never echoed). Saves MP3s to sounds/.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY=$(tr -d '\n' < ~/.elevenlabs/api_key)
mkdir -p sounds

gen() { # name duration prompt
  local name="$1" dur="$2" prompt="$3"
  if [ -s "sounds/${name}.mp3" ]; then echo "skip ${name} (exists)"; return; fi
  echo "generating ${name}…"
  local code
  code=$(curl -s -w "%{http_code}" -o "sounds/${name}.mp3" \
    -X POST "https://api.elevenlabs.io/v1/sound-generation" \
    -H "xi-api-key: ${KEY}" -H "Content-Type: application/json" \
    -d "{\"text\": \"${prompt}\", \"duration_seconds\": ${dur}, \"prompt_influence\": 0.55}")
  if [ "$code" != "200" ]; then
    echo "  FAILED ${name}: HTTP ${code} — $(head -c 200 "sounds/${name}.mp3")"
    rm -f "sounds/${name}.mp3"
    return 1
  fi
  echo "  ok: $(du -h "sounds/${name}.mp3" | cut -f1)"
}

gen crowd-ambience 12 "large motorsport stadium crowd ambience, distant continuous cheering and murmur of thousands of spectators, steady background bed, no music, no announcer" || true
gen wheel-gun 2.5 "formula one pit stop pneumatic wheel gun, four rapid mechanical rattle bursts in quick succession, high pressure air tool" || true
gen gear-shift 0.6 "racing car sequential gearbox upshift, sharp mechanical click with a brief ignition cut blip, very short" || true
gen collision 1.2 "carbon fiber racing car impact, hard thud with sharp debris rattle and scrape, short" || true
gen kerb-rumble 2.5 "race car tires rumbling rapidly over a serrated rumble strip kerb, fast rhythmic thudding, continuous steady loop" || true
gen gravel 2.5 "car tires plowing through a loose gravel trap, continuous dense crunching and stone spray, steady loop" || true
gen radio-squelch 0.8 "two-way race radio squelch click with a very brief static burst, short" || true
gen tyre-screech 1.5 "racing tire screeching and skidding on asphalt under hard cornering, single sustained screech" || true
gen finish-cheer 4 "huge crowd eruption, cheering and applause celebrating a race victory, swelling roar" || true

echo "--- pack:"
ls -la sounds/ | tail -n +2
