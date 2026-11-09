import { configureLogSecrets, redactLog } from './runtime-logs.js';

// Contract: docs.dokploy.com/docs/api and Dokploy/dokploy canary routers
// application.readLogs = docker service runtime; deployment.readLogs = build file.
const PATHS = {
  list: ['APPLICATIONS', 'project.all'], one: ['APPLICATION_ONE', 'application.one'],
  logs: ['LOGS', 'application.readLogs'], deployments: ['DEPLOYMENTS', 'deployment.all'],
  buildlogs: ['BUILD_LOGS', 'deployment.readLogs'], deploy: ['DEPLOY', 'application.deploy'],
  redeploy: ['REDEPLOY', 'application.redeploy'], restart: ['RESTART', 'application.reload'],
  stop: ['STOP', 'application.stop'], start: ['START', 'application.start'],
};
export function dokployConf(env) {
  return { base: String(env.DOKPLOY_URL || '').trim().replace(/\/+$/, ''), key: String(env.DOKPLOY_API_KEY || '').trim(), appId: String(env.DOKPLOY_APP_ID || '').trim(),
    paths: Object.fromEntries(Object.entries(PATHS).map(([name, [key, proc]]) => [name, String(env[`DOKPLOY_API_${key}`] || `/api/${proc}`)])) };
}
export function dokployConfigured(env) { const c = dokployConf(env); return Boolean(c.base && c.key); }
export class LogSourceError extends Error {
  constructor(code, message, retryable = false, status = 502) { super(message); this.code = code; this.retryable = retryable; this.status = status; }
}
export function logFailure(error) {
  return { type: 'error', code: error.code || 'NETWORK', message: redactLog(error.message || error), trace: redactLog(error.stack || '').slice(0, 16384), retryable: error.retryable ?? true };
}
async function boundedText(response, max = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder(); let text = '', size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > max) throw new LogSourceError('RESPONSE_TOO_LARGE', 'Dokploy response exceeds 2 MiB; reduce tail or inspect Dokploy directly.', false);
    text += decoder.decode(value, { stream: true });
  } return text + decoder.decode(); } finally { await reader.cancel().catch(() => {}); }
}
export async function dokployCall(env, operation, params = {}, method = 'GET') {
  configureLogSecrets(env);
  const c = dokployConf(env);
  if (!c.base || !c.key) throw new LogSourceError('NOT_CONFIGURED', 'Set DOKPLOY_URL and DOKPLOY_API_KEY.', false, 503);
  let url;
  try {
    const base = new URL(c.base); url = new URL(c.paths[operation], `${c.base}/`);
    if (!['https:', 'http:'].includes(base.protocol) || url.origin !== base.origin || base.username || base.password) throw new Error();
  } catch { throw new LogSourceError('CONFIGURATION', 'Dokploy endpoint must stay on the configured HTTP(S) origin.', false, 503); }
  if (method === 'GET') for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  try {
    const response = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-api-key': c.key },
      body: method === 'GET' ? undefined : JSON.stringify(params), redirect: 'error', signal: AbortSignal.timeout(Number(env.DOKPLOY_TIMEOUT_MS) || 15000) });
    const text = await boundedText(response); let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'DOKPLOY_AUTH' : response.status === 404 ? 'NOT_FOUND' : response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'DOKPLOY_UNAVAILABLE' : 'DOKPLOY_REQUEST';
      const action = code === 'DOKPLOY_AUTH' ? 'Check API key and service permissions.' : code === 'NOT_FOUND' ? 'Check application/deployment ID and installed Dokploy API version.' : 'Check Dokploy service health and configuration.';
      throw new LogSourceError(code, `Dokploy HTTP ${response.status}. ${action} ${redactLog(data?.message || data?.error?.message || text).slice(0, 1500)}`, response.status >= 500 || response.status === 429, response.status === 404 ? 404 : 502);
    }
    return data?.result?.data?.json ?? data?.result?.data ?? data;
  } catch (error) {
    if (error instanceof LogSourceError) throw error;
    throw new LogSourceError(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', redactLog(error.message || error), true);
  }
}
export async function dokployApps(env) {
  const projects = await dokployCall(env, 'list');
  if (!Array.isArray(projects)) throw new LogSourceError('API_CONTRACT', 'project.all did not return an array. Check Dokploy version.', false);
  return projects.flatMap(project => project.applicationId ? [project] : [...(project.applications || []), ...(project.environments || []).flatMap(environment => environment.applications || [])]);
}
export function dokployApp(env, appId) { return dokployCall(env, 'one', { applicationId: appId }); }
export async function dokployDeployments(env, appId) {
  const rows = await dokployCall(env, 'deployments', { applicationId: appId });
  if (!Array.isArray(rows)) throw new LogSourceError('API_CONTRACT', 'deployment.all did not return an array.', false);
  return rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
export async function dokployStatus(env, appId) {
  const [app, deployments] = await Promise.all([dokployApp(env, appId), dokployDeployments(env, appId)]);
  const last = deployments[0];
  return { name: app.name || app.appName, service: app.appName, status: app.applicationStatus, branch: app.branch, sourceType: app.sourceType,
    lastDeployment: last ? { id: last.deploymentId, status: last.status, createdAt: last.createdAt, finishedAt: last.finishedAt, title: last.title, error: last.error } : null };
}
export async function dokployLogSnapshot(env, appId, tail = 100, source = 'container') {
  if (!appId) throw new LogSourceError('APPLICATION_REQUIRED', 'Set DOKPLOY_APP_ID or pass app.', false, 400);
  const count = Math.min(1000, Math.max(1, Number(tail) || 100));
  const app = await dokployApp(env, appId);
  let generation = app.appName || appId, state = app.applicationStatus, params = { applicationId: appId, tail: count, since: 'all' };
  if (source === 'deployment') {
    const last = (await dokployDeployments(env, appId))[0];
    if (!last) return { lines: [], generation: 'no-deployment', service: generation, state: 'NO_DEPLOYMENT' };
    generation = last.deploymentId; state = last.status; params = { deploymentId: generation, tail: count };
  }
  const raw = await dokployCall(env, source === 'deployment' ? 'buildlogs' : 'logs', params);
  if (typeof raw !== 'string') throw new LogSourceError('API_CONTRACT', 'Dokploy log endpoint must return a string. Check installed API version.', false);
  return { lines: redactLog(raw).replace(/\r\n/g, '\n').split('\n').filter(line => line !== '').slice(-count), generation, service: app.appName || appId, state };
}
export async function dokployLogs(env, appId, tail = 40, source = 'container') {
  const snapshot = await dokployLogSnapshot(env, appId, tail, source);
  return snapshot.lines.join('\n') || `No logs available (service state: ${snapshot.state || 'unknown'}).`;
}
export function dokployDeploy(env, appId, { rebuild = false } = {}) { return dokployCall(env, rebuild ? 'redeploy' : 'deploy', { applicationId: appId }, 'POST'); }
export async function dokploySimple(env, appId, what) {
  if (!['restart', 'start', 'stop'].includes(what)) throw new LogSourceError('UNSUPPORTED', 'There is no application-scoped build-cache purge API. Use Dokploy build settings; redeploy does not promise cache removal.', false, 400);
  const params = { applicationId: appId };
  if (what === 'restart') params.appName = (await dokployApp(env, appId)).appName;
  return dokployCall(env, what, params, 'POST');
}
