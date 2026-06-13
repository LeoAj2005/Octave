// ========== Global Utilities ==========
function debugLog(level, rawMessageContent) {
  const serializedLogMarker = `${new Date().toISOString()} [${level.toUpperCase()}] ${rawMessageContent}`;
  console[level](serializedLogMarker);
  try {
    let executionLogStack = JSON.parse(
      localStorage.getItem("at_runtime_telemetry") || "[]"
    );
    executionLogStack.push(serializedLogMarker);
    if (executionLogStack.length > 50) {
      executionLogStack.shift();
    }
    localStorage.setItem(
      "at_runtime_telemetry",
      JSON.stringify(executionLogStack)
    );
  } catch (e) {}
}

const fetchWithTimeout = (promise, ms = 10000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Stream fetch timeout")), ms)
    ),
  ]);

const ApplicationOrchestrator = {
  activeScreenContext: "home",
  navigationHistoryStack: ["home"],
  activePlaylistQueue: [],
  activeQueueTrackIndex: 0,
  _toastTimer: null,
  _searchDebounceTimer: null,
  isExitModalActive: false,

  init() {
    this.setupGlobalUnhandledRejectionBoundary();
    this.bindUserInteractionTriggers();
    this.restorePersistentQueueState();
  },

  setupGlobalUnhandledRejectionBoundary() {
    window.addEventListener("unhandledrejection", (event) => {
      console.error("Unhandled runtime promise rejection:", event.reason);
      this.showToastMessage("Unexpected transmission fallback occurred.");
    });
  },

  showToastMessage(msg) {
    const toastNode = document.getElementById("global-error-banner");
    if (this._toastTimer) clearTimeout(this._toastTimer);
    toastNode.textContent = msg;
    toastNode.style.display = "block";

    this._toastTimer = setTimeout(() => {
      toastNode.style.display = "none";
      this._toastTimer = null;
    }, 4000);
  },

  routeToScreen(targetScreenName) {
    const domTargetScreenNode = document.getElementById(
      `screen-${targetScreenName}`
    );
    if (!domTargetScreenNode) return;

    document.querySelectorAll(".screen").forEach((viewNode) => {
      viewNode.style.display = "none";
      viewNode.classList.remove("active");
    });

    domTargetScreenNode.style.display = "block";
    domTargetScreenNode.classList.add("active");

    this.activeScreenContext = targetScreenName;
    if (
      this.navigationHistoryStack[this.navigationHistoryStack.length - 1] !==
      targetScreenName
    ) {
      this.navigationHistoryStack.push(targetScreenName);
    }

    // Hybrid double rAF + 20ms safety gap for slow TV hardware
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (typeof SpatialNavigationEngine !== "undefined") {
            SpatialNavigationEngine.rescanActiveContext();
          }
        }, 20);
      });
    });
  },

  navigateBackStack() {
    if (this.isExitModalActive) {
      this.toggleExitModal(false);
      return;
    }

    if (this.navigationHistoryStack.length > 1) {
      this.navigationHistoryStack.pop();
      this.routeToScreen(
        this.navigationHistoryStack[this.navigationHistoryStack.length - 1]
      );
    } else {
      this.toggleExitModal(true);
    }
  },

  toggleExitModal(shouldShow) {
    const modal = document.getElementById("exit-modal");
    this.isExitModalActive = shouldShow;
    modal.style.display = shouldShow ? "flex" : "none";

    if (typeof SpatialNavigationEngine !== "undefined") {
      SpatialNavigationEngine.rescanActiveContext();
    }
  },

  bindUserInteractionTriggers() {
    const sourceSelect = document.getElementById("source-provider-select");
    const savedProvider =
      localStorage.getItem("at_active_provider") || "spotiflac";
    sourceSelect.value = savedProvider;
    if (typeof MediaAPI !== "undefined")
      MediaAPI.setActiveProvider(savedProvider);

    sourceSelect.addEventListener("change", (event) => {
      const newProvider = event.target.value;
      localStorage.setItem("at_active_provider", newProvider);
      if (typeof MediaAPI !== "undefined")
        MediaAPI.setActiveProvider(newProvider);
      this.showToastMessage(`Switched catalog to ${newProvider.toUpperCase()}`);
    });

    const sidebar = document.getElementById("sidebar");

    sidebar.addEventListener("click", (event) => {
      const menuItemNode = event.target.closest(".nav-item");
      if (menuItemNode) {
        const target = menuItemNode.getAttribute("data-screen");
        if (target) this.routeToScreen(target);
      }
    });

    sidebar.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const menuItemNode = event.target.closest(".nav-item");
        if (menuItemNode) {
          const target = menuItemNode.getAttribute("data-screen");
          if (target) {
            this.routeToScreen(target);
            event.preventDefault();
          }
        }
      }
    });

    const searchFieldInputNode = document.getElementById("search-bar");
    searchFieldInputNode.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        searchFieldInputNode.value.trim().length > 0
      ) {
        if (this._searchDebounceTimer) clearTimeout(this._searchDebounceTimer);
        this.executeSearchAction(searchFieldInputNode.value.trim());
      }
    });

    document
      .getElementById("btn-factory-reset")
      .addEventListener("click", () => {
        localStorage.clear();
        this.showToastMessage("App states reset successfully.");
        window.location.reload();
      });

    document
      .getElementById("btn-exit-confirm")
      .addEventListener("click", () => window.close());
    document
      .getElementById("btn-exit-cancel")
      .addEventListener("click", () => this.toggleExitModal(false));
  },

  async executeSearchAction(query) {
    const searchStatusNode = document.getElementById("search-status-message");
    searchStatusNode.innerHTML =
      '<div class="loading-spinner" role="progressbar"></div>';

    try {
      const response =
        await ReverseEngineeredAPIConnector.executeInnerTubeSearch(query);
      searchStatusNode.innerHTML = "";
      document.getElementById("search-bar").blur();

      if (response.error) {
        this.showToastMessage(
          `Search Error: ${response.error} (${response.name || "Unknown"})`
        );
        return;
      }
      this.populateSearchGrid(response.data);
    } catch (criticalUiError) {
      searchStatusNode.innerHTML = "";
      this.showToastMessage(`UI Crash: ${criticalUiError.message}`);
    }
  },

  populateSearchGrid(trackDataset) {
    const targetOutputGridNode = document.getElementById("search-results");
    targetOutputGridNode.innerHTML = "";

    if (trackDataset.length === 0) {
      targetOutputGridNode.innerHTML =
        '<p class="error-message" style="grid-column: 1/-1; font-size:28px;">No matching tracks discovered.</p>';
      return;
    }

    trackDataset.forEach((trackItem, index) => {
      const cardAnchorNode = document.createElement("div");
      cardAnchorNode.className = "music-card focusable";
      cardAnchorNode.setAttribute("tabindex", "0");
      cardAnchorNode.setAttribute("role", "button");
      cardAnchorNode.setAttribute(
        "aria-label",
        `${trackItem.title} by ${trackItem.artist}`
      );
      cardAnchorNode.setAttribute("data-id", trackItem.id);

      cardAnchorNode.innerHTML = `
                <img src="${trackItem.artwork || "icon.png"}" loading="lazy">
                <div class="track-title">${SecureCryptoSandbox.sanitizeOutputText(trackItem.title)}</div>
                <div class="track-artist">${SecureCryptoSandbox.sanitizeOutputText(trackItem.artist)}</div>
            `;

      cardAnchorNode.addEventListener("click", () => {
        // Lock BEFORE preUnlock to prevent remote interruption
        NativePlaybackCore.isFetchingStream = true;
        NativePlaybackCore.preUnlockAudioEngine();

        this.activePlaylistQueue = [...trackDataset];
        this.activeQueueTrackIndex = index;
        this.persistCurrentQueueState();
        NativePlaybackCore.engageTrackStreaming(trackItem);
        this.routeToScreen("player");
      });

      targetOutputGridNode.appendChild(cardAnchorNode);
    });

    if (NativePlaybackCore.currentlyActiveTrackContext) {
      NativePlaybackCore.updateActiveCardHighlights(
        NativePlaybackCore.currentlyActiveTrackContext.id
      );
    }
  },

  renderHomeShelf() {
    const homeShelfNode = document.getElementById("home-shelf");
    homeShelfNode.innerHTML = "";

    const initialRecommends = [
      {
        id: "7wtfhZwyrcc",
        title: "ArchiveTune TV Welcome Stream",
        artist: "Core System Engine",
        artwork: "icon.png",
      },
      {
        id: "dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
        artist: "Rick Astley",
        artwork: "icon.png",
      },
    ];

    initialRecommends.forEach((stubTrack, index) => {
      const cardNode = document.createElement("div");
      cardNode.className = "music-card focusable";
      cardNode.setAttribute("tabindex", "0");
      cardNode.setAttribute("role", "button");
      cardNode.setAttribute(
        "aria-label",
        `${stubTrack.title} by ${stubTrack.artist}`
      );
      cardNode.setAttribute("data-id", stubTrack.id);

      cardNode.innerHTML = `
                <img src="${stubTrack.artwork}">
                <div class="track-title">${stubTrack.title}</div>
                <div class="track-artist">${stubTrack.artist}</div>
            `;

      cardNode.addEventListener("click", () => {
        NativePlaybackCore.isFetchingStream = true;
        NativePlaybackCore.preUnlockAudioEngine();
        this.activePlaylistQueue = [...initialRecommends];
        this.activeQueueTrackIndex = index;
        this.persistCurrentQueueState();
        NativePlaybackCore.engageTrackStreaming(stubTrack);
        this.routeToScreen("player");
      });
      homeShelfNode.appendChild(cardNode);
    });
  },

  loadInitialDiscoveryContent() {
    this.renderHomeShelf();
    if (this.activePlaylistQueue.length === 0) {
      this.activePlaylistQueue = [
        {
          id: "7wtfhZwyrcc",
          title: "ArchiveTune TV Welcome Stream",
          artist: "Core System Engine",
          artwork: "icon.png",
        },
        {
          id: "dQw4w9WgXcQ",
          title: "Never Gonna Give You Up",
          artist: "Rick Astley",
          artwork: "icon.png",
        },
      ];
    }
  },

  persistCurrentQueueState() {
    try {
      localStorage.setItem(
        "at_cached_queue",
        JSON.stringify(this.activePlaylistQueue)
      );
      localStorage.setItem(
        "at_cached_index",
        this.activeQueueTrackIndex.toString()
      );
    } catch (e) {
      console.error("Failed persisting app markers: ", e);
    }
  },

  async restorePersistentQueueState() {
    try {
      const queueData = localStorage.getItem("at_cached_queue");
      const indexData = localStorage.getItem("at_cached_index");
      if (queueData && indexData) {
        this.activePlaylistQueue = JSON.parse(queueData);
        this.activeQueueTrackIndex = parseInt(indexData, 10);
        const trackItem = this.activePlaylistQueue[this.activeQueueTrackIndex];
        if (trackItem) {
          document.getElementById("player-track-title").textContent =
            trackItem.title;
          document.getElementById("player-track-artist").textContent =
            trackItem.artist;
          NativePlaybackCore.currentlyActiveTrackContext = trackItem;
          this.renderHomeShelf();
          NativePlaybackCore.updateActiveCardHighlights(trackItem.id);
        }
      } else {
        this.loadInitialDiscoveryContent();
      }
    } catch (err) {
      this.loadInitialDiscoveryContent();
    }
  },
};

