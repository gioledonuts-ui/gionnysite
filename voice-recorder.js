(() => {
  const BAR_COUNT = 38;
  const MAX_SECONDS = 60;
  const MAX_BYTES = 200_000;
  const MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"];

  const formatDuration = (seconds) => {
    const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  };

  const stopTracks = (stream) => stream?.getTracks().forEach((track) => track.stop());

  window.createQGVoiceComposer = (options) => {
    const {
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
      canRecord = () => true,
      canSend = () => false,
      canUsePlus = canRecord,
      onSend,
      label = "message vocal",
    } = options || {};
    if (!inputPill || !panel || !liveControls || !waveform || !timer || !stopButton || !cancelButton || !sendButton || !preview || !composeButton || !status || typeof onSend !== "function") {
      return null;
    }

    const bars = [];
    const currentLevels = new Float32Array(BAR_COUNT).fill(0.07);
    const peaks = new Float32Array(BAR_COUNT).fill(0.07);
    for (let index = 0; index < BAR_COUNT; index += 1) {
      const bar = document.createElement("span");
      bar.className = "x-voice-bar";
      bar.setAttribute("aria-hidden", "true");
      bar.style.setProperty("--bar-height", `${12 + ((index * 23 + 9) % 52)}%`);
      waveform.append(bar);
      bars.push(bar);
    }

    const state = {
      mode: "idle",
      preview,
      recorder: null,
      stream: null,
      audioContext: null,
      analyser: null,
      frequencyData: null,
      chunks: [],
      byteCount: 0,
      recordedBlob: null,
      previewUrl: "",
      previewPlayer: null,
      captureRequest: 0,
      frameId: 0,
      startedAt: 0,
      lastTimerSecond: -1,
      cancelled: false,
      overflow: false,
      durationReached: false,
      sending: false,
      peaks: [],
      setStatus(message, kind = "") {
        status.textContent = message;
        status.hidden = !message;
        if (kind) status.dataset.kind = kind;
        else delete status.dataset.kind;
      },
      syncAvailability() {
        const active = this.mode !== "idle" || this.sending;
        if (!active) {
          composeButton.disabled = !canSend() && !canRecord();
          if (plusButton) plusButton.disabled = !canUsePlus();
        }
      },
      releaseAudioContext() {
        this.analyser = null;
        this.frequencyData = null;
        if (this.audioContext && this.audioContext.state !== "closed") void this.audioContext.close().catch(() => {});
        this.audioContext = null;
      },
      stopAnimation() {
        if (this.frameId) cancelAnimationFrame(this.frameId);
        this.frameId = 0;
      },
      setMode(mode) {
        this.mode = mode;
        panel.dataset.state = mode;
        panel.hidden = mode === "idle";
        inputPill.hidden = mode !== "idle";
        if (plusButton) plusButton.hidden = mode !== "idle";
        cancelButton.hidden = mode === "idle";
        liveControls.hidden = mode !== "recording";
        preview.hidden = mode !== "preview";
        sendButton.hidden = mode !== "preview";
        this.syncAvailability();
      },
      reset({ clearStatus = true } = {}) {
        const recorder = this.recorder;
        const wasRecording = recorder && recorder.state !== "inactive";
        this.captureRequest += 1;
        this.stopAnimation();
        if (wasRecording) {
          this.cancelled = true;
          try { recorder.stop(); } catch { /* The recorder may already be stopping. */ }
          return;
        }
        stopTracks(this.stream);
        this.stream = null;
        this.releaseAudioContext();
        if (this.previewPlayer) this.previewPlayer.querySelector("audio")?.pause();
        if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
        this.previewUrl = "";
        this.previewPlayer = null;
        this.recorder = null;
        this.chunks = [];
        this.byteCount = 0;
        this.recordedBlob = null;
        this.peaks = [];
        this.cancelled = false;
        this.overflow = false;
        this.durationReached = false;
        this.lastTimerSecond = -1;
        this.preview.replaceChildren();
        this.setMode("idle");
        timer.textContent = "0:00";
        stopButton.disabled = false;
        sendButton.disabled = false;
        cancelButton.disabled = false;
        if (clearStatus) this.setStatus("");
      },
      async start() {
        if (this.mode !== "idle" || this.sending) return;
        if (!canRecord()) {
          this.setStatus("La discussion n’est pas ouverte ou un autre contenu est en préparation.", "error");
          return;
        }
        if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== "function") {
          this.setStatus("L’enregistrement vocal n’est pas disponible dans ce navigateur.", "error");
          return;
        }
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (typeof AudioContext !== "function") {
          this.setStatus("L’analyse audio en direct n’est pas disponible dans ce navigateur.", "error");
          return;
        }

        const requestId = ++this.captureRequest;
        currentLevels.fill(0.07);
        peaks.fill(0.07);
        bars.forEach((bar) => { bar.style.transform = "scaleY(0.12)"; });
        composeButton.disabled = true;
        if (plusButton) plusButton.disabled = true;
        cancelButton.disabled = false;
        this.setStatus("Autorise l’accès au micro…");
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (requestId !== this.captureRequest) {
            stopTracks(stream);
            return;
          }
          if (!canRecord()) {
            stopTracks(stream);
            this.reset();
            this.setStatus("La discussion n’est pas ouverte ou un autre contenu est en préparation.", "error");
            return;
          }
          this.stream = stream;
          this.audioContext = new AudioContext();
          const source = this.audioContext.createMediaStreamSource(stream);
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 512;
          this.analyser.smoothingTimeConstant = 0.64;
          source.connect(this.analyser);
          this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
          if (this.audioContext.state === "suspended") await this.audioContext.resume();
          if (requestId !== this.captureRequest) {
            stopTracks(stream);
            return;
          }
          if (!canRecord()) {
            this.reset();
            this.setStatus("La discussion n’est pas ouverte ou un autre contenu est en préparation.", "error");
            return;
          }
          const preferredType = MIME_TYPES.find((type) => window.MediaRecorder.isTypeSupported?.(type));
          let recorder;
          try {
            recorder = new window.MediaRecorder(stream, {
              audioBitsPerSecond: 24_000,
              ...(preferredType ? { mimeType: preferredType } : {}),
            });
          } catch {
            recorder = new window.MediaRecorder(stream, { audioBitsPerSecond: 24_000 });
          }
          this.recorder = recorder;
          this.chunks = [];
          this.byteCount = 0;
          this.startedAt = performance.now();
          this.lastTimerSecond = -1;
          this.cancelled = false;
          this.overflow = false;
          this.durationReached = false;
          this.setMode("recording");
          timer.textContent = "0:00";
          this.setStatus("Enregistrement en cours…");

          recorder.addEventListener("dataavailable", (event) => {
            if (this.cancelled || !event.data?.size) return;
            this.byteCount += event.data.size;
            if (this.byteCount > MAX_BYTES) {
              this.overflow = true;
              if (recorder.state !== "inactive") recorder.stop();
              return;
            }
            this.chunks.push(event.data);
          });
          recorder.addEventListener("stop", () => {
            this.stopAnimation();
            stopTracks(this.stream);
            this.stream = null;
            this.releaseAudioContext();
            this.recorder = null;
            if (this.cancelled) {
              this.reset();
              return;
            }
            if (this.overflow) {
              this.reset();
              this.setStatus("Ce vocal dépasse la limite de 200 Ko. Recommence avec un enregistrement plus court.", "error");
              return;
            }
            this.recordedBlob = new Blob(this.chunks, { type: recorder.mimeType || preferredType || "audio/webm" });
            if (!this.recordedBlob.size || typeof window.createQGVoicePlayer !== "function") {
              this.reset();
              this.setStatus("L’aperçu vocal n’est pas disponible. Le vocal n’a pas été envoyé.", "error");
              return;
            }
            this.peaks = Array.from(peaks, (peak) => Math.round(Math.max(0.04, Math.min(1, peak)) * 100) / 100);
            this.previewUrl = URL.createObjectURL(this.recordedBlob);
            this.previewPlayer = window.createQGVoicePlayer(this.previewUrl, "l’aperçu du message vocal", {
              peaks: this.peaks,
              preview: true,
            });
            this.preview.replaceChildren(this.previewPlayer);
            this.setMode("preview");
            this.setStatus(this.durationReached
              ? "Une minute maximum atteinte. Écoute l’aperçu avant de l’envoyer."
              : "Écoute le vocal, puis envoie-le ou annule-le.");
          }, { once: true });

          recorder.start(250);
          this.drawFrame();
        } catch (error) {
          if (requestId !== this.captureRequest) return;
          this.reset();
          this.setStatus(error?.name === "NotAllowedError"
            ? "Le micro est bloqué. Autorise-le dans les réglages du navigateur."
            : "Impossible de démarrer l’analyse du micro sur cet appareil.", "error");
        }
      },
      drawFrame() {
        if (this.mode !== "recording" || !this.analyser || !this.frequencyData) return;
        this.analyser.getByteFrequencyData(this.frequencyData);
        const now = performance.now();
        const elapsed = Math.min(MAX_SECONDS, (now - this.startedAt) / 1000);
        const elapsedSecond = Math.floor(elapsed);
        if (elapsedSecond !== this.lastTimerSecond) {
          timer.textContent = formatDuration(elapsed);
          this.lastTimerSecond = elapsedSecond;
        }
        for (let index = 0; index < BAR_COUNT; index += 1) {
          const start = Math.max(1, Math.floor((index / BAR_COUNT) ** 1.65 * (this.frequencyData.length - 5)));
          const end = Math.max(start + 1, Math.floor(((index + 1) / BAR_COUNT) ** 1.65 * (this.frequencyData.length - 4)));
          let total = 0;
          for (let bin = start; bin < end; bin += 1) total += this.frequencyData[bin] / 255;
          const target = Math.max(0.035, Math.min(1, total / (end - start)));
          peaks[index] = Math.max(peaks[index], target);
          currentLevels[index] += (target - currentLevels[index]) * 0.24;
          bars[index].style.transform = `scaleY(${Math.max(0.08, currentLevels[index])})`;
        }
        if (elapsed >= MAX_SECONDS && this.recorder?.state === "recording") {
          this.durationReached = true;
          this.stopRecording();
          return;
        }
        this.frameId = requestAnimationFrame(() => this.drawFrame());
      },
      stopRecording() {
        if (this.recorder?.state !== "recording") return;
        stopButton.disabled = true;
        this.setStatus("Préparation de l’aperçu…");
        this.recorder.stop();
      },
      cancel() {
        if (this.sending) return;
        this.cancelled = true;
        if (this.recorder && this.recorder.state !== "inactive") {
          try { this.recorder.stop(); } catch { this.reset(); }
        } else {
          this.reset();
        }
      },
      async send() {
        if (this.sending || !this.recordedBlob || this.mode !== "preview") return;
        if (!canRecord()) {
          this.setStatus("Cette discussion n’est plus ouverte. Le vocal reste dans l’aperçu.", "error");
          return;
        }
        this.sending = true;
        sendButton.disabled = true;
        cancelButton.disabled = true;
        composeButton.disabled = true;
        this.setStatus("Envoi du vocal…");
        try {
          const sent = await onSend(this.recordedBlob, this.peaks, this);
          if (sent === true) {
            this.reset();
            this.setStatus("Vocal envoyé.", "success");
          }
        } catch {
          this.setStatus("Impossible de joindre le serveur. Réessaie.", "error");
        } finally {
          this.sending = false;
          sendButton.disabled = false;
          cancelButton.disabled = false;
          this.syncAvailability();
        }
      },
    };

    stopButton.addEventListener("click", () => state.stopRecording());
    cancelButton.addEventListener("click", () => state.cancel());
    sendButton.addEventListener("click", () => void state.send());
    state.setMode("idle");
    state.setStatus("");
    state.syncAvailability();
    return state;
  };
})();
