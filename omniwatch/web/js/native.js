// native.js — bridge shim to the Swift AppKit/WKWebView host, per
// docs/SHELL_CONTRACT.md §6 (source of truth over DESIGN.md §4.7.6, which
// it supersedes/refines: handler name "omniwatch", `command(id, args?)`,
// `nativeEvent(event)`, and the `ready`/`visible`/`closeWindow`/
// `restartBackend` message types). A no-op everywhere else (plain browser
// via `omniwatch --browser`, and Node tests): every "post to native" call
// becomes a harmless `false` return when the WKWebView message handler
// isn't present.
//
// Web -> native: `webkit.messageHandlers.omniwatch.postMessage({...})`.
// Native -> web: the shell calls
// `window.omniwatch.command(id, args?)` (e.g. `session.select({uid})`)
// and `window.omniwatch.nativeEvent(event)` (currently only
// `notifyPermission`). Per §6: "Native queues command/nativeEvent calls
// until [ready]", so `{type:"ready"}` must be posted once both are
// installed — `install()` below does that for you.
//
// The global object is injectable (defaults to `window`) so this can be
// unit-tested in Node with a fake.

/**
 * @param {object} [globalObj] defaults to the global `window` if present
 */
export function createNativeBridge(globalObj = (typeof window !== 'undefined' ? window : {})) {
  function isAvailable() {
    return !!(globalObj.webkit
      && globalObj.webkit.messageHandlers
      && globalObj.webkit.messageHandlers.omniwatch);
  }

  /** @returns {boolean} whether the message was actually delivered to native */
  function postMessage(message) {
    if (!isAvailable()) return false;
    globalObj.webkit.messageHandlers.omniwatch.postMessage(message);
    return true;
  }

  /**
   * True when running inside the Swift shell's WKWebView, per the
   * `window.__OMNIWATCH_NATIVE__` marker native injects at document start
   * (§6). Distinct from `isAvailable()`: this reflects "am I hosted in the
   * app shell at all" (used for the app-mode behaviors in §6 — skipping
   * the WebAudio chime/Web Notification API, `q` posting `closeWindow`),
   * whereas `isAvailable()` reflects "can I actually postMessage right now".
   */
  function isNativeHost() {
    return !!globalObj.__OMNIWATCH_NATIVE__;
  }

  /** The frozen `{app, bridge, platform, version}` marker, or null. */
  function getNativeInfo() {
    return globalObj.__OMNIWATCH_NATIVE__ || null;
  }

  function reportTheme(theme) {
    return postMessage({ type: 'theme', value: theme });
  }

  function requestNotifyPermission() {
    return postMessage({ type: 'notifyPermission' });
  }

  function setKeepOnTop(value) {
    return postMessage({ type: 'keepOnTop', value: !!value });
  }

  /** uids currently on screen (preview/zoom/visible tiles); used natively for notification suppression. */
  function setVisible(uids) {
    return postMessage({ type: 'visible', uids: Array.from(uids || []) });
  }

  /** `q` (P-73): hide the window; the app stays in the menu bar. */
  function closeWindow() {
    return postMessage({ type: 'closeWindow' });
  }

  /** Onboarding "Try the demo" / settings: clean shutdown, then relaunch with/without --demo. */
  function restartBackend(demo = false) {
    return postMessage({ type: 'restartBackend', demo: !!demo });
  }

  /**
   * Required handshake message (§6): post once `window.omniwatch` (command
   * + nativeEvent) is installed. Native queues any `command`/`nativeEvent`
   * calls it made before this arrives (keeping the latest 32) and replies
   * with a `notifyPermission` nativeEvent. `install()` sends this for you
   * automatically; call directly only if you install the handlers by hand.
   */
  function sendReady() {
    return postMessage({ type: 'ready' });
  }

  function ensureOmniwatchObject() {
    if (!globalObj.omniwatch || typeof globalObj.omniwatch !== 'object') {
      globalObj.omniwatch = {};
    }
    return globalObj.omniwatch;
  }

  /**
   * Install `window.omniwatch.command(id, args?)` so the native shell can
   * drive commands via `evaluateJavaScript` (menu items, hotkeys). `args`
   * is passed through as-is (e.g. `session.select` gets `{uid}`, §6).
   * Returns an unregister function.
   * @param {(commandId: string, args?: any) => void} handler
   */
  function registerCommandHandler(handler) {
    const obj = ensureOmniwatchObject();
    obj.command = (id, args) => handler(id, args);
    return () => {
      if (obj.command) delete obj.command;
    };
  }

  /**
   * Install `window.omniwatch.nativeEvent(event)` (§6), currently only
   * `{type:"notifyPermission", status, error?}`. Returns an unregister
   * function.
   * @param {(event: {type: string, [k: string]: any}) => void} handler
   */
  function registerNativeEventHandler(handler) {
    const obj = ensureOmniwatchObject();
    obj.nativeEvent = (event) => handler(event);
    return () => {
      if (obj.nativeEvent) delete obj.nativeEvent;
    };
  }

  /**
   * Convenience: install both handlers and then post `{type:"ready"}`
   * (§6's required order — native queues calls made before `ready`).
   * Either handler may be omitted. Returns a combined unregister function.
   * @param {{onCommand?: Function, onNativeEvent?: Function}} [handlers]
   */
  function install({ onCommand, onNativeEvent } = {}) {
    const unregisterCommand = onCommand ? registerCommandHandler(onCommand) : null;
    const unregisterEvent = onNativeEvent ? registerNativeEventHandler(onNativeEvent) : null;
    sendReady();
    return () => {
      if (unregisterCommand) unregisterCommand();
      if (unregisterEvent) unregisterEvent();
    };
  }

  return {
    isAvailable,
    isNativeHost,
    getNativeInfo,
    postMessage,
    reportTheme,
    requestNotifyPermission,
    setKeepOnTop,
    setVisible,
    closeWindow,
    restartBackend,
    sendReady,
    registerCommandHandler,
    registerNativeEventHandler,
    install,
  };
}

/** Default instance bound to the global `window` (a no-op if absent/not a WKWebView). */
export const nativeBridge = createNativeBridge();
