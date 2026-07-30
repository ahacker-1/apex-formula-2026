import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

const SHOT_NAMES = [
  'r4-hero-01',
  'r4-hero-02',
  'r4-hero-03',
  'r4-hero-04',
  'r4-hero-05',
];
const FINAL_COMMIT_NAME = 'r4-hero-contracts';
const persistedName = (runId, logicalName) => logicalName === FINAL_COMMIT_NAME
  ? logicalName
  : `${runId}-${logicalName}`;

test.describe.configure({ mode: 'serial' });

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function installMemorySink(page, { postStatus = 200, initialRecords = [] } = {}) {
  const writes = [];
  const persisted = new Map();
  const verificationReads = [];
  for (const record of initialRecords) persisted.set(record.name, {
    ...record,
    body: Buffer.from(record.body),
  });

  await page.route(/\/tools\/shots\/[^/?]+\.png(?:\?.*)?$/, async route => {
    const url = new URL(route.request().url());
    const name = decodeURIComponent(url.pathname.split('/').at(-1).replace(/\.png$/, ''));
    verificationReads.push(name);
    const record = persisted.get(name);
    if (!record) {
      await route.fulfill({ status: 404, body: 'not persisted' });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': record.contentType },
      body: record.body,
    });
  });

  await page.route(/\/shot(?:\?.*)?$/, async route => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }
    const url = new URL(request.url());
    const name = url.searchParams.get('name');
    const runId = url.searchParams.get('run');
    const contentType = request.headers()['content-type'] || '';
    const body = Buffer.from(request.postDataBuffer() || []);
    const record = { name, runId, contentType, body };
    writes.push(record);

    const resolvedStatus = typeof postStatus === 'function'
      ? await postStatus(record, writes)
      : postStatus;
    if (resolvedStatus < 200 || resolvedStatus >= 300) {
      await route.fulfill({ status: resolvedStatus, body: 'forced probe sink failure' });
      return;
    }

    persisted.set(name, record);
    await route.fulfill({ status: resolvedStatus, body: 'ok' });
  });

  return { writes, persisted, verificationReads };
}

