// Long reads of large files: progress notifications, cancellation, and background jobs.
//
// Every tool call runs inside a call context (service.js callContext). If a call has been reading a
// file for more than STATS_EXPLORER_BACKGROUND_SECONDS (default 40), the tool returns at once with a
// job id and keeps running; job_status waits for it and returns the normal result. MCP clients that
// send a progress token get progress notifications while the call is still open.
import { z } from 'zod';
import { callContext, settings, setPlan, getPlan, planText, human, describe } from './service.js';
import { listCache, clearCache } from './cache.js';
import { UserError } from '../errors.js';

const BACKGROUND = Symbol('background');
const jobs = new Map();
let jobSeq = 1;

function fmtDuration(sec) {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function progressLine(p) {
  if (!p) return 'starting';
  const pct = Math.floor(p.fraction * 100);
  const eta = p.fraction > 0.02 ? (p.seconds / p.fraction) * (1 - p.fraction) : null;
  return `${pct}% read (${p.rows.toLocaleString('en-US')} rows, ${fmtDuration(p.seconds)} so far${eta != null ? `, about ${fmtDuration(eta)} left` : ''})`;
}

/**
 * Runs a tool call with progress, cancellation and the background switch.
 * Returns { value } / { error } when it finishes in time, or { job } when it moved to the background.
 */
export async function runCall(toolName, fn, { ctx, extra }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  extra?.signal?.addEventListener('abort', onAbort);
  let toBackground;
  const background = new Promise((r) => { toBackground = r; });
  const call = {
    ctx, tool: toolName, signal: controller.signal, controller, active: true, last: null, timer: null, job: null,
    scanStarted() {
      if (call.timer || !call.active) return;
      call.timer = setTimeout(() => toBackground(BACKGROUND), settings().backgroundSeconds * 1000);
      call.timer.unref?.();
    },
    progress(p, info) {
      call.last = p;
      if (call.job) call.job.progress = p;
      call.scanStarted();
      const token = extra?._meta?.progressToken;
      if (call.active && token !== undefined && extra?.sendNotification) {
        extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(p.fraction * 1000), total: 1000, message: `Reading ${info?.path || 'the file'}: ${progressLine(p)}` } }).catch(() => {});
      }
    },
  };
  const run = callContext.run(call, () => Promise.resolve().then(fn));
  const first = await Promise.race([run.then((value) => ({ value }), (error) => ({ error })), background]);
  clearTimeout(call.timer);
  if (first !== BACKGROUND) { extra?.signal?.removeEventListener('abort', onAbort); call.active = false; return first; }
  // Keep running in the background; the client's request is answered now.
  extra?.signal?.removeEventListener('abort', onAbort);
  call.active = false;
  const job = { id: `job-${jobSeq++}`, tool: toolName, status: 'running', started: Date.now() - (call.last?.seconds || 0) * 1000, progress: call.last, controller, done: null };
  call.job = job;
  job.done = run.then((value) => { job.status = 'done'; job.value = value; job.finished = Date.now(); }, (error) => { job.status = controller.signal.aborted ? 'cancelled' : 'error'; job.error = error; job.finished = Date.now(); });
  jobs.set(job.id, job);
  return { job };
}

export function jobStartedResult(job) {
  return {
    summary: [
      `STILL RUNNING: ${job.tool} is reading a large file in the background (${job.id}, ${progressLine(job.progress)}).`,
      `Tell the user it is running, then call job_status with job_id "${job.id}" to wait for the result (each call waits up to about 50 seconds). Use cancel_job to stop it.`,
    ],
    data: { status: 'running', job_id: job.id, tool: job.tool, progress: job.progress },
  };
}

