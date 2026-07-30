import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const VISUAL_EVIDENCE_SCHEMA = 'apex-formula.visual-evidence/v1';

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function rejectSymlinkComponents(repoRoot, target) {
  let cursor = repoRoot;
  for (const component of path.relative(repoRoot, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`visual evidence path may not traverse a symlink: ${cursor}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      break;
    }
  }
}

export function resolveEvidenceRoot({ configured, legacy, repoRoot }) {
  if (configured && legacy && path.resolve(repoRoot, configured) !== path.resolve(repoRoot, legacy)) {
    throw new Error('APEX_VISUAL_EVIDENCE_DIR and APEX_CAPTURE_DIR disagree');
  }
  const requested = configured || legacy;
  if (!requested) return null;

  const repo = realpathSync(repoRoot);
  const allowed = path.join(repo, 'test-results', 'visual-evidence');
  const resolved = path.resolve(repo, requested);
  if (!isWithin(allowed, resolved)) {
    throw new Error(`visual evidence output must be ${allowed} or a descendant; received ${resolved}`);
  }
  rejectSymlinkComponents(repo, resolved);
  return resolved;
}

export async function ensureEvidenceRoot(root, repoRoot) {
  if (!root) return null;
  await mkdir(root, { recursive: true });
  const repo = realpathSync(repoRoot);
  const allowed = path.join(repo, 'test-results', 'visual-evidence');
  const physical = realpathSync(root);
  if (!isWithin(allowed, physical)) {
    throw new Error(`visual evidence output escaped its allowed physical root: ${physical}`);
  }
  rejectSymlinkComponents(repo, physical);
  return physical;
}

export function manifestIntegrity(records, expectedVenues) {
  const keyOf = record => `${record.venue}/${record.environment}`;
  const expected = expectedVenues.map(keyOf);
  const expectedSet = new Set(expected);
  const counts = new Map();
  for (const record of records) counts.set(keyOf(record), (counts.get(keyOf(record)) || 0) + 1);
  const missing = expected.filter(key => !counts.has(key));
  const duplicate = [...counts].filter(([, count]) => count > 1).map(([key]) => key);
  const unexpected = [...counts.keys()].filter(key => !expectedSet.has(key));
  const failed = records.filter(record => record.pass !== true).map(keyOf);
  const complete = missing.length === 0 && duplicate.length === 0 && unexpected.length === 0
    && records.length === expected.length;
  return { complete, pass: complete && failed.length === 0, missing, duplicate, unexpected, failed };
}

export function summarizeRgbDelta(first, second, changedPixelChannelThreshold, sampleSize) {
  if (first.length !== second.length || first.length % 4 !== 0) {
    throw new Error('RGBA samples must have equal lengths divisible by four');
  }
  let totalChannels = 0;
  let maxChannel = 0;
  let changed = 0;
  for (let index = 0; index < first.length; index += 4) {
    const red = Math.abs(first[index] - second[index]);
    const green = Math.abs(first[index + 1] - second[index + 1]);
    const blue = Math.abs(first[index + 2] - second[index + 2]);
    const pixelMax = Math.max(red, green, blue);
    totalChannels += red + green + blue;
    maxChannel = Math.max(maxChannel, pixelMax);
    if (pixelMax > changedPixelChannelThreshold) changed++;
  }
  const pixels = first.length / 4;
  return {
    sampleSize,
    changedPixelChannelThreshold,
    meanAbsoluteChannelDifference: totalChannels / (pixels * 3),
    maxAbsoluteChannelDifference: maxChannel,
    changedPixelRatio: changed / pixels,
  };
}

export async function atomicWriteJson(target, value, runId) {
  const temporary = `${target}.${runId}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, target);
}

async function readOwner(lockDirectory) {
  return JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8'));
}

function directoryExists(directory) {
  try {
    return lstatSync(directory).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function acquireManifestUpdate(root, timeoutMs = 5_000) {
  const directory = path.join(root, '.manifest-update.lock');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(directory);
      return directory;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error('visual evidence manifest update remained locked');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

async function releaseManifestUpdate(directory) {
  await rmdir(directory);
}

function validatePointer(runId, pointer) {
  if (pointer?.runId !== runId) {
    throw new Error(`visual evidence pointer run ${pointer?.runId || 'missing'} does not match owner ${runId}`);
  }
  if (pointer.pass === true && pointer.status !== 'passed') {
    throw new Error('visual evidence pointer may only pass with status=passed');
  }
}

export async function acquireRunOwnership(root, runId, pointer, { afterInvalidate } = {}) {
  validatePointer(runId, pointer);
  if (pointer.status !== 'running' || pointer.pass !== false) {
    throw new Error('visual evidence acquisition must publish status=running and pass=false');
  }
  const invalidatedPointer = { ...pointer, activeLock: '.active-run.lock' };
  // This write deliberately happens before any mutex/ownership file exists.
  // Concurrent contenders may replace one false pointer with another, but no
  // crash window can leave an older pass:true pointer authoritative.
  await atomicWriteJson(path.join(root, 'manifest.json'), invalidatedPointer, runId);
  await afterInvalidate?.();

  const updateDirectory = await acquireManifestUpdate(root);
  const lockDirectory = path.join(root, '.active-run.lock');
  try {
    if (directoryExists(lockDirectory)) {
      let detail = 'unknown active run';
      try {
        const active = await readOwner(lockDirectory);
        detail = `${active.runId} (${active.status})`;
      } catch {}
      throw new Error(`visual evidence root is already owned by ${detail}`);
    }

    // A concurrent contender may have published its own false pointer before
    // losing the update mutex. Reassert the winning owner while serialized.
    await atomicWriteJson(path.join(root, 'manifest.json'), invalidatedPointer, runId);

    await mkdir(lockDirectory);
    const owner = {
      schema: VISUAL_EVIDENCE_SCHEMA,
      runId,
      pid: process.pid,
      status: 'running',
      startedAt: new Date().toISOString(),
      root,
      lockDirectory,
    };
    try {
      await writeFile(path.join(lockDirectory, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      await rmdir(lockDirectory).catch(() => {});
      throw error;
    }
    return owner;
  } finally {
    await releaseManifestUpdate(updateDirectory);
  }
}

export async function assertRunOwnership(owner) {
  const persisted = await readOwner(owner.lockDirectory);
  if (persisted.runId !== owner.runId || persisted.status !== 'running') {
    throw new Error(`visual evidence ownership changed from ${owner.runId}`);
  }
  return persisted;
}

export async function publishLatestPointer(owner, pointer) {
  await assertRunOwnership(owner);
  validatePointer(owner.runId, pointer);
  if (pointer.activeLock !== '.active-run.lock') {
    throw new Error('an owned visual evidence pointer must expose .active-run.lock');
  }
  await atomicWriteJson(path.join(owner.root, 'manifest.json'), pointer, owner.runId);
}

export async function releaseRunOwnership(owner) {
  await assertRunOwnership(owner);
  await unlink(path.join(owner.lockDirectory, 'owner.json'));
  await rmdir(owner.lockDirectory);
}

export async function finalizeRunOwnership(owner, pointer, { afterRelease, afterFinalize } = {}) {
  validatePointer(owner.runId, pointer);
  const updateDirectory = await acquireManifestUpdate(owner.root);
  try {
    await assertRunOwnership(owner);
    // A pass may be readable while finalization is in flight, but it remains
    // explicitly non-authoritative until the active lock is actually gone.
    await atomicWriteJson(path.join(owner.root, 'manifest.json'), {
      ...pointer,
      activeLock: '.active-run.lock',
    }, owner.runId);
    await releaseRunOwnership(owner);
    await afterRelease?.();
    await atomicWriteJson(path.join(owner.root, 'manifest.json'), {
      ...pointer,
      activeLock: null,
    }, owner.runId);
    await afterFinalize?.();
  } finally {
    await releaseManifestUpdate(updateDirectory);
  }
}