const NativePlaybackCore = {
  audioElementNodeTarget: null,
  currentlyActiveTrackContext: null,
  isFetchingStream: false,            // lock to prevent remote interruption during fetch
  playbackResetTimerReference: null,  // reference to the fallback timeout
  activeStreamAbortController: null,  // aborts cross‑provider search + stream fetch

  init() {
    this.audioElementNodeTarget = document.getElementById(
      "native-audio-player"
    );
    this.audioElementNodeTarget.addEventListener("timeupdate", () =>
      this.refreshProgressBarState()
    );
    this.audioElementNodeTarget.addEventListener("ended", () =>
      this.handleTrackAutoAdvance()
    );

    // Robust media error handler – suppresses harmless abort events,
    // clears the fallback timer, and logs specific errors.
    this.audioElementNodeTarget.addEventListener("error", () => {
      const errorState = this.audioElementNodeTarget.error;

      // User skip / track change – ignore completely
      if (errorState && errorState.code === MediaError.MEDIA_ERR_ABORTED) {
        debugLog("info", "[Decoder] Previous media socket cleanly dropped for incoming track.");
        return;
      }

      // Cancel any pending fallback timeout to prevent race conditions
      if (this.playbackResetTimerReference) {
        clearTimeout(this.playbackResetTimerReference);
        this.playbackResetTimerReference = null;
      }

      let diagnosticString = "Stream Error Context";
      if (errorState) {
        switch (errorState.code) {
          case MediaError.MEDIA_ERR_NETWORK:
            diagnosticString = "Network connection dropped.";
            break;
          case MediaError.MEDIA_ERR_DECODE:
            diagnosticString = "Decoder processing error.";
            break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            diagnosticString = "MIME container unsupported by webOS player hardware.";
            break;
        }
      }

      debugLog("error", `[Hardware Element Fault]: ${diagnosticString} (Code ${errorState?.code})`);
      this.resetPlaybackPipeline();
    });

    this.wireControlPadButtons();
    this.setupNativeMediaSessionAPI();
  },

  // Lock‑aware pre‑unlock: does nothing if a fetch is in progress or a source is already set
  preUnlockAudioEngine() {
    try {
      if (!this.audioElementNodeTarget) return;

      if (this.isFetchingStream || (this.audioElementNodeTarget.src && this.audioElementNodeTarget.src !== "")) {
        return;
      }

      this.audioElementNodeTarget.pause();
      this.audioElementNodeTarget.removeAttribute("src");
      debugLog("info", "[PlaybackCore] Initial hardware thread primed.");
    } catch (e) {
      console.warn("[PlaybackCore] Pre-unlock bypassed:", e.message);
    }
  },

  setupNativeMediaSessionAPI() {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => {
        this.playAudioSafely();
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        this.audioElementNodeTarget.pause();
        document.getElementById("btn-play").textContent = "▶";
      });
      navigator.mediaSession.setActionHandler("previoustrack", () =>
        this.triggerQueueShift(-1)
      );
      navigator.mediaSession.setActionHandler("nexttrack", () =>
        this.triggerQueueShift(1)
      );
    }
  },

  wireControlPadButtons() {
    document.getElementById("btn-play").addEventListener("click", () => {
      this.isFetchingStream = true;
      this.preUnlockAudioEngine();
      if (this.audioElementNodeTarget.paused) {
        this.playAudioSafely();
      } else {
        this.audioElementNodeTarget.pause();
        document.getElementById("btn-play").textContent = "▶";
      }
      this.isFetchingStream = false;
    });

    document.getElementById("btn-prev").addEventListener("click", () => {
      this.isFetchingStream = true;
      this.preUnlockAudioEngine();
      this.triggerQueueShift(-1);
    });
    document.getElementById("btn-next").addEventListener("click", () => {
      this.isFetchingStream = true;
      this.preUnlockAudioEngine();
      this.triggerQueueShift(1);
    });
  },

  playAudioSafely() {
    try {
      if (!this.audioElementNodeTarget) return;

      this.audioElementNodeTarget
        .play()
        .then(() => {
          document.getElementById("btn-play").textContent = "⏸";
        })
        .catch((err) => {
          console.warn("Play blocked:", err.message);
          document.getElementById("btn-play").textContent = "▶";
          if (err.name === "NotAllowedError") {
            ApplicationOrchestrator.showToastMessage("Press ▶ to start playback.");
          } else {
            ApplicationOrchestrator.showToastMessage(`Play error: ${err.message}`);
          }
        });
    } catch (fatalAudioError) {
      console.error("Fatal audio boundary hit:", fatalAudioError);
      ApplicationOrchestrator.showToastMessage("Audio system unstable, reload recommended.");
    }
  },

  // ──────────────────────────────────────────────
  //  HYBRID ROUTER – SpotiFLAC metadata → YouTube audio
  // ──────────────────────────────────────────────
  async engageTrackStreaming(trackContextObject) {
    if (!trackContextObject) return;

    // Abort any previous cross‑provider pipeline
    if (this.activeStreamAbortController) {
      this.activeStreamAbortController.abort();
    }
    this.activeStreamAbortController = new AbortController();
    const signal = this.activeStreamAbortController.signal;

    this.isFetchingStream = true;
    debugLog("info", `[Playback Core] Resolving track pipeline for: "${trackContextObject.title}"`);

    // Instant UI update
    document.getElementById("player-track-title").textContent =
      trackContextObject.title;
    document.getElementById("player-track-artist").textContent =
      trackContextObject.artist;

    const artContainer = document.getElementById("player-art-container");
    if (trackContextObject.artwork) {
      artContainer.innerHTML = `<img src="${trackContextObject.artwork}">`;
    } else {
      artContainer.innerHTML = `<div class="art-placeholder" role="img">🎵</div>`;
    }

    // Safe teardown of previous source
    try {
      if (this.audioElementNodeTarget) {
        this.audioElementNodeTarget.pause();
        this.audioElementNodeTarget.removeAttribute("src");
      }
    } catch (e) {
      console.warn(e);
    }

    let lookupStreamResponse = null;

    try {
      if (trackContextObject.provider === "spotiflac") {
        debugLog("info", `[Hybrid Router]: Intercepting SpotiFLAC track. Sourcing cross‑match from InnerTube...`);

        // Build a clean search query
        const crossMatchQuery = `${trackContextObject.title} ${trackContextObject.artist}`;
        const searchTargetUrl = `https://music.youtube.com/youtubei/v1/search?alt=json`;
        const searchPayload = {
          context: {
            client: {
              clientName: "WEB_REMIX",
              clientVersion: "1.20250101.01.00",
              hl: "en",
              gl: "US",
            },
          },
          query: crossMatchQuery,
        };

        // Use the Cloudflare Worker to proxy the search request
        const searchRes = await fetch(
          `${CF_PROXY}${encodeURIComponent(searchTargetUrl)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(searchPayload),
            signal,
          }
        );

        const searchData = await searchRes.json();

        // Extract the first matching video ID
        const structuralSection = searchData.contents?.contents?.find(
          (c) => c.musicShelfContents
        );
        const firstMatchedTrack =
          structuralSection?.musicShelfContents?.contents?.[0]
            ?.musicResponsiveListItemRenderer;
        const extractedVideoId =
          firstMatchedTrack?.playlistItemData?.videoId;

        if (!extractedVideoId) {
          throw new Error(
            "Cross‑provider track indexing failed to map to an operational source target."
          );
        }

        debugLog(
          "info",
          `[Hybrid Router]: Match established! Video ID -> ${extractedVideoId}. Extracting audio stream...`
        );
        lookupStreamResponse = await YouTubeProvider.getStream(
          extractedVideoId,
          signal
        );
      } else {
        // Native YouTube track – use its own ID
        lookupStreamResponse = await YouTubeProvider.getStream(
          trackContextObject.id,
          signal
        );
      }

      if (lookupStreamResponse && lookupStreamResponse.error === "ABORTED") {
        this.isFetchingStream = false;
        this.activeStreamAbortController = null;
        return;
      }
      if (!lookupStreamResponse || !lookupStreamResponse.url) {
        throw new Error("Target audio link empty.");
      }
    } catch (pipelineGateError) {
      if (pipelineGateError.name === "AbortError") {
        this.isFetchingStream = false;
        this.activeStreamAbortController = null;
        return;
      }
      this.isFetchingStream = false;
      this.activeStreamAbortController = null;
      this.resetPlaybackPipeline();
      debugLog("error", `[Pipeline Context Break]: ${pipelineGateError.message}`);
      ApplicationOrchestrator.showToastMessage(
        "Playback failed: Source lookup exhausted."
      );
      return;
    }

    // Clean up locks and controllers
    this.isFetchingStream = false;
    this.activeStreamAbortController = null;

    // Clear any leftover fallback timer from a previous track
    if (this.playbackResetTimerReference) {
      clearTimeout(this.playbackResetTimerReference);
    }

    // Mount the AAC/MP4 stream directly
    this.audioElementNodeTarget.src = lookupStreamResponse.url;

    let playTriggered = false;
    this.playbackResetTimerReference = setTimeout(() => {
      if (!playTriggered) {
        playTriggered = true;
        if (this.audioElementNodeTarget.readyState >= 2) {
          this.playAudioSafely();
        } else {
          this.resetPlaybackPipeline();
          ApplicationOrchestrator.showToastMessage(
            "Stream initialization timed out."
          );
        }
      }
    }, 6500);

    this.audioElementNodeTarget.addEventListener(
      "canplay",
      () => {
        if (!playTriggered) {
          playTriggered = true;
          clearTimeout(this.playbackResetTimerReference);
          this.playAudioSafely();
        }
      },
      { once: true }
    );

    this.updateActiveCardHighlights(trackContextObject.id);

    // Lyrics fetch (non‑blocking)
    ReverseEngineeredAPIConnector.queryLrcLibForLyrics(
      trackContextObject.artist,
      trackContextObject.title
    )
      .then((res) => this.injectLyricsToView(res?.data || null))
      .catch(() => this.injectLyricsToView(null));
  },

  resetPlaybackPipeline() {
    debugLog("info", "[PlaybackCore] Resetting pipeline.");
    this.audioElementNodeTarget.removeAttribute("src");
    this.audioElementNodeTarget.load();
    document.getElementById("btn-play").textContent = "▶";
    document.getElementById("progress-bar-fill").style.width = "0%";
    document.getElementById("player-track-title").textContent = "Not Playing";
    document.getElementById("player-track-artist").textContent =
      "Select a track to start playback";
    this.updateActiveCardHighlights(null);
  },

  updateActiveCardHighlights(activeId) {
    document.querySelectorAll(".music-card").forEach((card) => {
      if (activeId && card.getAttribute("data-id") === activeId) {
        card.classList.add("track-playing");
      } else {
        card.classList.remove("track-playing");
      }
    });
  },

  triggerQueueShift(offsetDirectionStep) {
    const queueSize = ApplicationOrchestrator.activePlaylistQueue.length;
    if (queueSize === 0) return;

    let targetIndex =
      ApplicationOrchestrator.activeQueueTrackIndex + offsetDirectionStep;
    if (targetIndex >= queueSize) targetIndex = 0;
    if (targetIndex < 0) targetIndex = queueSize - 1;

    ApplicationOrchestrator.activeQueueTrackIndex = targetIndex;
    ApplicationOrchestrator.persistCurrentQueueState();

    const nextTrackItem =
      ApplicationOrchestrator.activePlaylistQueue[targetIndex];
    if (nextTrackItem) this.engageTrackStreaming(nextTrackItem);
  },

  handleTrackAutoAdvance() {
    this.triggerQueueShift(1);
  },

  refreshProgressBarState() {
    if (!this.audioElementNodeTarget.duration) return;
    const completePercentageDistance =
      (this.audioElementNodeTarget.currentTime /
        this.audioElementNodeTarget.duration) *
      100;
    document.getElementById("progress-bar-fill").style.width =
      `${completePercentageDistance}%`;
  },

  injectLyricsToView(lyricsDataStructure) {
    const outputLyricsContainerNode =
      document.getElementById("lyrics-container");
    outputLyricsContainerNode.innerHTML = "";
    outputLyricsContainerNode.scrollTop = 0;

    if (!lyricsDataStructure?.plainTextLines) {
      outputLyricsContainerNode.textContent =
        "Instrumental or Plain lyrics matching missing.";
      return;
    }

    const preNode = document.createElement("pre");
    preNode.style.fontFamily = "inherit";
    preNode.style.whiteSpace = "pre-wrap";
    preNode.textContent = lyricsDataStructure.plainTextLines;
    outputLyricsContainerNode.appendChild(preNode);
  },
};

window.addEventListener("DOMContentLoaded", () => {
  ApplicationOrchestrator.init();
  NativePlaybackCore.init();
});