async function runRig(page, query = '') {
  await page.goto(`/tools/hero-capture.html${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__RIG__?.done === true, null, { timeout: 285_000 });
  return page.evaluate(() => {
    const rig = window.__RIG__;
    return {
      schema: rig.schema,
      runId: rig.runId,
      done: rig.done,
      pass: rig.pass,
      error: rig.error,
      failed: rig.failed,
      authority: rig.authority,
      assetGate: rig.assetGate,
      persistence: rig.persistence,
      shots: rig.shots.map(shot => ({ name: shot.name, pass: shot.pass })),
      manifest: rig.manifest,
    };
  });
}

for (const missing of [
  {
    label: 'shipping photo',
    url: /\/textures\/asphalt\.png(?:\?.*)?$/,
    failure: 'photo asphalt (asphalt.png)',
  },
  {
    label: 'HDRI',
    url: /\/textures\/hdri\/day\.hdr(?:\?.*)?$/,
    failure: 'HDRI day',
  },
  {
    label: 'sculpted GLB',
    url: /\/assets\/f1car-2026\.glb(?:\?.*)?$/,
    failure: 'sculpted GLB assets/f1car-2026.glb',
  },
]) {
  test(`a required ${missing.label} 404 fails closed without publishing image evidence`, async ({ page }) => {
    const sink = await installMemorySink(page);
    await page.route(missing.url, route => route.fulfill({ status: 404, body: 'missing' }));

    const rig = await runRig(page);

    expect(rig.done).toBe(true);
    expect(rig.pass).toBe(false);
    expect(rig.assetGate?.pass).toBe(false);
    expect(rig.assetGate?.failures).toContain(missing.failure);
    expect(rig.error).toContain('Required visual assets unavailable');
    expect(rig.failed.some(failure => failure.includes(missing.failure))).toBe(true);
    expect(rig.persistence).toEqual([]);
    expect(rig.shots).toEqual([]);
    expect(sink.writes.map(write => write.name)).toEqual([FINAL_COMMIT_NAME, FINAL_COMMIT_NAME]);
    expect(sink.writes.every(write => write.contentType.includes('application/json'))).toBe(true);
    expect(sink.verificationReads).toEqual([FINAL_COMMIT_NAME, FINAL_COMMIT_NAME]);
    expect(JSON.parse(sink.writes[0].body.toString('utf8')))
      .toMatchObject({ runId: rig.runId, status: 'running', pass: false, complete: false });
    expect(JSON.parse(sink.writes[1].body.toString('utf8')))
      .toMatchObject({ runId: rig.runId, status: 'failed', pass: false, complete: false, done: true });
    expect(rig.authority).toMatchObject({ name: FINAL_COMMIT_NAME, status: 'failed', verified: true });
    await expect(page.locator('#log')).toContainText('RIG FAILURE');
  });
}

test('a stale passing authority is invalidated before an asset failure', async ({ page }) => {
  const stale = Buffer.from(JSON.stringify({
    schema: 'apex-formula.hero-capture/v1',
    runId: 'stale-run',
    status: 'passed',
    pass: true,
    complete: true,
  }));
  const sink = await installMemorySink(page, {
    initialRecords: [
      { name: FINAL_COMMIT_NAME, contentType: 'application/json', body: stale },
      { name: 'hero-stale-r4-hero-01', contentType: 'image/png', body: Buffer.from('stale image') },
    ],
  });
  await page.route(/\/textures\/asphalt\.png(?:\?.*)?$/, route => route.fulfill({ status: 404, body: 'missing' }));

  const rig = await runRig(page);

  const authority = JSON.parse(sink.persisted.get(FINAL_COMMIT_NAME).body.toString('utf8'));
  expect(authority).toMatchObject({
    runId: rig.runId,
    status: 'failed',
    pass: false,
    complete: false,
    done: true,
  });
  expect(authority.runId).not.toBe('stale-run');
  expect(sink.writes.map(write => JSON.parse(write.body.toString('utf8')).status))
    .toEqual(['running', 'failed']);
  expect(rig.pass).toBe(false);
  expect(rig.done).toBe(true);
});

test('a non-2xx /shot response fails closed without publishing the final JSON commit', async ({ page }) => {
  const sink = await installMemorySink(page, { postStatus: 500 });

  const rig = await runRig(page);

  expect(rig.done).toBe(true);
  expect(rig.pass).toBe(false);
  expect(rig.error).toContain('Evidence persistence failed');
  expect(rig.error).toContain('HTTP 500');
  expect(rig.failed.some(failure => failure.startsWith('rig: Evidence persistence failed'))).toBe(true);
  expect(rig.persistence).toEqual([]);
  expect(sink.writes).toHaveLength(2);
  expect(sink.writes.every(write => write.name === FINAL_COMMIT_NAME)).toBe(true);
  expect(sink.writes.every(write => write.contentType.includes('application/json'))).toBe(true);
  expect(JSON.parse(sink.writes[0].body.toString('utf8')))
    .toMatchObject({ runId: rig.runId, status: 'running', pass: false, complete: false });
  expect(JSON.parse(sink.writes[1].body.toString('utf8')))
    .toMatchObject({ runId: rig.runId, status: 'failed', pass: false, complete: false });
  expect(rig.authority).toMatchObject({ status: 'failed', verified: false });
  expect(sink.verificationReads).toEqual([]);
  await expect(page.locator('#log')).toContainText('RIG FAILURE');
});

test('a final JSON POST 500 replaces the running authority with a verified failed marker', async ({ page }) => {
  const sink = await installMemorySink(page, {
    postStatus: record => {
      if (record.name !== FINAL_COMMIT_NAME) return 200;
      const marker = JSON.parse(record.body.toString('utf8'));
      return marker.status === 'passed' ? 500 : 200;
    },
  });

  const rig = await runRig(page);

  expect(rig.done).toBe(true);
  expect(rig.pass).toBe(false);
  expect(rig.error).toContain(`Evidence persistence failed for ${FINAL_COMMIT_NAME}: HTTP 500`);
  expect(rig.authority).toMatchObject({ name: FINAL_COMMIT_NAME, status: 'failed', verified: true });
  expect(rig.manifest).toMatchObject({
    runId: rig.runId,
    status: 'failed',
    pass: false,
    complete: false,
    done: true,
  });
  expect(sink.writes.map(write => write.name)).toEqual([
    FINAL_COMMIT_NAME,
    ...SHOT_NAMES.map(name => persistedName(rig.runId, name)),
    FINAL_COMMIT_NAME,
    FINAL_COMMIT_NAME,
  ]);
  const persistedAuthority = JSON.parse(sink.persisted.get(FINAL_COMMIT_NAME).body.toString('utf8'));
  expect(persistedAuthority).toMatchObject({ runId: rig.runId, status: 'failed', pass: false });
  expect(sink.writes.some(write => write.name === FINAL_COMMIT_NAME
    && JSON.parse(write.body.toString('utf8')).status === 'passed')).toBe(true);
});

test('a stalled required asset times out into a verified failed authority', async ({ page }) => {
  const sink = await installMemorySink(page);
  await page.route(/\/textures\/asphalt\.png(?:\?.*)?$/, () => new Promise(() => {}));

  const rig = await runRig(page, '?assetTimeoutMs=1000');

  expect(rig.done).toBe(true);
  expect(rig.pass).toBe(false);
  expect(rig.error).toContain('photo asphalt (asphalt.png) timed out after 1000ms');
  expect(rig.assetGate?.pass).toBe(false);
  expect(rig.persistence).toEqual([]);
  expect(rig.authority).toMatchObject({ status: 'failed', verified: true });
  expect(JSON.parse(sink.persisted.get(FINAL_COMMIT_NAME).body.toString('utf8')))
    .toMatchObject({ runId: rig.runId, status: 'failed', pass: false });
});

test('renderer setup failure reaches done=true and replaces the running authority', async ({ page }) => {
  const sink = await installMemorySink(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
      if (String(type).includes('webgl')) throw new Error('forced WebGL context failure');
      return original.call(this, type, ...args);
    };
  });

  const rig = await runRig(page);

  expect(rig.done).toBe(true);
  expect(rig.pass).toBe(false);
  expect(rig.error).toMatch(/WebGL|context/i);
  expect(rig.persistence).toEqual([]);
  expect(rig.authority).toMatchObject({ status: 'failed', verified: true });
  expect(JSON.parse(sink.persisted.get(FINAL_COMMIT_NAME).body.toString('utf8')))
    .toMatchObject({ runId: rig.runId, status: 'failed', pass: false });
});

test('a real initial sink-write failure keeps stale success guarded by ownership', async ({ request }) => {
  const staleRunId = `hero-stale-${randomUUID()}`;
  const failedRunId = `hero-failed-${randomUUID()}`;
  const contenderRunId = `hero-contender-${randomUUID()}`;
  const marker = (runId, status) => ({
    schema: 'apex-formula.hero-capture/v1',
    runId,
    rig: 'tests/browser/visual-evidence/hero-capture.probe.mjs',
    status,
    pass: status === 'passed',
    complete: status === 'passed',
    done: status !== 'running',
    activeLock: status === 'running' ? 'tools/shots/.hero-capture.lock/owner.json' : null,
  });
  const postAuthority = (runId, status, headers = {}) => request.post(
    `/shot?name=${FINAL_COMMIT_NAME}&run=${encodeURIComponent(runId)}`,
    {
      data: JSON.stringify(marker(runId, status)),
      headers: { 'Content-Type': 'application/json', ...headers },
    },
  );

  expect((await postAuthority(staleRunId, 'running')).ok()).toBe(true);
  expect((await postAuthority(staleRunId, 'passed')).ok()).toBe(true);
  expect(await (await request.get(`/tools/shots/${FINAL_COMMIT_NAME}.png`)).json())
    .toMatchObject({ runId: staleRunId, status: 'passed', pass: true });

  let cleaned = false;
  try {
    const forcedFailure = await postAuthority(failedRunId, 'running', {
      'X-Apex-Evidence-Probe': 'fail-write',
    });
    expect(forcedFailure.status()).toBe(500);
    expect(await (await request.get(`/tools/shots/${FINAL_COMMIT_NAME}.png`)).json())
      .toMatchObject({ runId: staleRunId, status: 'passed', pass: true });
    expect(await (await request.get('/tools/shots/.hero-capture.lock/owner.json')).json())
      .toMatchObject({ runId: failedRunId, status: 'running' });

    const contender = await postAuthority(contenderRunId, 'running');
    expect(contender.status()).toBe(409);
    expect(await contender.text()).toContain(`already owned by ${failedRunId}`);

    expect((await postAuthority(failedRunId, 'failed')).ok()).toBe(true);
    cleaned = true;
    expect(await (await request.get(`/tools/shots/${FINAL_COMMIT_NAME}.png`)).json())
      .toMatchObject({ runId: failedRunId, status: 'failed', pass: false });
    expect((await request.get('/tools/shots/.hero-capture.lock/owner.json')).status()).toBe(404);
  } finally {
    if (!cleaned) await postAuthority(failedRunId, 'failed').catch(() => {});
  }
});

test('a concurrent hero page cannot steal or overwrite the active run', async ({ page, context }) => {
  test.setTimeout(30_000);
  await page.route(/\/textures\/asphalt\.png(?:\?.*)?$/, () => new Promise(() => {}));
  await page.goto('/tools/hero-capture.html?assetTimeoutMs=1000', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.__RIG__?.authority?.status))
    .toBe('running');
  const firstRunId = await page.evaluate(() => window.__RIG__.runId);
  const competingPage = await context.newPage();
  try {
    await competingPage.goto('/tools/hero-capture.html', { waitUntil: 'domcontentloaded' });
    await competingPage.waitForFunction(() => window.__RIG__?.done === true);
    const competingRig = await competingPage.evaluate(() => ({
      runId: window.__RIG__.runId,
      pass: window.__RIG__.pass,
      done: window.__RIG__.done,
      error: window.__RIG__.error,
      authority: window.__RIG__.authority,
      persistence: window.__RIG__.persistence,
    }));
    expect(competingRig.runId).not.toBe(firstRunId);
    expect(competingRig).toMatchObject({
      pass: false,
      done: true,
      authority: { status: 'failed', verified: false },
      persistence: [],
    });
    expect(competingRig.error).toContain('HTTP 409');
    expect(competingRig.error).toContain(`already owned by ${firstRunId}`);

    await page.waitForFunction(() => window.__RIG__?.done === true, null, { timeout: 10_000 });
    const firstRig = await page.evaluate(() => ({
      runId: window.__RIG__.runId,
      pass: window.__RIG__.pass,
      authority: window.__RIG__.authority,
    }));
    expect(firstRig).toMatchObject({
      runId: firstRunId,
      pass: false,
      authority: { status: 'failed', verified: true },
    });
    const persistedAuthority = await page.evaluate(async () => {
      const response = await fetch(`/tools/shots/r4-hero-contracts.png?probe=${Date.now()}`,
        { cache: 'no-store' });
      return response.json();
    });
    expect(persistedAuthority).toMatchObject({ runId: firstRunId, status: 'failed', pass: false });
    expect(await page.evaluate(async () => fetch(
      `/tools/shots/.hero-capture.lock/owner.json?probe=${Date.now()}`,
      { cache: 'no-store' },
    ).then(response => response.status))).toBe(404);
  } finally {
    await page.waitForFunction(() => window.__RIG__?.done === true, null, { timeout: 10_000 }).catch(() => {});
    await competingPage.close();
  }
});

test('the happy path passes every hero contract and verifies five PNGs before the final JSON commit', async ({ page }) => {
  const sink = await installMemorySink(page);

  const rig = await runRig(page);

  expect(rig.done).toBe(true);
  expect(rig.pass).toBe(true);
  expect(rig.error).toBeNull();
  expect(rig.failed).toEqual([]);
  expect(rig.assetGate).toMatchObject({
    pass: true,
    requiredHdris: ['day', 'dusk', 'night'],
    sculptedGlb: true,
    failures: [],
  });
  expect(rig.assetGate.requiredPhotos).toHaveLength(10);
  expect(rig.shots).toEqual(SHOT_NAMES.map(name => ({ name, pass: true })));

  const persistedShotNames = SHOT_NAMES.map(name => persistedName(rig.runId, name));
  const expectedWrites = [FINAL_COMMIT_NAME, ...persistedShotNames, FINAL_COMMIT_NAME];
  const committedArtifacts = [...SHOT_NAMES, FINAL_COMMIT_NAME];
  expect(sink.writes.map(write => write.name)).toEqual(expectedWrites);
  expect(sink.verificationReads).toEqual(expectedWrites);
  expect(sink.persisted.size).toBe(committedArtifacts.length);
  expect(rig.persistence.map(record => record.name)).toEqual(committedArtifacts);
  expect(rig.persistence.every(record => record.verified === true)).toBe(true);
  expect(rig.persistence.every(record => record.persistedName
    === persistedName(rig.runId, record.name))).toBe(true);
  expect(JSON.parse(sink.writes[0].body.toString('utf8')))
    .toMatchObject({ runId: rig.runId, status: 'running', pass: false, complete: false });

  for (const name of committedArtifacts) {
    const write = sink.persisted.get(persistedName(rig.runId, name));
    const exposed = rig.persistence.find(record => record.name === name);
    expect(write.body.byteLength).toBeGreaterThan(0);
    expect(exposed.bytes).toBe(write.body.byteLength);
    expect(exposed.sha256).toBe(sha256(write.body));
  }

  for (const name of SHOT_NAMES) {
    const write = sink.persisted.get(persistedName(rig.runId, name));
    expect(write.contentType).toContain('image/png');
    expect([...write.body.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }

  const finalWrite = sink.persisted.get(FINAL_COMMIT_NAME);
  expect(finalWrite.contentType).toContain('application/json');
  const finalCommit = JSON.parse(finalWrite.body.toString('utf8'));
  expect(finalCommit).toMatchObject({
    schema: rig.schema,
    runId: rig.runId,
    rig: 'tools/hero-capture.html',
    resolution: '2560x1440',
    status: 'passed',
    complete: true,
    done: true,
    pass: true,
    failed: [],
  });
  expect(finalCommit.shots.map(shot => ({ name: shot.name, pass: shot.pass }))).toEqual(rig.shots);
  expect(finalCommit.persistedShots.map(record => record.name)).toEqual(SHOT_NAMES);
  expect(finalCommit.persistedShots.every(record => record.verified === true)).toBe(true);
  expect(rig.manifest).toEqual(finalCommit);
  expect(rig.authority).toMatchObject({ name: FINAL_COMMIT_NAME, status: 'passed', verified: true });
  expect(await page.evaluate(() => typeof window.__RIG__.rerun)).toBe('undefined');
  const isolatedCorruption = await page.evaluate(() => {
    const pixelCount = 2560 * 1440;
    const first = { data: new Uint8ClampedArray(pixelCount * 4) };
    const second = { data: new Uint8ClampedArray(pixelCount * 4) };
    second.data[(pixelCount - 1) * 4] = 9;
    const metric = window.__DBG__.repeatFrameStability(first, second);
    const tolerance = window.__RIG__.captureContract.repeatTolerance;
    return {
      metric,
      accepted: metric.meanAbsoluteChannelDifference <= tolerance.meanAbsoluteChannelDifferenceMax
        && metric.maxAbsoluteChannelDifference <= tolerance.maxAbsoluteChannelDifferenceMax
        && metric.changedPixelRatio <= tolerance.changedPixelRatioMax,
    };
  });
  expect(isolatedCorruption.metric.maxAbsoluteChannelDifference).toBe(9);
  expect(isolatedCorruption.metric.meanAbsoluteChannelDifference).toBe(9 / (2560 * 1440 * 3));
  expect(isolatedCorruption.metric.changedPixelRatio).toBe(1 / (2560 * 1440));
  expect(isolatedCorruption.accepted).toBe(false);
  await expect(page.locator('#log')).toContainText('ALL FRAMING CONTRACTS PASS');
});
