import { runtimeLogs, redactLog, configureLogSecrets } from './runtime-logs.js';
import { dokployLogSnapshot, LogSourceError, logFailure } from './dokploy.js';

const encoder = new TextEncoder();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fingerprint(line) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(line));
  return Array.from(new Uint8Array(hash).slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('');
}
function encodeCursor(value) { return btoa(JSON.stringify(value)); }
function decodeCursor(value) {
  if (!value) return null;
  try { if (value.length > 4096) throw new Error(); const parsed = JSON.parse(atob(value));
    if (typeof parsed.g !== 'string' || !Array.isArray(parsed.h) || parsed.h.length > 32 || parsed.h.some(h => typeof h !== 'string' || !/^[a-f0-9]{24}$/.test(h))) throw new Error(); return parsed;
  } catch { throw new LogSourceError('INVALID_CURSOR', 'Invalid cursor; remove cursor to read recent logs.', false, 400); }
}
function lineRecord(line, snapshot, source) {
  const timestamp = line.match(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/)?.[0];
  let parsed;
  try { parsed = JSON.parse(line); } catch { /* Plain Docker/build output is also supported. */ }
  return { timestamp: parsed?.timestamp || timestamp || new Date().toISOString(), timestampOrigin: parsed?.timestamp || timestamp ? 'source' : 'observed',
    source, service: snapshot.service, level: String(parsed?.level || line.match(/\b(ERROR|WARN|WARNING|INFO|DEBUG|FATAL)\b/i)?.[0] || 'UNKNOWN').toUpperCase(),
    message: parsed?.message == null ? line.slice(0, 16384) : redactLog(parsed.message).slice(0, 16384), trace: parsed?.trace ? redactLog(parsed.trace).slice(0, 16384) : /^\s+at |Traceback|^\s+File "/.test(line) ? line.slice(0, 16384) : null };
}
export async function logSnapshot(env, { source = 'app', app = '', tail = 100, cursor = '' } = {}) {
  if (source === 'app') return runtimeLogs.snapshot(cursor, tail);
  const previous = decodeCursor(cursor);
  const snapshot = await dokployLogSnapshot(env, app, cursor ? 1000 : tail, source);
  const hashes = await Promise.all(snapshot.lines.map(fingerprint));
  let start = 0, reset = false;
  if (previous) {
    if (previous.g !== `${source}:${app}:${snapshot.generation}`) reset = true;
    else if (previous.h.length) {
      let matched = false;
      for (let end = hashes.length; end > 0; end--) {
        const count = Math.min(previous.h.length, end);
        if (hashes.slice(end - count, end).every((hash, i) => hash === previous.h[previous.h.length - count + i])) { start = end; matched = true; break; }
      }
      reset = !matched;
    }
  }
  const nextCursor = encodeCursor({ g: `${source}:${app}:${snapshot.generation}`, h: hashes.slice(-32) });
  return { records: snapshot.lines.slice(start).map(line => lineRecord(line, snapshot, source)), cursor: nextCursor, reset,
    state: snapshot.state, service: snapshot.service, resume: 'best-effort-tail-overlap' };
}
export async function handleLogApi(request, env, headers, authorize) {
  configureLogSecrets(env);
  const url = new URL(request.url), source = url.searchParams.get('source') || 'app';
  if (!['app', 'container', 'deployment'].includes(source)) return Response.json({ success: false, code: 'INVALID_SOURCE', error: 'source must be app, container or deployment' }, { status: 400, headers });
  const options = { source, app: url.searchParams.get('app') || env.DOKPLOY_APP_ID || '', tail: Math.max(1, Math.min(1000, Number(url.searchParams.get('tail')) || 100)), cursor: url.searchParams.get('cursor') || '' };
  const outputHeaders = { ...headers, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
  let initial;
  try { initial = await logSnapshot(env, options); }
  catch (error) { return Response.json({ success: false, ...logFailure(error) }, { status: error.status || 502, headers: outputHeaders }); }
  if (url.searchParams.get('follow') !== '1') return Response.json({ success: true, source, ...initial }, { headers: outputHeaders });
  let cancelled = false, first = true, cursor = options.cursor, failures = 0;
  const started = Date.now();
  const stream = new ReadableStream({
    async pull(controller) {
      if (cancelled) return;
      try {
        if (!first) await sleep(Math.min(30000, 2000 * 2 ** failures));
        if (cancelled) return;
        if (Date.now() - started >= 300000) { controller.enqueue(encoder.encode(JSON.stringify({ type: 'end', reason: 'reconnect', cursor }) + '\n')); controller.close(); return; }
        if (!await authorize()) { controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED', retryable: false, message: 'Session expired or GOD access revoked.' }) + '\n')); controller.close(); return; }
        const result = first ? initial : await logSnapshot(env, { ...options, cursor });
        const events = [];
        if (first) events.push({ type: 'connected', source, service: result.service || 'athena', resume: result.resume || 'bounded-process-buffer' });
        if (failures) events.push({ type: 'reconnected' });
        if (result.reset) events.push({ type: 'reset', reason: 'restart-rotation-or-cursor-expired', message: 'History gap possible; replaying available recent logs.' });
        for (const record of result.records) events.push({ type: 'log', ...record });
        cursor = result.cursor;
        events.push({ type: 'checkpoint', cursor, state: result.state || null, empty: result.records.length === 0 });
        // Checkpoints acknowledge the whole batch; reconnect before one replays it.
        controller.enqueue(encoder.encode(events.map(event => redactLog(JSON.stringify(event))).join('\n') + '\n'));
        first = false; initial = null; failures = 0;
      } catch (error) {
        if (cancelled) return;
        const failure = logFailure(error); failures++;
        controller.enqueue(encoder.encode(JSON.stringify(failure) + '\n'));
        if (!failure.retryable) controller.close();
      }
    },
    cancel() { cancelled = true; initial = null; },
  }, { highWaterMark: 0 });
  return new Response(stream, { headers: { ...outputHeaders, 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
}
