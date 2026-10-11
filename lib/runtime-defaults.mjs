/**
 * The browser bridge and desktop shell share one verified local runtime by
 * default. The desktop service manager attaches to that runtime when it owns
 * the same library, instead of starting a second listener.
 */
export const DEFAULT_MOSA_PORT = 43517;
export const DEFAULT_MOSA_DESKTOP_PORT = DEFAULT_MOSA_PORT;
export const DEFAULT_MOSA_DISCOVERY_PORTS = Object.freeze([43517, 43518, 43519, 43520, 43521]);
export const MOSA_RESERVED_PRODUCTION_PORTS = Object.freeze([...DEFAULT_MOSA_DISCOVERY_PORTS, 43637]);

export function normalizeMosaPort(value, { allowZero = false, label = "GravityPort port" } = {}) {
  const port = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`${label} must be an integer from ${minimum} to 65535.`);
  }
  return port;
}
