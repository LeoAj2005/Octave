// ========== Global Utilities ==========
// debugLog is provided by api.js (loaded first) – no duplication.

// Safely validate an image URL to prevent attribute injection
function safeImageUrl(url) {
  if (!url) return "icon.png";
  if (url.startsWith("https://") || url.startsWith("http://") || url.startsWith("/") || url.startsWith(".")) {
    return url;
  }
  return "icon.png"; // reject data:, javascript:, etc.
}

// Create a track card using DOM APIs (safe, no innerHTML injection)
function createTrackCard(trackItem) {
  const card = document.createElement("div");
  card.className = "music-card focusable";
  card.setAttribute("tabindex", "0");
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${trackItem.title} by ${trackItem.artist}`);
  card.setAttribute("data-id", trackItem.id);

  const img = document.createElement("img");
  img.src = safeImageUrl(trackItem.artwork);
  img.loading = "lazy";
  card.appendChild(img);

  const titleDiv = document.createElement("div");
  titleDiv.className = "track-title";
  titleDiv.textContent = trackItem.title;
  card.appendChild(titleDiv);

  const artistDiv = document.createElement("div");
  artistDiv.className = "track-artist";
  artistDiv.textContent = trackItem.artist;
  card.appendChild(artistDiv);

  return card;
}

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
      const card = createTrackCard(trackItem);
      card.addEventListener("click", () => {
        NativePlaybackCore.isFetchingStream = true;
        this.activePlaylistQueue = [...trackDataset];
        this.activeQueueTrackIndex = index;
        this.persistCurrentQueueState();
        NativePlaybackCore.engageTrackStreaming(trackItem);
        this.routeToScreen("player");
      });
      targetOutputGridNode.appendChild(card);
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
      const card = createTrackCard(stubTrack);
      card.addEventListener("click", () => {
        NativePlaybackCore.isFetchingStream = true;
        this.activePlaylistQueue = [...initialRecommends];
        this.activeQueueTrackIndex = index;
        this.persistCurrentQueueState();
        NativePlaybackCore.engageTrackStreaming(stubTrack);
        this.routeToScreen("player");
      });
      homeShelfNode.appendChild(card);
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

// ========== Native Playback Core (Luna Service Bridge) ==========
const NativePlaybackCore = {
  currentlyActiveTrackContext: null,
  isFetchingStream: false,
  activeStreamAbortController: null,
  progressPollingInterval: null,
  fallbackAttempted: false,   // prevents infinite fallback loop

  init() {
    if (typeof webOS === 'undefined' || !webOS.service) {
      console.warn("webOS Platform not found. Luna Service calls will fail in this environment.");
    }
    this.wireControlPadButtons();
    this.setupNativeMediaSessionAPI();
  },

  setupNativeMediaSessionAPI() {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => this.resumePlayback());
      navigator.mediaSession.setActionHandler("pause", () => this.pausePlayback());
      navigator.mediaSession.setActionHandler("previoustrack", () => this.triggerQueueShift(-1));
      navigator.mediaSession.setActionHandler("nexttrack", () => this.triggerQueueShift(1));
    }
  },

  wireControlPadButtons() {
    document.getElementById("btn-play").addEventListener("click", () => {
      const btn = document.getElementById("btn-play");
      if (btn.textContent === "▶") {
        this.resumePlayback();
      } else {
        this.pausePlayback();
      }
    });

    document.getElementById("btn-prev").addEventListener("click", () => {
      this.triggerQueueShift(-1);
    });
    document.getElementById("btn-next").addEventListener("click", () => {
      this.triggerQueueShift(1);
    });
  },

  resumePlayback() {
    if (!this.currentlyActiveTrackContext) return;
    
    webOS.service.request("luna://com.leoaj2005.octave.service", {
      method: "resume",
      parameters: {},
      onSuccess: () => {
        document.getElementById("btn-play").textContent = "⏸";
        this.startProgressPolling();
      },
      onFailure: (err) => {
        debugLog("error", `[Native Service] Resume failed: ${JSON.stringify(err)}`);
        if (this.currentlyActiveTrackContext) {
          this.engageTrackStreaming(this.currentlyActiveTrackContext);
        }
      }
    });
  },

  pausePlayback() {
    webOS.service.request("luna://com.leoaj2005.octave.service", {
      method: "pause",
      parameters: {},
      onSuccess: () => {
        document.getElementById("btn-play").textContent = "▶";
        this.stopProgressPolling();
      },
      onFailure: (err) => {
        debugLog("error", `[Native Service] Pause failed: ${JSON.stringify(err)}`);
      }
    });
  },

  startProgressPolling() {
    this.stopProgressPolling();
    this.progressPollingInterval = setInterval(() => {
      webOS.service.request("luna://com.leoaj2005.octave.service", {
        method: "getPosition",
        parameters: {},
        onSuccess: (res) => {
          if (res.duration > 0) {
            const pct = (res.position / res.duration) * 100;
            document.getElementById("progress-bar-fill").style.width = `${pct}%`;
            
            // Native EOS flag for precise auto-advance
            if (res.ended) {
              debugLog("info", "[EOS] Native reported end-of-stream.");
              this.handleTrackAutoAdvance();
            }
          }
        },
        onFailure: () => {}
      });
    }, 1000);
  },

  stopProgressPolling() {
    if (this.progressPollingInterval) {
      clearInterval(this.progressPollingInterval);
      this.progressPollingInterval = null;
    }
  },

  async engageTrackStreaming(trackContextObject, isFallback = false) {
    if (!trackContextObject) return;

    if (this.activeStreamAbortController) {
      this.activeStreamAbortController.abort();
    }
    this.activeStreamAbortController = new AbortController();
    const signal = this.activeStreamAbortController.signal;

    this.isFetchingStream = true;
    debugLog("info", `[Playback Core] Resolving track pipeline for: "${trackContextObject.title}"`);

    document.getElementById("player-track-title").textContent = trackContextObject.title;
    document.getElementById("player-track-artist").textContent = trackContextObject.artist;
    document.getElementById("progress-bar-fill").style.width = "0%";
    document.getElementById("btn-play").textContent = "⏳";

    const artContainer = document.getElementById("player-art-container");
    const artUrl = safeImageUrl(trackContextObject.artwork);
    if (artUrl && artUrl !== "icon.png") {
      artContainer.innerHTML = `<img src="${artUrl}" alt="Album art">`;
    } else {
      artContainer.innerHTML = `<div class="art-placeholder" role="img">🎵</div>`;
    }

    this.currentlyActiveTrackContext = trackContextObject;
    let streamUrl = null;

    try {
      const result = await MediaAPI.getStreamUrl(trackContextObject.id);
      if (result && result.url) {
        streamUrl = result.url;
      }
    } catch (resolveError) {
      debugLog("warn", `Stream URL resolution failed: ${resolveError.message}`);
    }

    // If primary provider fails and we haven't yet tried a fallback, attempt YouTube cross-match.
    if (!streamUrl && !isFallback) {
      debugLog("info", "Primary provider failed, attempting cross-provider YouTube fallback.");
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

      try {
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
        const structuralSection = searchData.contents?.contents?.find(
          (c) => c.musicShelfContents
        );
        const firstMatchedTrack =
          structuralSection?.musicShelfContents?.contents?.[0]
            ?.musicResponsiveListItemRenderer;
        const extractedVideoId =
          firstMatchedTrack?.playlistItemData?.videoId;

        if (extractedVideoId) {
          const ytRes = await YouTubeProvider.getStream(extractedVideoId, signal);
          if (ytRes && ytRes.url) {
            streamUrl = ytRes.url;
            debugLog("info", "Fallback YouTube stream acquired.");
          }
        }
      } catch (fallbackError) {
        debugLog("error", `Cross-provider fallback error: ${fallbackError.message}`);
      }
    }

    if (!streamUrl) {
      this.isFetchingStream = false;
      this.activeStreamAbortController = null;
      this.resetPlaybackPipeline();
      debugLog("error", "[Pipeline Context Break]: No stream URL found.");
      ApplicationOrchestrator.showToastMessage("Playback failed: No valid audio source.");
      return;
    }

    this.isFetchingStream = false;
    this.activeStreamAbortController = null;

    this._callNativePlay(streamUrl);
  },

  _callNativePlay(streamUrl) {
    webOS.service.request("luna://com.leoaj2005.octave.service", {
      method: "play",
      parameters: { uri: streamUrl },
      onSuccess: () => {
        debugLog("info", "[Native Service] Playback acknowledged.");
        document.getElementById("btn-play").textContent = "⏸";
        this.startProgressPolling();
        this.fallbackAttempted = false;
      },
      onFailure: (err) => {
        debugLog("error", `[Native Service] Play failed: ${JSON.stringify(err)}`);
        if (!this.fallbackAttempted && this.currentlyActiveTrackContext) {
          this.fallbackAttempted = true;
          debugLog("info", "Native play failed, triggering cross-provider fallback.");
          this.engageTrackStreaming(this.currentlyActiveTrackContext, true);
        } else {
          ApplicationOrchestrator.showToastMessage("Native Engine Error: Playback failed");
          document.getElementById("btn-play").textContent = "▶";
          this.resetPlaybackPipeline();
        }
      }
    });

    this.updateActiveCardHighlights(this.currentlyActiveTrackContext.id);

    ReverseEngineeredAPIConnector.queryLrcLibForLyrics(
      this.currentlyActiveTrackContext.artist,
      this.currentlyActiveTrackContext.title
    )
      .then((res) => this.injectLyricsToView(res?.data || null))
      .catch(() => this.injectLyricsToView(null));
  },

  resetPlaybackPipeline() {
    debugLog("info", "[PlaybackCore] Resetting pipeline.");
    this.stopProgressPolling();
    
    webOS.service.request("luna://com.leoaj2005.octave.service", {
      method: "stop",
      parameters: {},
      onSuccess: () => {},
      onFailure: () => {}
    });

    document.getElementById("btn-play").textContent = "▶";
    document.getElementById("progress-bar-fill").style.width = "0%";
    document.getElementById("player-track-title").textContent = "Not Playing";
    document.getElementById("player-track-artist").textContent = "Select a track to start playback";
    this.updateActiveCardHighlights(null);
    this.currentlyActiveTrackContext = null;
    this.fallbackAttempted = false;
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

    let targetIndex = ApplicationOrchestrator.activeQueueTrackIndex + offsetDirectionStep;
    if (targetIndex >= queueSize) targetIndex = 0;
    if (targetIndex < 0) targetIndex = queueSize - 1;

    ApplicationOrchestrator.activeQueueTrackIndex = targetIndex;
    ApplicationOrchestrator.persistCurrentQueueState();

    const nextTrackItem = ApplicationOrchestrator.activePlaylistQueue[targetIndex];
    if (nextTrackItem) this.engageTrackStreaming(nextTrackItem);
  },

  handleTrackAutoAdvance() {
    this.stopProgressPolling();
    this.triggerQueueShift(1);
  },

  injectLyricsToView(lyricsDataStructure) {
    const outputLyricsContainerNode = document.getElementById("lyrics-container");
    outputLyricsContainerNode.innerHTML = "";
    outputLyricsContainerNode.scrollTop = 0;

    if (!lyricsDataStructure?.plainTextLines) {
      outputLyricsContainerNode.textContent = "Instrumental or Plain lyrics matching missing.";
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

document.addEventListener("DOMContentLoaded", () => {
  const testBtn = document.getElementById("btn-wasm-test");
  if (!testBtn) return;

  testBtn.addEventListener("click", async () => {
    debugLog("info", "[POC Test] Starting webOS Web Audio & WASM sanity check...");
    testBtn.textContent = "Testing...";
    testBtn.style.background = "#orange";

    try {
      // 1. Test Web Audio API Engine
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("Web Audio API (AudioContext) is completely missing on this webOS version.");
      }
      
      const ctx = new AudioContextClass();
      debugLog("info", `[POC Test] AudioContext created successfully. State: ${ctx.state}`);

      // Generate a quick hardware synth beep (Oscillator) to verify driver output
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, ctx.currentTime); // A4 Note
      gain.gain.setValueAtTime(0.1, ctx.currentTime); // Low volume
      
      osc.start();
      osc.stop(ctx.currentTime + 0.5); // Play for 500ms
      debugLog("info", "[POC Test] Native browser audio oscillator fired cleanly.");

      // 2. Test WebAssembly Compilation Sandbox Limits
      // Minimal valid WebAssembly binary module (empty module bytes)
      const minimalWasmBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
      const wasmModule = await WebAssembly.compile(minimalWasmBytes);
      
      if (wasmModule) {
        debugLog("info", "[POC Test] WebAssembly compilation sandbox verified on real device hardware!");
        testBtn.textContent = "PASSED ✅";
        testBtn.style.background = "#2acc7a";
        ApplicationOrchestrator.showToastMessage("Hardware engine fully compatible with Octave WASM architecture!");
      }

    } catch (pocError) {
      debugLog("error", `[POC Test FAILURE]: ${pocError.message}`);
      testBtn.textContent = "FAILED ❌";
      testBtn.style.background = "#dc3545";
      ApplicationOrchestrator.showToastMessage(`Hardware Blocked: ${pocError.message}`);
    }
  });
});