// audio-mute.mjs — keep every headless browser we launch silent. Headless
// Chromium and WebKit still play WebAudio / <audio> through the Mac's
// speakers, so each harness (E2E fixtures, smoke.mjs, scripts/screenshots.mjs)
// launches Chromium with --mute-audio AND installs this init script in every
// context: AudioContext / webkitAudioContext become silent stubs with the same
// methods (code paths still run), HTMLMediaElement.play resolves without
// sound, and each would-be sound increments window.__owChimes (the same
// counter main.js's playChime() stopgap uses under navigator.webdriver).

export const CHROMIUM_MUTE_ARGS = Object.freeze(['--mute-audio']);

/** Runs in the page before any app script (context.addInitScript). */
export function installAudioMute() {
  const w = window;
  const bump = () => { w.__owChimes = (w.__owChimes || 0) + 1; };
  w.__owAudioMuted = true;
  const param = () => ({
    value: 0,
    setValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    setTargetAtTime() { return this; },
    cancelScheduledValues() { return this; },
  });
  const node = () => ({
    connect(target) { return target || this; },
    disconnect() {},
    start() { bump(); },
    stop() {},
    type: 'sine',
    frequency: param(),
    gain: param(),
    detune: param(),
  });
  class SilentAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = node();
      this.sampleRate = 44100;
    }
    createOscillator() { return node(); }
    createGain() { return node(); }
    createBufferSource() { return node(); }
    createBuffer() { return { getChannelData: () => new Float32Array(0) }; }
    decodeAudioData() { return Promise.resolve({}); }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  Object.defineProperty(w, 'AudioContext', { value: SilentAudioContext, configurable: true, writable: true });
  Object.defineProperty(w, 'webkitAudioContext', { value: SilentAudioContext, configurable: true, writable: true });
  if (w.HTMLMediaElement) {
    w.HTMLMediaElement.prototype.play = function play() { bump(); return Promise.resolve(); };
  }
}

/** Mute a context (call before its first page loads). */
export async function muteContext(context) {
  await context.addInitScript(installAudioMute);
  return context;
}
