import { test, expect } from '@playwright/test';

test('semantic event keys survive delayed radio crossover without stealing the next VSC green', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('apexf1_onboarding_v1', '1');
    localStorage.setItem('apexf1_settings', JSON.stringify({ quali: false }));
  });
  await page.goto('/?seed=hud-event-contract-2026');
  await page.getByRole('button', { name: /QUICK RACE/ }).click();
  await page.locator('.drv[data-d="hacker"]').click();
  await page.getByRole('button', { name: /CONTINUE/ }).click();
  await page.locator('.track-card[data-t="melbourne"]').click();
  await page.waitForFunction(
    () => window.__game?.session && window.__game.state === 'race',
    null,
    { timeout: 30_000, polling: 50 },
  );

  const result = await page.evaluate(async () => {
    const game = window.__game;
    const session = game.session;
    const hud = game.hud;
    game.paused = true;
    session.phase = 'racing';
    session.lightsOut = false;
    session.radioQueue.length = 0;
    hud._hideRadio();
    for (const node of document.querySelectorAll('#hud-live-polite, #hud-live-assertive')) {
      node.textContent = '';
    }

    const messages = [];
    const originalMessage = hud.message.bind(hud);
    hud.message = (text, color, meta) => {
      messages.push({ text, color, eventKey: meta?.eventKey || '' });
      return originalMessage(text, color, meta);
    };

    const live = [];
    const clean = value => String(value || '').replaceAll('\u2063', '').trim();
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const text = clean(Array.from(record.addedNodes || []).map(node => node.textContent || '').join(''));
        if (text) live.push({ target: record.target.id, text });
      }
    });
    for (const node of document.querySelectorAll('#hud-live-polite, #hud-live-assertive')) {
      observer.observe(node, { childList: true, characterData: true, subtree: true });
    }
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const queueSnapshot = item => item && {
      text: item.text,
      tone: item.tone,
      eventKey: item.eventKey || '',
    };

    session._startVSC(5);
    const cycle1Deploy = queueSnapshot(session.radioQueue.at(-1));
    hud.update(0.05);
    session._vscEnding = true;
    session._updateVSC(6);
    const cycle1Green = queueSnapshot(session.radioQueue.at(-1));
    hud.update(0.05);
    await flush();

    session._startVSC(5);
    const cycle2Deploy = queueSnapshot(session.radioQueue.at(-1));
    hud.update(0.05);
    await flush();

    // The cycle-1 deployment card is still occupying the visual radio slot.
    // Expire it, then dequeue the stale cycle-1 green while cycle 2 is active.
    const beforeStale = live.length;
    hud.update(4.1);
    hud.update(0.05);
    await flush();
    const staleWrites = live.slice(beforeStale);
    const staleRadio = {
      vscActive: session.vsc.active,
      label: hud.$('radiocard').getAttribute('aria-label'),
      className: hud.$('radiocard').className,
    };

    const beforeActualGreen = live.length;
    session._vscEnding = true;
    session._updateVSC(6);
    const cycle2Green = queueSnapshot(session.radioQueue.at(-1));
    hud.update(0.05);
    await flush();
    const actualGreenWrites = live.slice(beforeActualGreen);

    // Drain the delayed radio cards. Their stamped keys must remain duplicates
    // of the already-announced source events even though session state changed.
    for (let i = 0; i < 3; i++) {
      hud.update(4.1);
      hud.update(0.05);
    }

    const entry = session.entries.find(item => !item.isPlayer);
    entry.boxThisLap = false;
    entry.plannedPitLap = 999;
    entry.phys.wear = 0;
    entry.finished = false;
    session.fastestLap = null;
    entry.lap = -1;
    entry.maxLap = -1;
    session.raceTime = 100;
    session._onCross(entry);
    session.raceTime = 170;
    session._onCross(entry);
    hud.update(0.05);
    session.raceTime = 239;
    session._onCross(entry);
    hud.update(0.05);
    await flush();

    const semanticLive = [...live];
    const semanticKeys = [...hud._announcedEventKeys];
    const fastestStateKey = session.fastestLap?.eventKey || '';
    const beforeUnrelated = live.length;
    hud.message('WEATHER UPDATE — LIGHT RAIN', '');
    await flush();
    const unrelatedWrites = live.slice(beforeUnrelated);

    observer.disconnect();
    hud.message = originalMessage;
    return {
      liveRegions: document.querySelectorAll('[aria-live]').length,
      semanticLive,
      semanticKeys,
      messages,
      queue: { cycle1Deploy, cycle1Green, cycle2Deploy, cycle2Green },
      staleWrites,
      staleRadio,
      actualGreenWrites,
      fastestStateKey,
      unrelatedWrites,
    };
  });

  expect(result.liveRegions).toBe(2);
  expect(result.queue).toEqual({
    cycle1Deploy: {
      text: 'Virtual safety car deployed — hold the delta.',
      tone: 'warning',
      eventKey: 'vsc:1:deploy',
    },
    cycle1Green: {
      text: 'Green flag — go, go, go.',
      tone: 'info',
      eventKey: 'vsc:1:green',
    },
    cycle2Deploy: {
      text: 'Virtual safety car deployed — hold the delta.',
      tone: 'warning',
      eventKey: 'vsc:2:deploy',
    },
    cycle2Green: {
      text: 'Green flag — go, go, go.',
      tone: 'info',
      eventKey: 'vsc:2:green',
    },
  });
  expect(result.messages.filter(item => /VIRTUAL SAFETY CAR|GREEN FLAG/.test(item.text)).map(item => item.eventKey)).toEqual([
    'vsc:1:deploy',
    'vsc:1:green',
    'vsc:2:deploy',
    'vsc:2:green',
  ]);
  expect(result.staleRadio).toMatchObject({
    vscActive: true,
    className: expect.stringContaining('on'),
    label: expect.stringMatching(/Race engineer: Green flag/),
  });
  expect(result.staleWrites).toEqual([]);
  expect(result.actualGreenWrites).toHaveLength(1);
  expect(result.actualGreenWrites[0].text).toMatch(/GREEN FLAG|RACE RESUMES/);

  const counts = {
    deploy: result.semanticLive.filter(item => /VIRTUAL SAFETY CAR|DEPLOYED/i.test(item.text)).length,
    green: result.semanticLive.filter(item => /GREEN FLAG|RACE RESUMES/i.test(item.text)).length,
    fastest: result.semanticLive.filter(item => /FASTEST LAP/i.test(item.text)).length,
  };
  expect(counts).toEqual({ deploy: 2, green: 2, fastest: 2 });
  expect(result.semanticLive).toHaveLength(6);
  expect(result.semanticKeys).toEqual([
    'vsc:1:deploy',
    'vsc:1:green',
    'vsc:2:deploy',
    'vsc:2:green',
    'fastest:nyholm:70',
    'fastest:nyholm:69',
  ]);
  expect(result.fastestStateKey).toBe('fastest:nyholm:69');
  expect(result.unrelatedWrites).toHaveLength(1);
  expect(result.unrelatedWrites[0].text).toBe('WEATHER UPDATE — LIGHT RAIN');
  expect(errors).toEqual([]);
});
