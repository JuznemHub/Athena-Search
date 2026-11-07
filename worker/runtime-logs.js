// Shared by the worker logger and the self-host console. Only real producers append.
const SECRET_NAME = /(?:token|secret|password|passwd|api[_-]?key|api[_-]?hash|string[_-]?session|session|storage[_-]?key|database[_-]?url|private[_-]?key)/i;
let secretValues = [];
export function configureLogSecrets(env = {}) {
  secretValues = [...new Set([...secretValues, ...Object.entries(env)
    .filter(([key, value]) => SECRET_NAME.test(key) && typeof value === 'string' && value.length >= 4)
    .flatMap(([, value]) => [value, encodeURIComponent(value)])])].sort((a, b) => b.length - a.length);
}
export function redactLog(value) {
  let text;
  try { text = value instanceof Error ? `${value.message}\n${value.stack || ''}` : typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = '[unserializable log value]'; }
  text = String(text ?? '');
  for (const secret of secretValues) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED_AUTH]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_BOT_TOKEN]')
    .replace(/\b[a-f0-9]{32}\b/gi, '[REDACTED_HASH]')
    .replace(/\b1[A-Za-z0-9+/]{200,}={0,2}/g, '[REDACTED_SESSION]')
    .replace(/((?:[\w.-]*(?:token|secret|password|passwd|api[_-]?key|api[_-]?hash|string[_-]?session|session|private[_-]?key)[\w.-]*)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[REDACTED]');
}
export function createLogBuffer(capacity = 500) {
  let epoch = crypto.randomUUID(), seq = 0;
  const records = [];
  return {
    clear() { records.length = 0; epoch = crypto.randomUUID(); seq = 0; },
    append(level, service, message, data = null, source = 'app') {
      const error = data instanceof Error ? data : message instanceof Error ? message : null;
      const entry = {
        cursor: `${epoch}:${++seq}`, timestamp: new Date().toISOString(), source,
        level: String(level || 'info').toUpperCase(), service: redactLog(service || 'athena').slice(0, 200),
        message: redactLog(message instanceof Error ? message.message : message).slice(0, 8192),
        trace: error ? redactLog(error.stack || error.message).slice(0, 16384) : null,
      };
      if (data != null && !error) entry.data = redactLog(data).slice(0, 8192);
      records.push(entry);
      if (records.length > capacity) records.shift();
      return entry;
    },
    snapshot(cursor = '', tail = 100) {
      const end = `${epoch}:${seq}`;
      const at = records.findIndex(record => record.cursor === cursor);
      const reset = Boolean(cursor && cursor !== end && at < 0);
      return { records: (cursor && !reset ? records.slice(at + 1) : records.slice(-tail)), cursor: end, reset };
    },
  };
}
export const runtimeLogs = createLogBuffer();
let consoleInstalled = false;
export function installConsoleLogging(env) {
  configureLogSecrets(env);
  if (consoleInstalled) return;
  consoleInstalled = true;
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const error = args.find(arg => arg instanceof Error);
      const entry = runtimeLogs.append(method === 'log' ? 'info' : method, 'athena-server', args.map(redactLog).join(' '), error);
      original(JSON.stringify(entry));
    };
  }
}
export function writeRuntimeLog(level, service, message, data) {
  const entry = runtimeLogs.append(level, service, message, data);
  // Node already mirrors every console call; avoid adding the same record twice.
  if (!consoleInstalled) console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](JSON.stringify(entry));
  return entry;
}
