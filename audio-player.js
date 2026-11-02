(() => {
  const BAR_COUNT = 38;
  let activeAudio = null;

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  const appendIcon = (button, name, className = "") => {
    if (typeof window.qgIcon === "function") button.append(window.qgIcon(name, className));
  };

  const normalizedPeaks = (values) => {
    if (!Array.isArray(values) || values.length !== BAR_COUNT) {
      return Array.from({ length: BAR_COUNT }, (_, index) => 0.18 + ((index * 17 + 9) % 57) / 100);
    }
    return values.map((value) => Number.isFinite(value) ? Math.max(0.05, Math.min(1, value)) : 0.05);
  };

  window.createQGVoicePlayer = (source, label = "Message vocal", options = {}) => {
    const player = document.createElement("div");
    player.className = `qg-voice-player${options.preview ? " qg-voice-player--preview" : " qg-voice-player--message"}`;
    player.dataset.state = "loading";

    const playButton = document.createElement("button");
    playButton.className = "qg-voice-player-play";
    playButton.type = "button";
    playButton.setAttribute("aria-label", `Lire ${label}`);
    appendIcon(playButton, "play");

    const waveform = document.createElement("div");
    waveform.className = "qg-voice-player-wave";
    waveform.tabIndex = 0;
    waveform.setAttribute("role", "slider");
    waveform.setAttribute("aria-label", `Progression de ${label}`);
    waveform.setAttribute("aria-valuemin", "0");
    waveform.setAttribute("aria-valuemax", "100");
    waveform.setAttribute("aria-valuenow", "0");
    waveform.setAttribute("aria-valuetext", "0:00 sur 0:00");

    const peaks = normalizedPeaks(options.peaks);
    const bars = peaks.map((peak, index) => {
      const bar = document.createElement("i");
      bar.className = "qg-voice-player-bar";
      bar.setAttribute("aria-hidden", "true");
      bar.style.setProperty("--bar-height", `${Math.round(22 + peak * 74)}%`);
      bar.dataset.index = String(index);
      waveform.append(bar);
      return bar;
    });

    const time = document.createElement("span");
    time.className = "qg-voice-player-time";
    time.setAttribute("aria-live", "off");
    time.textContent = "0:00";

    const audio = document.createElement("audio");
    audio.className = "qg-voice-player-audio";
    audio.hidden = true;
    audio.controls = false;
    audio.preload = "none";
    audio.setAttribute("aria-hidden", "true");
    audio.src = source;

    player.append(playButton, waveform, time, audio);

    let frameId = 0;
    const duration = () => Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const setProgress = () => {
      const total = duration();
      const ratio = total ? Math.max(0, Math.min(1, audio.currentTime / total)) : 0;
      const percent = Math.round(ratio * 1000) / 10;
      waveform.style.setProperty("--voice-progress", `${percent}%`);
      waveform.setAttribute("aria-valuenow", String(Math.round(percent)));
      waveform.setAttribute("aria-valuetext", `${formatTime(audio.currentTime)} sur ${formatTime(total)}`);
      bars.forEach((bar, index) => bar.classList.toggle("is-played", (index + 1) / bars.length <= ratio));
      time.textContent = options.preview && total ? formatTime(total) : formatTime(total || audio.currentTime);
    };

    const updatePlayButton = () => {
      const playing = !audio.paused && !audio.ended;
      playButton.replaceChildren();
      appendIcon(playButton, playing ? "pause" : "play");
      playButton.setAttribute("aria-label", `${playing ? "Mettre en pause" : "Lire"} ${label}`);
      player.dataset.state = playing ? "playing" : duration() ? "ready" : "loading";
      if (playing && !frameId) frameId = requestAnimationFrame(animateProgress);
      if (!playing && frameId) {
        cancelAnimationFrame(frameId);
        frameId = 0;
        setProgress();
      }
    };

    function animateProgress() {
      setProgress();
      if (!audio.paused && !audio.ended) frameId = requestAnimationFrame(animateProgress);
      else frameId = 0;
    }

    const showUnavailable = () => {
      player.dataset.state = "error";
      playButton.disabled = true;
      waveform.setAttribute("aria-disabled", "true");
      time.textContent = "Audio indisponible";
      waveform.setAttribute("aria-valuetext", "Audio indisponible");
    };

    const seekToPointer = (event) => {
      const total = duration();
      const bounds = waveform.getBoundingClientRect();
      if (!total || !bounds.width) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      audio.currentTime = ratio * total;
      setProgress();
    };

    playButton.addEventListener("click", async () => {
      if (!audio.paused) {
        audio.pause();
        return;
      }
      if (activeAudio && activeAudio !== audio) activeAudio.pause();
      activeAudio = audio;
      audio.preload = "auto";
      if (audio.readyState === 0) audio.load();
      try {
        await audio.play();
      } catch {
        if (audio.error) showUnavailable();
      }
    });

    let pointerSeeking = false;
    waveform.addEventListener("pointerdown", (event) => {
      pointerSeeking = true;
      waveform.setPointerCapture?.(event.pointerId);
      seekToPointer(event);
    });
    waveform.addEventListener("pointermove", (event) => {
      if (pointerSeeking) seekToPointer(event);
    });
    waveform.addEventListener("pointerup", () => { pointerSeeking = false; });
    waveform.addEventListener("pointercancel", () => { pointerSeeking = false; });
    waveform.addEventListener("keydown", (event) => {
      const total = duration();
      if (!total) return;
      let next = audio.currentTime;
      if (event.key === "ArrowRight" || event.key === "PageUp") next += event.key === "PageUp" ? 10 : 5;
      else if (event.key === "ArrowLeft" || event.key === "PageDown") next -= event.key === "PageDown" ? 10 : 5;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = total;
      else return;
      event.preventDefault();
      audio.currentTime = Math.max(0, Math.min(total, next));
      setProgress();
    });

    audio.addEventListener("loadedmetadata", () => {
      playButton.disabled = false;
      waveform.removeAttribute("aria-disabled");
      setProgress();
      updatePlayButton();
    });
    audio.addEventListener("durationchange", setProgress);
    audio.addEventListener("play", updatePlayButton);
    audio.addEventListener("pause", updatePlayButton);
    audio.addEventListener("ended", () => {
      audio.currentTime = 0;
      setProgress();
      updatePlayButton();
      if (activeAudio === audio) activeAudio = null;
    });
    audio.addEventListener("error", showUnavailable);

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        audio.preload = "metadata";
        audio.load();
        observer.disconnect();
      }, { rootMargin: "140px" });
      observer.observe(player);
    } else {
      audio.preload = "metadata";
      audio.load();
    }

    return player;
  };
})();
