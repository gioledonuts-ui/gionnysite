import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const voiceRecorderSource = await readFile(new URL("../voice-recorder.js", import.meta.url), "utf8");

function createElement() {
  return {
    children: [],
    dataset: {},
    style: { setProperty() {} },
    hidden: false,
    disabled: false,
    textContent: "",
    setAttribute() {},
    append(...elements) { this.children.push(...elements); },
    replaceChildren(...elements) { this.children = elements; },
    addEventListener() {},
    querySelector() { return null; },
  };
}

function createComposer(getUserMedia, canRecord, {
  windowOverrides = {},
  onSend = async () => true,
} = {}) {
  const window = {
    MediaRecorder: function MediaRecorder() {},
    AudioContext: function AudioContext() {},
    ...windowOverrides,
  };
  const context = {
    window,
    document: { createElement },
    navigator: { mediaDevices: { getUserMedia } },
    URL: { createObjectURL: () => "blob:preview", revokeObjectURL() {} },
    performance: { now: () => 123 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    Blob,
  };
  runInNewContext(voiceRecorderSource, context, { filename: "voice-recorder.js" });

  const inputPill = createElement();
  const panel = createElement();
  const liveControls = createElement();
  const waveform = createElement();
  const timer = createElement();
  const stopButton = createElement();
  const cancelButton = createElement();
  const sendButton = createElement();
  const preview = createElement();
  const composeButton = createElement();
  const plusButton = createElement();
  const status = createElement();

  const state = window.createQGVoiceComposer({
    inputPill,
    panel,
    liveControls,
    waveform,
    timer,
    stopButton,
    cancelButton,
    sendButton,
    preview,
    composeButton,
    plusButton,
    status,
    canRecord,
    canSend: () => false,
    canUsePlus: () => true,
    onSend,
  });

  return { state, inputPill, panel, waveform, composeButton, plusButton, sendButton, status };
}

test("a microphone grant arriving after recording becomes unavailable is stopped and reported", async () => {
  let resolvePermission;
  let canRecord = true;
  let tracksStopped = 0;
  const permission = new Promise((resolve) => { resolvePermission = resolve; });
  const stream = { getTracks: () => [{ stop: () => { tracksStopped += 1; } }] };
  const composer = createComposer(() => permission, () => canRecord);

  const starting = composer.state.start();
  assert.equal(composer.status.textContent, "Autorise l’accès au micro…");
  canRecord = false;
  resolvePermission(stream);
  await starting;

  assert.equal(tracksStopped, 1);
  assert.equal(composer.state.mode, "idle");
  assert.equal(composer.panel.hidden, true);
  assert.equal(composer.inputPill.hidden, false);
  assert.equal(composer.status.dataset.kind, "error");
  assert.match(composer.status.textContent, /discussion n’est pas ouverte/u);
  assert.equal(composer.composeButton.disabled, true);
});

test("stopping creates a manual preview and sends only after the user confirms", async () => {
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }

    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = options.mimeType;
      this.state = "inactive";
      this.listeners = new Map();
    }

    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) || [];
      callbacks.push(callback);
      this.listeners.set(type, callbacks);
    }

    start() { this.state = "recording"; }

    stop() {
      this.state = "inactive";
      const data = new Blob(["recorded voice"], { type: this.mimeType });
      for (const callback of this.listeners.get("dataavailable") || []) callback({ data });
      for (const callback of this.listeners.get("stop") || []) callback();
    }
  }

  class FakeAudioContext {
    constructor() { this.state = "running"; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
      return {
        frequencyBinCount: 256,
        getByteFrequencyData(data) { data.fill(120); },
      };
    }
    close() { this.state = "closed"; return Promise.resolve(); }
  }

  let sentCount = 0;
  const stream = { getTracks: () => [{ stop() {} }] };
  const composer = createComposer(async () => stream, () => true, {
    windowOverrides: {
      MediaRecorder: FakeMediaRecorder,
      AudioContext: FakeAudioContext,
      createQGVoicePlayer: () => createElement(),
    },
    onSend: async (blob, peaks) => {
      sentCount += 1;
      assert.ok(blob.size > 0);
      assert.equal(peaks.length, 38);
      return true;
    },
  });

  await composer.state.start();
  assert.equal(composer.state.mode, "recording");
  assert.equal(composer.waveform.children.length, 38);
  composer.state.stopRecording();

  assert.equal(composer.state.mode, "preview");
  assert.equal(composer.sendButton.hidden, false);
  assert.equal(sentCount, 0);

  await composer.state.send();
  assert.equal(sentCount, 1);
  assert.equal(composer.state.mode, "idle");
  assert.equal(composer.status.textContent, "Vocal envoyé.");
});

test("canceling while microphone permission is pending keeps the stale request closed", async () => {
  let resolvePermission;
  let tracksStopped = 0;
  const permission = new Promise((resolve) => { resolvePermission = resolve; });
  const stream = { getTracks: () => [{ stop: () => { tracksStopped += 1; } }] };
  const composer = createComposer(() => permission, () => true);

  const starting = composer.state.start();
  composer.state.cancel();
  resolvePermission(stream);
  await starting;

  assert.equal(tracksStopped, 1);
  assert.equal(composer.state.mode, "idle");
  assert.equal(composer.panel.hidden, true);
  assert.equal(composer.status.hidden, true);
  assert.equal(composer.status.textContent, "");
  assert.equal(composer.composeButton.disabled, false);
});
