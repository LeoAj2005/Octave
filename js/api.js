class APIError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = "APIError";
    this.status = status;
  }
}
class PlaybackError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "PlaybackError";
  }
}

// Shared lightweight debug logger (global, used by app.js)
function debugLog(level, msg) {
  const entry = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  console[level](entry);
  try {
    let logs = JSON.parse(localStorage.getItem("at_runtime_telemetry") || "[]");
    logs.push(entry);
    if (logs.length > 50) logs.shift();
    localStorage.setItem("at_runtime_telemetry", JSON.stringify(logs));
  } catch (e) {}
}

const CF_PROXY = "https://throbbing-shadow-ef90.nullbyteai01.workers.dev/?url=";

async function fetchWithEdgeProxy(targetUrl, signal = null) {
  const proxyUrl = `${CF_PROXY}${encodeURIComponent(targetUrl)}`;
  const internalController = new AbortController();
  const timeoutId = setTimeout(() => internalController.abort(), 10000);

  try {
    console.log(`[Edge Routing]: ${targetUrl}`);
    const response = await fetch(proxyUrl, {
      method: "GET",
      signal: signal || internalController.signal,
    });
    console.log(`[Edge Response]: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = await response.text(); } catch (e) {}
      console.error("[Proxy Rejection Frame]:", errorBody || response.statusText);
      throw new APIError(`Proxy fault (HTTP ${response.status})`, response.status);
    }

    let json;
    try {
      json = await response.json();
    } catch (parseError) {
      console.error("[Proxy JSON Parse Error]:", parseError);
      throw new APIError("Invalid JSON response from proxy", 502);
    }
    return json;
  } catch (error) {
    if (error.name === "AbortError") {
      console.warn(`[Network Timeout] Request to ${targetUrl} exceeded 10s.`);
      throw new Error("Network latency threshold breached.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Proxy fetch for POST requests (e.g., YouTube InnerTube player).
 * The Cloudflare Worker must be updated to accept POST requests
 * and return a JSON object containing a "streamUrl" property.
 */
async function fetchWithEdgeProxyPost(targetUrl, body, signal = null) {
  const proxyUrl = `${CF_PROXY}${encodeURIComponent(targetUrl)}`;
  const internalController = new AbortController();
  const timeoutId = setTimeout(() => internalController.abort(), 10000);

  try {
    console.log(`[Edge POST Routing]: ${targetUrl}`);
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal || internalController.signal,
    });
    console.log(`[Edge POST Response]: ${response.status}`);

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = await response.text(); } catch (e) {}
      console.error("[Proxy POST Rejection]:", errorBody);
      throw new APIError(`Proxy POST fault (HTTP ${response.status})`, response.status);
    }

    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      console.warn(`[Network Timeout] POST to ${targetUrl} exceeded 10s.`);
      throw new Error("Network latency threshold breached.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * MODULE 1: YouTube InnerTube Provider Engine
 */
const YouTubeProvider = {
  _buildContext() {
    return {
      context: {
        client: {
          clientName: "WEB_REMIX",
          clientVersion: "1.20260603.01.00",
          hl: "en",
          gl: "US",
        },
      },
    };
  },

  // Search still uses direct POST; CORS may be an issue on some devices.
  // In production, route through the worker.
  async search(query) {
    try {
      const res = await fetch(
        "https://music.youtube.com/youtubei/v1/search?alt=json",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...this._buildContext(), query }),
        }
      );
      if (!res.ok) throw new APIError(`HTTP Search failure`, res.status);

      const data = await res.json();
      const tracks = [];
      const sections =
        data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer
          ?.content?.sectionListRenderer?.contents || [];

      sections.forEach((section) => {
        const items = section.musicShelfRenderer?.contents || [];
        items.forEach((item) => {
          const columns =
            item.musicResponsiveListItemRenderer?.flexColumns || [];
          if (columns.length >= 2) {
            const title =
              columns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0].text;
            const artist =
              columns[1].musicResponsiveListItemFlexColumnRenderer.text.runs[0].text;
            let art =
              item.musicResponsiveListItemRenderer.thumbnail
                ?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url || "";
            if (art) art = art.replace(/w[0-9]+-h[0-9]+/, "w544-h544");

            const id =
              item.musicResponsiveListItemRenderer.playlistItemData?.videoId ||
              item.musicResponsiveListItemRenderer.overlay
                ?.musicItemThumbnailOverlayRenderer?.content
                ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint
                ?.videoId;
            if (id)
              tracks.push({
                id,
                title,
                artist,
                artwork: art || "icon.png",
                provider: "youtube",
              });
          }
        });
      });
      return { data: tracks };
    } catch (e) {
      return { error: e.message, data: [] };
    }
  },

  async getStream(videoId, signal) {
    try {
      const payload = {
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: "1.20250101.01.00",
            hl: "en",
            gl: "US",
          },
        },
        videoId: videoId,
        playbackContext: { contentPlaybackContext: { signatureTimestamp: 20400 } },
      };

      // Route through the worker to resolve ciphered signatures.
      const result = await fetchWithEdgeProxyPost(
        "https://music.youtube.com/youtubei/v1/player?alt=json",
        payload,
        signal
      );

      if (result && result.streamUrl) {
        debugLog("info", "[YouTube] Stream URL resolved via proxy.");
        return { url: result.streamUrl };
      }

      // Fallback: direct API call + local cipher extraction (may fail).
      debugLog("warn", "[YouTube] Proxy did not provide streamUrl, attempting local extraction.");
      const directRes = await fetch(
        "https://music.youtube.com/youtubei/v1/player?alt=json",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-YouTube-Client-Name": "67",
            "X-YouTube-Client-Version": "1.20250101.01.00",
          },
          body: JSON.stringify(payload),
          signal,
        }
      );
      if (!directRes.ok)
        throw new APIError(`YouTube API refused (HTTP ${directRes.status})`, directRes.status);

      const data = await directRes.json();
      if (data.playabilityStatus?.status === "UNPLAYABLE") {
        throw new PlaybackError(data.playabilityStatus.reason || "Track restricted.");
      }

      const audioFormats =
        data.streamingData?.adaptiveFormats?.filter((f) =>
          f.mimeType?.startsWith("audio/")
        ) || [];
      if (audioFormats.length === 0)
        throw new PlaybackError("No available audio tracks.");

      const bestStream = audioFormats.find((f) => f.url) || audioFormats[0];
      if (bestStream.url) return { url: bestStream.url };

      const cipher = bestStream.signatureCipher || bestStream.cipher;
      if (!cipher) throw new PlaybackError("Stream signature format unhandled.");
      const params = new URLSearchParams(cipher);
      const url = `${params.get("url")}&${params.get("sp") || "sig"}=${params.get("s")}`;
      debugLog("info", "[YouTube] Cipher fallback URL built (may be invalid).");
      return { url };
    } catch (error) {
      if (error.name === "AbortError") {
        debugLog("info", "[YouTube] Stream request aborted by user.");
        return { error: "ABORTED" };
      }
      debugLog("error", `[YouTube Failure] ${error.message}`);
      return { error: error.message };
    }
  },
};

/**
 * MODULE 2: SpotiFLAC (Eclipse API) Provider Engine
 */
const SpotiFlacProvider = {
  baseUrl: "https://spotiflac.eclipsemusic.app/a3990bb42069a915",
  async search(query) {
    try {
      const targetUrl = `${this.baseUrl}/search?q=${encodeURIComponent(query)}&type=track`;
      const data = await fetchWithEdgeProxy(targetUrl);
      console.warn("[SpotiFLAC Raw JSON Dump]:", JSON.stringify(data));

      const rawList = data.tracks || [];
      const tracks = rawList.map((t) => ({
        id: t.id ? String(t.id) : "",
        title: t.title || "Unknown Title",
        artist: t.artist || "Unknown Artist",
        artwork: t.artworkURL || "icon.png",
        provider: "spotiflac",
      }));

      debugLog("info", `[SpotiFLAC] Populated ${tracks.length} items.`);
      return { data: tracks };
    } catch (e) {
      return { error: e.message, data: [] };
    }
  },

  async getStream(id, signal) {
    // signal unused but kept for interface compatibility
    try {
      const streamUrl = `${this.baseUrl}/stream?id=${id}`;
      debugLog("info", `[SpotiFLAC Core]: Routing through Edge Proxy.`);
      return { url: `${CF_PROXY}${encodeURIComponent(streamUrl)}` };
    } catch (e) {
      if (e.name === "AbortError") return { error: "ABORTED" };
      return { error: e.message };
    }
  },
};

/**
 * MASTER ROUTER CENTRAL ENGINE CONTROL: MediaAPI
 */
const MediaAPI = {
  activeProvider: "spotiflac",
  activeStreamController: null,

  setActiveProvider(provider) {
    this.activeProvider = provider;
  },

  async search(query) {
    if (this.activeProvider === "spotiflac")
      return await SpotiFlacProvider.search(query);
    return await YouTubeProvider.search(query);
  },

  async getStreamUrl(trackId) {
    if (this.activeStreamController) {
      this.activeStreamController.abort();
    }
    this.activeStreamController = new AbortController();
    const signal = this.activeStreamController.signal;

    try {
      let result;
      if (this.activeProvider === "spotiflac") {
        result = await SpotiFlacProvider.getStream(trackId, signal);
      } else {
        result = await YouTubeProvider.getStream(trackId, signal);
      }

      if (result && result.error !== "ABORTED") {
        this.activeStreamController = null;
      }
      return result;
    } catch (err) {
      if (err.name === "AbortError") {
        return { error: "ABORTED" };
      }
      return { error: err.message };
    }
  },

  async queryLrcLibForLyrics(artistName, songTitle) {
    const destinationUrl = `https://lrclib.net/api/search?artist_name=${encodeURIComponent(artistName)}&track_name=${encodeURIComponent(songTitle)}`;
    try {
      const connectionStream = await fetch(destinationUrl);
      if (!connectionStream.ok) return { data: null };
      const collectionArray = await connectionStream.json();
      if (collectionArray?.length > 0) {
        return {
          data: {
            plainTextLines: collectionArray[0].lyrics || "",
            synchronizedLines: collectionArray[0].syncedLyrics || "",
          },
        };
      }
      return { data: null };
    } catch (e) {
      return { data: null };
    }
  },
};

const ReverseEngineeredAPIConnector = {
  executeInnerTubeSearch: async (query) => await MediaAPI.search(query),
  extractDirectStreamUrl: async (id) => await MediaAPI.getStreamUrl(id),
  queryLrcLibForLyrics: async (artist, title) =>
    await MediaAPI.queryLrcLibForLyrics(artist, title),
};