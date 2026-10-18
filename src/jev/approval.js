// Signed decisions for orchestrated mode. The orchestrator (which holds the secret) signs its
// decision about a checkpoint packet; Stats Explorer accepts only decisions with a valid signature,
// so the AI model in the loop can't approve its own work.
//
// Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, base64url(JSON payload)))
// payload = { packet_id, overall: "pass" | "review" | "fail", items?: [{ id, probability?, outcome? }],
//             exp: unix seconds, nonce: string, by?: "name of the orchestrator / policy" }
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signApproval(secret, payload) {
  if (!secret || secret.length < 32) throw new Error('The approval secret must be at least 32 characters.');
  const full = { nonce: randomBytes(12).toString('hex'), exp: Math.floor(Date.now() / 1000) + 600, ...payload };
  const body = b64u(JSON.stringify(full));
  return `${body}.${b64u(createHmac('sha256', secret).update(body).digest())}`;
}

/** Returns the payload, or throws Error with a plain reason. */
export function verifyApproval(secret, token, { now = Date.now() } = {}) {
  if (!secret || secret.length < 32) throw new Error('STATS_EXPLORER_APPROVAL_SECRET is not set on the Stats Explorer server.');
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) throw new Error('The approval is not a signed token.');
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error('The approval signature is not valid.');
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('The approval payload is not readable.'); }
  if (!p || typeof p.packet_id !== 'string' || !['pass', 'review', 'fail'].includes(p.overall)) throw new Error('The approval must name packet_id and overall (pass, review or fail).');
  if (typeof p.exp !== 'number' || p.exp * 1000 < now) throw new Error('The approval has expired.');
  if (typeof p.nonce !== 'string' || p.nonce.length < 8) throw new Error('The approval has no nonce.');
  return p;
}
