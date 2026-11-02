(() => {
  let activeAudio = null;

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const remainder = String(total % 60).padStart(2, "0");
    return `${minutes}:${remainder}`;
  };

  const makeButton = (className, label, text) => {
    const button = document.createElement("button");
    button.className = className;
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.textContent = text;
    return button;
  };

  window.createQGVoicePlayer = (source, label = "Message vocal") => {
    const player = document.createElement("div");
    player.className = "qg-voice-player";
    player.dataset.state = "loading";

    const playButton = makeButton("qg-voice-player-play", `Lire ${label}`, "▶️");
    const waveform = document.createElement("div");
    waveform.className = "qg-voice-player-wave";
    waveform.tabIndex = 0;
    waveform.setAttribute("role", "slider");
    waveform.setAttribute("aria-label", `Progression de ${label}`);
    waveform.setAttribute("aria-valuemin", "0");
    waveform.setAttribute("aria-valuemax", "100");
    waveform.setAttribute("aria-valuenow", "0");
    waveform.setAttribute("aria-valuetext", "0:00 sur --:--");

    const bars = [];
    for (let index = 0; index < 26; index += 1) {
      const bar = document.createElement("i");
      bar.className = "qg-voice-player-bar";
      bar.setAttribute("aria-hidden", "true");
      bar.style.setProperty("--bar-height", `${22 + ((index * 19 + 7) % 70)}%`);
      waveform.append(bar);
      bars.push(bar);
    }

    const time = document.createElement("span");
    time.className = "qg-voice-player-time";
    time.setAttribute("aria-live", "off");
    time.textContent = "0:00 / --:--";

    const speedButton = makeButton("qg-voice-player-speed", "Vitesse de lecture : 1 fois", "1x");
    speedButton.setAttribute("aria-pressed", "false");

    const audio = document.createElement("audio");
    audio.className = "qg-voice-player-audio";
    audio.hidden = true;
    audio.controls = false;
    audio.preload = "none";
    audio.setAttribute("aria-hidden", "true");
    audio.src = source;

    player.append(playButton, waveform, time, speedButton, audio);

    const getDuration = () => Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const setProgress = (value) => {
      const duration = getDuration();
      const ratio = duration ? Math.max(0, Math.min(1, value / duration)) : 0;
      const percent = Math.round(ratio * 1000) / 10;
      waveform.style.setProperty("--voice-progress", `${percent}%`);
      waveform.setAttribute("aria-valuenow", String(Math.round(percent)));
      waveform.setAttribute("aria-valuetext", `${formatTime(value)} sur ${formatTime(duration)}`);
      bars.forEach((bar, index) => bar.classList.toggle("is-played", (index + 1) / bars.length <= ratio));
      time.textContent = `${formatTime(value)} / ${formatTime(duration)}`;
    };

    const updatePlayButton = () => {
      const isPlaying = !audio.paused && !audio.ended;
      playButton.textContent = isPlaying ? "⏸️" : "▶️";
      playButton.setAttribute("aria-label", `${isPlaying ? "Mettre en pause" : "Lire"} ${label}`);
      player.dataset.state = isPlaying ? "playing" : getDuration() ? "ready" : "loading";
    };

    const showUnavailable = () => {
      player.dataset.state = "error";
      player.dataset.error = "true";
      playButton.disabled = true;
      waveform.setAttribute("aria-disabled", "true");
      time.textContent = "Audio indisponible";
      waveform.setAttribute("aria-valuetext", "Audio indisponible");
    };

    const seekToPointer = (event) => {
      const duration = getDuration();
      if (!duration) return;
      const bounds = waveform.getBoundingClientRect();
      if (!bounds.width) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      audio.currentTime = ratio * duration;
      setProgress(audio.currentTime);
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

    waveform.addEventListener("click", seekToPointer);
    waveform.addEventListener("keydown", (event) => {
      const duration = getDuration();
      if (!duration) return;
      let nextTime = audio.currentTime;
      if (event.key === "ArrowRight" || event.key === "PageUp") nextTime += event.key === "PageUp" ? 10 : 5;
      else if (event.key === "ArrowLeft" || event.key === "PageDown") nextTime -= event.key === "PageDown" ? 10 : 5;
      else if (event.key === "Home") nextTime = 0;
      else if (event.key === "End") nextTime = duration;
      else return;
      event.preventDefault();
      audio.currentTime = Math.max(0, Math.min(duration, nextTime));
      setProgress(audio.currentTime);
    });

    speedButton.addEventListener("click", () => {
      audio.playbackRate = audio.playbackRate === 1 ? 1.5 : 1;
      const fast = audio.playbackRate === 1.5;
      speedButton.textContent = fast ? "1.5x" : "1x";
      speedButton.setAttribute("aria-pressed", String(fast));
      speedButton.setAttribute("aria-label", `Vitesse de lecture : ${fast ? "1,5 fois" : "1 fois"}`);
    });

    audio.addEventListener("loadedmetadata", () => {
      player.dataset.error = "false";
      playButton.disabled = false;
      waveform.removeAttribute("aria-disabled");
      setProgress(audio.currentTime || 0);
      updatePlayButton();
    });
    audio.addEventListener("durationchange", () => setProgress(audio.currentTime || 0));
    audio.addEventListener("timeupdate", () => setProgress(audio.currentTime || 0));
    audio.addEventListener("play", updatePlayButton);
    audio.addEventListener("pause", updatePlayButton);
    audio.addEventListener("ended", () => {
      setProgress(0);
      audio.currentTime = 0;
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
