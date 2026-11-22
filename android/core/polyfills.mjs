// The App service context has no DOM. Supply only the cancellation primitive
// needed by the Agent core, without a browser or Node runtime shim.
if (typeof globalThis.performance === 'undefined') globalThis.performance = {now: () => Date.now()};
// Pi uses structuredClone for JSON tool arguments before schema validation.
// This fallback intentionally accepts JSON-shaped data only, fails closed for
// host objects, and preserves __proto__ as a data property rather than a setter.
if (typeof globalThis.structuredClone === 'undefined') globalThis.structuredClone = value => {
  const seen = new Map();
  function clone(input) {
    if (input === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof input)) return input;
    if (typeof input !== 'object') throw new Error('Only JSON tool arguments can be cloned');
    if (seen.has(input)) return seen.get(input);
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new Error('Host objects are not tool arguments');
    const output = Array.isArray(input) ? [] : {}; seen.set(input, output);
    for (const name of Object.keys(input)) Object.defineProperty(output, name, {value: clone(input[name]), writable: true, enumerable: true, configurable: true});
    return output;
  }
  return clone(value);
};
if (typeof globalThis.AbortController === 'undefined') {
  class Signal {
    aborted = false; reason = undefined; listeners = new Set();
    addEventListener(type, listener) { if (type === 'abort') this.listeners.add(listener); }
    removeEventListener(type, listener) { if (type === 'abort') this.listeners.delete(listener); }
    throwIfAborted() { if (this.aborted) throw this.reason ?? new Error('Aborted'); }
  }
  globalThis.AbortController = class {
    signal = new Signal();
    abort(reason = new Error('Aborted')) {
      if (this.signal.aborted) return;
      this.signal.aborted = true; this.signal.reason = reason;
      for (const listener of this.signal.listeners) listener({type: 'abort', target: this.signal});
    }
  };
}
if (!Promise.withResolvers) Promise.withResolvers = function() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject};
};
