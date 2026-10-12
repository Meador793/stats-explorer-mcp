// A small pool of worker threads for scanning large files in parallel.
// Workers are started from this same module file (in the extension's single bundled file, that is the
// bundle itself), and run the task loop when they see the `stats-scan` role.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { runTask } from './worker.js';

const ROLE = 'stats-explorer-scan';
const MODULE_URL = import.meta.url;

if (!isMainThread && workerData?.role === ROLE) {
  parentPort.on('message', async ({ id, task }) => {
    try {
      const result = await runTask(task);
      parentPort.postMessage({ id, ok: true, result });
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: e?.message || String(e) });
    }
  });
}

export function workerCount() {
  const env = Number(process.env.STATS_EXPLORER_WORKERS);
  if (env > 0) return Math.min(64, Math.floor(env));
  return Math.max(1, Math.min(16, availableParallelism() - 1));
}

let workers = [];
let idleTimer = null;
let nextId = 1;
const pending = new Map();

function spawn() {
  const w = new Worker(new URL(MODULE_URL), { workerData: { role: ROLE }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
  w.busy = false;
  w.on('message', ({ id, ok, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    w.busy = false;
    w.unref();
    ok ? p.resolve(result) : p.reject(new Error(error));
    pump();
  });
  w.on('error', (e) => {
    const err = e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('A reader ran out of memory (too many different values to keep track of). Pick fewer or less varied columns, or use a sample.') : e;
    for (const [id, p] of pending) if (p.worker === w) { pending.delete(id); p.reject(err); }
    workers = workers.filter((x) => x !== w);
    pump();
  });
  w.unref();
  return w;
}

const queue = [];

function pump() {
  clearTimeout(idleTimer);
  while (queue.length) {
    let w = workers.find((x) => !x.busy);
    if (!w && workers.length < workerCount()) { w = spawn(); workers.push(w); }
    if (!w) break;
    const job = queue.shift();
    w.busy = true;
    w.ref();
    const id = nextId++;
    pending.set(id, { ...job, worker: w });
    w.postMessage({ id, task: job.task });
  }
  if (!queue.length && workers.every((x) => !x.busy)) idleTimer = setTimeout(shutdown, 30_000).unref();
}

/** Runs a task on a worker thread. */
export function submit(task) {
  return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump(); });
}

/** Stops every worker (used to cancel a scan); queued tasks are rejected. */
export async function shutdown(reason) {
  clearTimeout(idleTimer);
  for (const job of queue.splice(0)) job.reject(new Error(reason || 'cancelled'));
  for (const [id, p] of pending) { pending.delete(id); p.reject(new Error(reason || 'cancelled')); }
  const ws = workers; workers = [];
  await Promise.all(ws.map((w) => w.terminate().catch(() => {})));
}