// ------------------------------------------------------------------ tools

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function jobTools({ largeFilePath, formatResult }) {
  return [
    {
      name: 'job_status', title: 'Wait for a large-file job',
      description: 'For a tool that answered STILL RUNNING: waits up to wait_seconds for the background job, then returns its result (the same result the tool would have returned) or its progress so far.',
      inputSchema: { job_id: z.string(), wait_seconds: z.number().min(0).max(55).default(45) },
      annotations: { title: 'Job status', ...RO },
      async raw(a) {
        const job = jobs.get(a.job_id);
        if (!job) throw new UserError(`No job "${a.job_id}". Jobs: ${[...jobs.keys()].join(', ') || 'none'}.`);
        if (job.status === 'running') await Promise.race([job.done, new Promise((r) => setTimeout(r, a.wait_seconds * 1000).unref?.())]);
        if (job.status === 'running') {
          return formatResult({ summary: [`${job.id} (${job.tool}) is still running: ${progressLine(job.progress)}.`, `Call job_status again with job_id "${job.id}" to keep waiting.`], data: { status: 'running', job_id: job.id, progress: job.progress } });
        }
        if (job.status === 'done') {
          const out = formatResult(job.value);
          out.content[0].text = `${job.id} (${job.tool}) finished in ${fmtDuration((job.finished - job.started) / 1000)}.\n${out.content[0].text}`;
          return out;
        }
        if (job.status === 'cancelled') return formatResult({ summary: [`${job.id} was cancelled; nothing was computed.`], data: { status: 'cancelled', job_id: job.id } });
        throw job.error instanceof Error ? job.error : new UserError(String(job.error));
      },
    },
    {
      name: 'cancel_job', title: 'Cancel a large-file job',
      description: 'Stops a background job started by a tool that answered STILL RUNNING.',
      inputSchema: { job_id: z.string() },
      annotations: { title: 'Cancel job', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(a) {
        const job = jobs.get(a.job_id);
        if (!job) throw new UserError(`No job "${a.job_id}".`);
        if (job.status === 'running') job.controller.abort();
        return { summary: [`${job.id}: ${job.status === 'running' ? 'cancelling' : `already ${job.status}`}.`], data: { job_id: job.id, status: job.status === 'running' ? 'cancelling' : job.status } };
      },
    },
    {
      name: 'large_file_plan', title: 'Choose how to read a large file',
      description: 'Only when a tool answered LARGE FILE, and only after asking the user: record their choice for that file. choice "full" reads every row (exact results, can take a long time, runs in the background); "sample" reads about 1% of the rows in blocks spread across the file (quick, approximate). save_columns keeps the columns that are read on disk so later questions on them are fast. Then call the original tool again.',
      inputSchema: { file: z.string(), choice: z.enum(['full', 'sample']), save_columns: z.boolean().optional() },
      annotations: { title: 'Large-file plan', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(a) {
        const path = await largeFilePath(a.file);
        if (!path) throw new UserError(`${a.file} is small enough to read directly; no plan is needed.`);
        const info = await describe(path);
        const s = settings();
        const plan = { choice: a.choice, cache: s.cache === 'on' || (s.cache === 'ask' && !!a.save_columns) };
        setPlan(info, plan);
        const t = planText(info);
        return {
          summary: [`Plan for ${path}: ${plan.choice === 'full' ? 'read every row (exact)' : `read a sample of about ${Math.round(s.sampleFraction * 100)}% of the rows (approximate)`}${plan.cache ? ', keeping the columns read for faster follow-up questions' : ''}.`, t.message, 'Now call the original tool again.'],
          data: { file: path, ...plan, size: info.size },
        };
      },
    },
    {
      name: 'manage_cache', title: 'Saved large-file columns',
      description: 'Lists or deletes the columns kept on disk from large files (see large_file_plan save_columns). action "list" or "clear" (all, or one file).',
      inputSchema: { action: z.enum(['list', 'clear']), file: z.string().optional() },
      annotations: { title: 'Large-file cache', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async run(a) {
        if (a.action === 'list') {
          const list = await listCache();
          return { summary: list.length ? list.map((c) => `${c.path}: ${c.columns.join(', ') || '(incomplete)'} (${human(c.bytes)})`) : ['Nothing is cached.'], data: { cached: list.map(({ dir, ...c }) => c) } };
        }
        const path = a.file ? await largeFilePath(a.file).catch(() => a.file) : null;
        const freed = await clearCache(path || undefined);
        return { summary: [`Deleted ${human(freed)} of saved columns${path ? ` for ${path}` : ''}.`], data: { freed_bytes: freed } };
      },
    },
  ];
}

export { getPlan };
