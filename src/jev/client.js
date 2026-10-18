// Minimal client for TypeSafe's System One API (POST /v1/systemone), used in enforce mode.
// Request:  { state, model, questions: { id: { type: 'noul', instructions } } }
// Response: { model, answers: { id: { type: 'noul', noul: 0..1 } }, usage }
// The API key is read from the environment and never written to results, logs or reports.

export class JevApiError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function systemOne(api, { state, questions }, { fetchImpl = globalThis.fetch } = {}) {
  if (!api.key) throw new JevApiError('TYPESAFE_API_KEY is not set.');
  const body = JSON.stringify({ state, model: api.model, questions });
  let lastErr;
  for (let attempt = 0; attempt <= api.retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), api.timeoutMs);
    try {
      const res = await fetchImpl(`${api.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${api.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body, signal: ctl.signal,
      });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new JevApiError(`Jev API answered ${res.status}.`);
        const ra = Number(res.headers.get?.('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new JevApiError(`Jev API answered ${res.status}: ${text.slice(0, 300)}`);
      let json;
      try { json = JSON.parse(text); } catch { throw new JevApiError('Jev API returned a response that is not JSON.'); }
      const answers = json?.answers;
      if (!answers || typeof answers !== 'object') throw new JevApiError('Jev API response has no answers.');
      const out = {};
      for (const id of Object.keys(questions)) {
        const a = answers[id];
        const p = a?.noul ?? a?.probability;
        if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new JevApiError(`Jev API gave no valid probability for "${id}".`);
        out[id] = p;
      }
      return { probabilities: out, model: json.model || api.model, usage: json.usage || null };
    } catch (e) {
      if (e instanceof JevApiError && !/answered (429|5\d\d)/.test(e.message)) throw e;
      lastErr = e.name === 'AbortError' ? new JevApiError(`Jev API did not answer within ${api.timeoutMs / 1000} s.`) : e instanceof JevApiError ? e : new JevApiError(`Could not reach the Jev API: ${e.message}`);
      if (attempt < api.retries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
