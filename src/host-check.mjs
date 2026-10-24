// Host / Origin の hostname をローカル待受に制限する(DNS rebinding 対策)。
import { isIP } from 'node:net';

function hostnameFromHost(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[\s\\/@?#]/.test(raw)) return null;
  if (raw.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
    return m ? m[1].toLowerCase() : null;
  }
  if (isIP(raw) === 6) return raw.toLowerCase();
  const m = /^([^:]+)(?::\d+)?$/.exec(raw);
  return m ? m[1].toLowerCase() : null;
}

function allowedHostnames(bindHost) {
  const allowed = new Set(['127.0.0.1', 'localhost', '::1']);
  const configured = hostnameFromHost(bindHost);
  if (configured && configured !== '0.0.0.0' && configured !== '::') allowed.add(configured);
  return allowed;
}

export function isAllowedHost(hostHeader, bindHost) {
  const hostname = hostnameFromHost(hostHeader);
  return !!hostname && allowedHostnames(bindHost).has(hostname);
}

export function isAllowedOrigin(originHeader, bindHost) {
  if (originHeader === undefined || originHeader === null) return true;
  if (originHeader === 'null') return false;
  try {
    const hostname = new URL(originHeader).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return !!hostname && allowedHostnames(bindHost).has(hostname);
  } catch {
    return false;
  }
}
