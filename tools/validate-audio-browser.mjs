// Focused real-WebAudio smoke check. Run after `npm run build`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const port = 8437;
const server = spawn('python3', ['-u', 'tools/devserver.py', String(port), 'dist'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;

try {
  let listening = false;
  for (let attempt = 0; attempt < 50 && !listening; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      listening = response.ok;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (!listening) throw new Error('audio browser server did not start');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('apexf1_onboarding_v1', '1');
    localStorage.setItem('apexf1_last_race', JSON.stringify({ driverId: 'hacker', trackId: 'melbourne' }));
    window.requestAnimationFrame = () => 1;
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByRole('button', { name: /RACE NOW/ }).click();
  await page.waitForFunction(() => window.__game?.audio);
  const result = await page.evaluate(async () => {
    const audio = window.__game.audio;
    audio.init();
    if (audio.ctx?.state === 'suspended') await audio.ctx.resume();
    const nodesBefore = [audio.scrubGain, audio.lockGain, audio.rainGain, audio.bottomGain];
    const state = {
      rpmFrac: 0.72, throttle: 0.8, brake: 0.92, speed: 55, gear: 5,
      slip: 0.9, kerb: 0.7, boost: true, offtrack: false,
      wallScrape: 0.8, contactSide: -1, wetness: 0.8, rain: 0.55,
      damage: 0.4, bottoming: 0.8, cockpit: true,
    };
    for (let i = 0; i < 30; i++) audio.update(1 / 60, state);
    await new Promise(resolve => setTimeout(resolve, 90));
    audio.passBy({ id: 'browser-rival', side: 1, distance: 4, relativeSpeed: 35, intensity: 0.9 });
    return {
      ready: audio.ready,
      contextState: audio.ctx.state,
      pooled: nodesBefore[0] === audio.scrubGain && nodesBefore[1] === audio.lockGain &&
        nodesBefore[2] === audio.rainGain && nodesBefore[3] === audio.bottomGain,
      scrape: audio.contactScrapeGain.gain.value,
      scrub: audio.scrubGain.gain.value,
      lockup: audio.lockGain.gain.value,
      rain: audio.rainGain.gain.value,
      cockpitCutoff: audio.perspectiveLP.frequency.value,
      activeOpponents: audio._opponentVoices.filter(v => v.activeUntil > audio.ctx.currentTime).length,
    };
  });
  assert.equal(result.ready, true);
  assert.equal(result.contextState, 'running');
  assert.equal(result.pooled, true);
  assert.ok(result.scrape > 0.05, `scrape gain ${result.scrape}`);
  assert.ok(result.scrub > 0.01 && result.lockup > 0.01 && result.rain > 0.005);
  assert.ok(result.cockpitCutoff < 7000);
  assert.equal(result.activeOpponents, 1);
  console.log(`[audio-browser] WebAudio graph passed ${JSON.stringify(result)}`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
