/**
 * Minimal event emitter.
 *
 * Replaces the Component-emitter clone that was in js/emitter.js. Same idea,
 * no global, no prototype mixin, and `off()` with no arguments clears
 * everything so a device can be torn down without leaking listeners.
 */
export class Emitter {

  constructor() {
    this._handlers = new Map();
  }

  /** @returns {() => void} an unsubscribe function */
  on(event, fn) {
    let list = this._handlers.get(event);
    if (!list) {
      list = [];
      this._handlers.set(event, list);
    }
    list.push(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const unsubscribe = this.on(event, (...args) => {
      unsubscribe();
      fn(...args);
    });
    return unsubscribe;
  }

  off(event, fn) {
    if (event === undefined) {
      this._handlers.clear();
      return;
    }
    if (fn === undefined) {
      this._handlers.delete(event);
      return;
    }
    const list = this._handlers.get(event);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this._handlers.delete(event);
  }

  /**
   * A throwing listener must not stop the others, and must never break the
   * receive loop that called us — the transport would stall with no way back.
   */
  emit(event, ...args) {
    const list = this._handlers.get(event);
    if (!list || list.length === 0) return;
    for (const fn of list.slice()) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`BP+ listener for "${event}" threw:`, err);
      }
    }
  }

  hasListeners(event) {
    const list = this._handlers.get(event);
    return !!list && list.length > 0;
  }
}
