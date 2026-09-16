/* ================================================================== */
/*  Reproductor AP — optimizado para iOS PWA                          */
/*  - Sin AudioContext ni osciladores (batería)                       */
/*  - Sin canvas ni rAF constante (batería)                           */
/*  - Media Session completa (next/prev desde lock screen)            */
/*  - Orden corregido (sin saltos aleatorios en modo normal)          */
/* ================================================================== */

const playlist = Array.isArray(window.PLAYLIST) ? window.PLAYLIST : [];
const defaultCover = "assets/default-cover.png";

const elements = {
  audio: document.getElementById("audioElement"),
  cover: document.getElementById("coverArt"),
  title: document.getElementById("trackTitle"),
  artist: document.getElementById("artistName"),
  library: document.getElementById("libraryList"),
  count: document.getElementById("songCount"),
  detailCover: document.getElementById("detailCover"),
  detailTitle: document.getElementById("detailTitle"),
  detailArtist: document.getElementById("detailArtist"),
  detailDate: document.getElementById("detailDate"),
  detailAlbum: document.getElementById("detailAlbum"),
  detailDescription: document.getElementById("detailDescription"),
  detailLyrics: document.getElementById("detailLyrics"),
  play: document.getElementById("playButton"),
  previous: document.getElementById("previousButton"),
  next: document.getElementById("nextButton"),
  seek: document.getElementById("seekBar"),
  currentTime: document.getElementById("currentTime"),
  durationTime: document.getElementById("durationTime"),
  status: document.getElementById("statusText"),
  volume: document.getElementById("volumeSlider"),
  shuffle: document.getElementById("shuffleButton"),
  playIcon: document.getElementById("playIcon"),
  pauseIcon: document.getElementById("pauseIcon"),
  mute: document.getElementById("muteButton"),
  volumeOnIcon: document.getElementById("volumeOnIcon"),
  volumeOffIcon: document.getElementById("volumeOffIcon"),
  volumeIconFallback: document.querySelector(".volume-control svg"),
  waveLeft: document.querySelector(".wave-bars--left"),
  waveRight: document.querySelector(".wave-bars--right"),
  sparkField: document.querySelector(".spark-field")
};

let currentIndex = 0;
let isPlaying = false;
let isSeeking = false;
let shuffle = false;
let hasUserSelectedTrack = false;
let isMuted = false;
let lastVolume = 0.82;
let lastRenderedSecond = -1;
let lastPositionUpdate = 0;
let preloadedLink = null;
const TRANSITION_MS = 220;
let transitionTimer = null;
let isFirstLoad = true;

// Demo (track sin src): solo reloj, sin audio
let demoStartedAt = 0;
let demoPausedAt = 0;
let demoRafId = 0;

const metadataCache = new Map();

// ------------------------------------------------------------------
// Arranque
// ------------------------------------------------------------------
function boot() {
  // Manifest solo en http(s) — evita el error de CORS en file://
  if (location.protocol === "http:" || location.protocol === "https:") {
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = "manifest.json";
    document.head.appendChild(link);
  }
  buildWaveBars();
  buildSparkles();

  elements.count.textContent = playlist.length;
  setupMediaSession();
  setupKeyboardShortcuts();
  registerServiceWorker();

  renderLibrary();
  loadTrack(0, false);
  hydrateAllTrackMetadata();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isPlaying) {
      // Por si iOS libera el audio al volver del background
      if (!getTrack().demo && elements.audio.paused) {
        // No forzamos play (iOS podría bloquear); solo refrescamos handlers
        refreshMediaSessionHandlers();
      }
      // Reanudar loop demo si hacía falta
      if (getTrack().demo && isPlaying) startDemoLoop();
    }
  });

  // Necesario: el volumen inicial se aplica cuando el audio existe
  elements.audio.volume = lastVolume;
  elements.audio.muted = false;
  updateMuteIcon();
  hideLoadingScreenWhenReady();
}

function hideLoadingScreenWhenReady() {
  const MIN_SHOW_MS = 700; // mínimo visible para que no sea un flash
  const start = performance.now();

  const waitForCover = new Promise((resolve) => {
    const img = elements.cover;
    if (img.complete && img.naturalWidth > 0) return resolve();
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 2000);
  });

  const waitForAudio = new Promise((resolve) => {
    const track = getTrack();
    if (track.demo || elements.audio.readyState >= 1) return resolve();
    elements.audio.addEventListener("loadedmetadata", resolve, { once: true });
    setTimeout(resolve, 2000);
  });

  // Safety net: nunca más de 6s en pantalla
  const safety = new Promise((resolve) => setTimeout(resolve, 6000));

  Promise.race([Promise.all([waitForCover, waitForAudio]), safety]).then(() => {
    const elapsed = performance.now() - start;
    const remaining = Math.max(0, MIN_SHOW_MS - elapsed);

    setTimeout(() => {
      const screen = document.getElementById("loadingScreen");
      if (!screen || screen.classList.contains("is-hidden")) return;
      screen.classList.add("is-hidden");
      // Quitamos el nodo del DOM cuando termina la transición
      setTimeout(() => screen.remove(), 750);
    }, remaining);
  });
}

// ------------------------------------------------------------------
// Generadores visuales (una sola vez)
// ------------------------------------------------------------------
function buildWaveBars() {
  const build = (count) =>
    Array.from({ length: count }, (_, i) => {
      const rest = Math.max(0.08, 0.1 + Math.abs(Math.sin(i * 0.7)) * 0.35);
      const dur = (1.2 + ((i * 7) % 9) * 0.08).toFixed(2);
      return `<span style="--i:${i};--rest:${rest.toFixed(2)};--dur:${dur}s"></span>`;
    }).join("");

  if (elements.waveLeft) elements.waveLeft.innerHTML = build(22);
  if (elements.waveRight) elements.waveRight.innerHTML = build(22);
}

function buildSparkles() {
  if (!elements.sparkField) return;
  elements.sparkField.innerHTML = Array.from({ length: 12 }, (_, i) => {
    const x = (4 + i * 8 + Math.random() * 4).toFixed(1);
    const d = (12 + Math.random() * 8).toFixed(1);
    const s = (1.5 + Math.random() * 2.5).toFixed(1);
    const delay = (-(Math.random() * parseFloat(d))).toFixed(1);
    return `<span style="--x:${x}%;--d:${d}s;--s:${s}px;animation-delay:${delay}s"></span>`;
  }).join("");
}

// ------------------------------------------------------------------
// Media Session (lock screen iOS / Android)
// ------------------------------------------------------------------
function safeSetHandler(action, handler) {
  if (!("mediaSession" in navigator)) return false;
  try {
    navigator.mediaSession.setActionHandler(action, handler);
    return true;
  } catch {
    return false;
  }
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  // Cada handler va aislado: un fallo no rompe el resto
  safeSetHandler("play", () => playCurrent().catch(handlePlayError));
  safeSetHandler("pause", pauseCurrent);
  safeSetHandler("stop", pauseCurrent);
  safeSetHandler("previoustrack", () => previousTrack(true));
  safeSetHandler("nexttrack", () => nextTrack(true));

  safeSetHandler("seekto", (details) => {
    if (!Number.isFinite(details.seekTime) || getTrack().demo) return;
    elements.audio.currentTime = details.seekTime;
    updateRealClock(true);
    updateMediaPosition(true);
  });

  // CLAVE en iOS: desactivar los botones ±10s para que salgan prev/next
  safeSetHandler("seekbackward", null);
  safeSetHandler("seekforward", null);
}

/**
 * iOS "olvida" los handlers al cambiar el src del <audio>.
 * Los re-registramos cada vez que cargamos una pista.
 */
function refreshMediaSessionHandlers() {
  if (!("mediaSession" in navigator)) return;
  safeSetHandler("play", () => playCurrent().catch(handlePlayError));
  safeSetHandler("pause", pauseCurrent);
  safeSetHandler("previoustrack", () => previousTrack(true));
  safeSetHandler("nexttrack", () => nextTrack(true));
  safeSetHandler("seekto", (details) => {
    if (!Number.isFinite(details.seekTime) || getTrack().demo) return;
    elements.audio.currentTime = details.seekTime;
    updateRealClock(true);
    updateMediaPosition(true);
  });
  safeSetHandler("seekbackward", null);
  safeSetHandler("seekforward", null);
}

// ------------------------------------------------------------------
// Normalización
// ------------------------------------------------------------------
function normalizeTrack(track, index) {
  return {
    id: `${track.title || "track"}-${track.artist || "artist"}-${index}`,
    title: track.title || `Canción ${index + 1}`,
    artist: track.artist || "Artista privado",
    cover: track.cover || defaultCover,
    src: track.src || "",
    color: track.color || "#d8a7ff",
    demo: Boolean(track.demo || !track.src),
    nuevo: Boolean(track.nuevo || track.isNew),
    date: track.date || track.fecha || "Sin fecha",
    album: track.album || "Sin album",
    description: track.description || track.descripcion || "Sin descripcion larga.",
    lyrics: track.lyrics || track.letra || "Sin letra."
  };
}

function getTrack(index = currentIndex) {
  return normalizeTrack(playlist[index] || {}, index);
}

// ------------------------------------------------------------------
// Biblioteca
// ------------------------------------------------------------------
function renderLibrary() {
  elements.library.innerHTML = "";
  const fragment = document.createDocumentFragment();

  playlist.map(normalizeTrack).forEach((track, index) => {
    const button = document.createElement("button");
    button.className = "song-card";
    button.type = "button";
    button.dataset.index = index;
    button.innerHTML = `
      <img src="${track.cover}" alt="" loading="lazy" decoding="async"
           onerror="this.onerror=null;this.src='${defaultCover}'" />
      <span class="song-card-copy">
        <span class="song-card-title">
          <strong>${escapeHtml(track.title)}</strong>
          ${track.nuevo ? '<em class="new-badge">Nuevo</em>' : ""}
        </span>
        <span class="song-card-artist">${escapeHtml(track.artist)}</span>
      </span>
    `;
    fragment.appendChild(button);
  });

  elements.library.appendChild(fragment);
}

function updateLibraryCard(index) {
  const track = getTrack(index);
  const card = elements.library.querySelector(`.song-card[data-index="${index}"]`);
  if (!card) return;

  const image = card.querySelector("img");
  const title = card.querySelector("strong");
  const artist = card.querySelector(".song-card-artist");

  if (image && image.src !== track.cover) image.src = track.cover;
  if (title) title.textContent = track.title;
  if (artist) artist.textContent = track.artist;
}

// ------------------------------------------------------------------
// Carga / reproducción
// ------------------------------------------------------------------
function selectTrack(index, autoplay) {
  hasUserSelectedTrack = true;

  if (index === currentIndex && autoplay) {
    playCurrent().catch(handlePlayError);
    return;
  }

  loadTrack(index, autoplay);
}

function loadTrackInternal(index, autoplay, { instantAccent = false } = {}) {
  currentIndex = wrapIndex(index);
  const track = getTrack();

  stopDemoLoop();

  // Reset explícito: imprescindible en iOS para no arrastrar estado anterior
  elements.audio.pause();
  elements.audio.removeAttribute("src");
  elements.audio.load();

  // Asignar la nueva fuente solo si es real
  if (!track.demo) {
    elements.audio.src = track.src;
  }

  elements.title.textContent = track.title;
  elements.artist.textContent = track.artist;
  elements.cover.src = track.cover;
  elements.cover.onerror = () => {
    elements.cover.onerror = null;
    elements.cover.src = defaultCover;
  };

  elements.seek.value = 0;
  lastRenderedSecond = -1;
  elements.currentTime.textContent = "0:00";
  elements.durationTime.textContent = track.demo ? "1:40" : "0:00";
  elements.status.textContent = track.demo ? "Demo sintética lista" : "";
  elements.play.title = "Play";

  updatePlayState(false);
  applyAccent(track.color, !instantAccent);
  setActiveCards();
  renderDetails(track);

  extractPalette(track.cover, track.color);
  hydrateTrackMetadata(currentIndex);

  // CRUCIAL: re-registrar handlers tras cada cambio de src
  refreshMediaSessionHandlers();

  if (autoplay) {
    playCurrent().catch(handlePlayError);
  }
}

function loadTrack(index, autoplay, { silent = false } = {}) {
  if (transitionTimer) {
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }

  const skipTransition = isFirstLoad || silent;
  const stage = document.querySelector(".player-stage");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Sin transición: primera carga, silencioso, sin stage, o reduced-motion
  if (skipTransition || !stage || reduced) {
    isFirstLoad = false;
    loadTrackInternal(index, autoplay, { instantAccent: skipTransition });
    return;
  }

  // 1) Fade out
  stage.classList.remove("is-entering");
  stage.classList.add("is-changing");

  // 2) En el punto medio: cambiar la canción
  transitionTimer = setTimeout(() => {
    transitionTimer = null;

    loadTrackInternal(index, autoplay, { instantAccent: false });

    // 3) Fade in con "pop"
    stage.classList.remove("is-changing");
    void stage.offsetWidth;
    stage.classList.add("is-entering");

    setTimeout(() => stage.classList.remove("is-entering"), 400);
  }, TRANSITION_MS);
}

function renderDetails(track) {
  elements.detailCover.src = track.cover;
  elements.detailCover.onerror = () => {
    elements.detailCover.onerror = null;
    elements.detailCover.src = defaultCover;
  };

  elements.detailTitle.textContent = track.title;
  elements.detailArtist.textContent = track.artist;
  elements.detailDate.textContent = track.date;
  elements.detailAlbum.textContent = track.album;
  elements.detailDescription.textContent = track.description;
  elements.detailLyrics.textContent = track.lyrics;
  updateMediaSession(track);
}

async function playCurrent() {
  const track = getTrack();

  if (track.demo) {
    // Demo puramente visual (sin AudioContext)
    demoStartedAt = performance.now() / 1000 - demoPausedAt;
    elements.status.textContent = "Demo visual activa";
    updatePlayState(true);
    startDemoLoop();
    return;
  }

  try {
    elements.audio.muted = isMuted;
    elements.audio.volume = isMuted ? 0 : getVolumeValue();

    await elements.audio.play();

    updatePlayState(true);
    elements.status.textContent = "";

    // Justo después de arrancar: volver a colocar handlers (iOS)
    refreshMediaSessionHandlers();
    } catch (err) {
    console.error("[playCurrent]", err?.name, err?.message);
    handlePlayError();
  }
}

function handlePlayError() {
  elements.status.textContent = "No puedo reproducir este audio. Revisa la ruta o pulsa otra canción.";
  updatePlayState(false);
}

function pauseCurrent() {
  if (getTrack().demo) {
    demoPausedAt = getDemoTime();
    stopDemoLoop();
    elements.status.textContent = "Demo en pausa";
  } else {
    elements.audio.pause();
  }

  updatePlayState(false);
}

// ------------------------------------------------------------------
// Estado / navegación
// ------------------------------------------------------------------
function updatePlayState(nextState) {
  isPlaying = nextState;
  elements.playIcon.classList.toggle("hidden", isPlaying);
  elements.pauseIcon.classList.toggle("hidden", !isPlaying);
  elements.play.title = isPlaying ? "Pausa" : "Play";
  document.body.classList.toggle("is-playing", isPlaying);

  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    } catch {
      // opcional
    }
  }
}

function nextTrack(autoplay = isPlaying) {
  const shouldAutoplay = typeof autoplay === "boolean" ? autoplay : isPlaying;
  loadTrack(getNextIndex(), shouldAutoplay);
}

function previousTrack(autoplay = isPlaying) {
  const shouldAutoplay = typeof autoplay === "boolean" ? autoplay : isPlaying;
  loadTrack(currentIndex - 1, shouldAutoplay);
}

function getNextIndex() {
  if (!playlist.length) return 0;
  if (!shuffle || playlist.length === 1) return currentIndex + 1;

  let nextIndex = currentIndex;
  while (nextIndex === currentIndex) {
    nextIndex = Math.floor(Math.random() * playlist.length);
  }
  return nextIndex;
}

function wrapIndex(index) {
  if (!playlist.length) return 0;
  return (index + playlist.length) % playlist.length;
}

function setActiveCards() {
  if (!elements.library.children.length) return;
  const cards = document.querySelectorAll(".song-card");
  cards.forEach((card) => {
    card.classList.toggle("is-active", Number(card.dataset.index) === currentIndex);
  });
}

// ------------------------------------------------------------------
// Hidratación de metadatos — CON FIX DE RAZA
// ------------------------------------------------------------------
async function hydrateAllTrackMetadata() {
  for (let index = 0; index < playlist.length; index += 1) {
    await waitForIdle();
    await hydrateTrackMetadata(index);
  }

  const currentSrc = playlist[currentIndex]?.src;

  playlist.sort((a, b) => getDateScore(b) - getDateScore(a));
  renderLibrary();

  // Re-mapear el índice del track que estábamos mostrando
  if (currentSrc) {
    const newIndex = playlist.findIndex((track) => track.src === currentSrc);
    if (newIndex >= 0 && newIndex !== currentIndex) {
      currentIndex = newIndex;
      setActiveCards();
    }
    return;
  }

  // Fallback: nada seleccionado y no reproduciendo → aseguramos índice 0
  if (!hasUserSelectedTrack && !isPlaying) {
    loadTrack(0, false, { silent: true });
  }
}

async function hydrateTrackMetadata(index) {
  const track = getTrack(index);
  const cachedState = metadataCache.get(track.src);

  if (!track.src || track.demo || cachedState === "loading" || cachedState === "done") {
    return;
  }

  metadataCache.set(track.src, "loading");

  try {
    const metadata = await readId3Metadata(track.src);

    if (!metadata) {
      metadataCache.set(track.src, "done");
      return;
    }

    playlist[index] = {
      ...playlist[index],
      title: metadata.title || playlist[index].title,
      artist: metadata.artist || metadata.albumArtist || playlist[index].artist,
      album: metadata.album || playlist[index].album,
      date: metadata.date || playlist[index].date,
      cover: hasCustomCover(playlist[index].cover)
        ? playlist[index].cover
        : metadata.cover || playlist[index].cover
    };

    metadataCache.set(track.src, "done");
    updateLibraryCard(index);

    if (index === currentIndex) {
      const updatedTrack = getTrack(index);
      elements.title.textContent = updatedTrack.title;
      elements.artist.textContent = updatedTrack.artist;
      elements.cover.src = updatedTrack.cover;
      renderDetails(updatedTrack);
      updateMediaSession(updatedTrack);
      extractPalette(updatedTrack.cover, updatedTrack.color);
    }
  } catch {
    metadataCache.delete(track.src);
  }
}

function hasCustomCover(cover) {
  return Boolean(cover && cover !== defaultCover);
}

function waitForIdle() {
  return new Promise((resolve) => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(resolve, { timeout: 300 });
      return;
    }
    window.setTimeout(resolve, 16);
  });
}

function getDateScore(track) {
  const value = track.date || track.fecha || "";
  const match = String(value).match(/\d{4}(?:[-/.]\d{1,2})?(?:[-/.]\d{1,2})?/);

  if (!match) return 0;

  const parts = match[0].split(/[-/.]/).map(Number);
  const year = parts[0] || 0;
  const month = parts[1] || 1;
  const day = parts[2] || 1;

  return year * 10000 + month * 100 + day;
}

// ------------------------------------------------------------------
// ID3 (lectura por rangos, no descarga el mp3 completo)
// ------------------------------------------------------------------
async function readId3Metadata(src) {
  // En file:// fetch no funciona (CORS). Salimos sin romper nada.
  if (location.protocol === "file:") return null;
  const headerResponse = await fetch(src, { headers: { Range: "bytes=0-9" } });
  if (!headerResponse.ok && headerResponse.status !== 206) return null;

  const headerBytes = new Uint8Array(await headerResponse.arrayBuffer());
  if (headerBytes.length < 10 || latin1(headerBytes, 0, 3) !== "ID3") return null;

  const headerTagSize = synchsafe(headerBytes[6], headerBytes[7], headerBytes[8], headerBytes[9]);
  const response = await fetch(src, { headers: { Range: `bytes=0-${headerTagSize + 9}` } });
  if (!response.ok && response.status !== 206) return null;

  const bytes = new Uint8Array(await response.arrayBuffer());
  const version = bytes[3];
  const tagSize = synchsafe(bytes[6], bytes[7], bytes[8], bytes[9]);
  const limit = Math.min(bytes.length, tagSize + 10);
  let offset = 10;

  if (bytes[5] & 0x40) {
    const extendedSize = version === 4
      ? synchsafe(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
      : readUint32(bytes, offset);
    offset += Math.max(4, extendedSize);
  }

  const metadata = {};

  while (offset + 10 <= limit) {
    const id = latin1(bytes, offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;

    const size = version === 4
      ? synchsafe(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
      : readUint32(bytes, offset + 4);

    if (size <= 0 || offset + 10 + size > bytes.length) break;

    const frame = bytes.slice(offset + 10, offset + 10 + size);

    if (id === "TIT2") metadata.title = decodeTextFrame(frame);
    if (id === "TPE1") metadata.artist = decodeTextFrame(frame);
    if (id === "TPE2") metadata.albumArtist = decodeTextFrame(frame);
    if (id === "TALB") metadata.album = decodeTextFrame(frame);
    if (id === "TDRC" || id === "TYER") metadata.date = decodeTextFrame(frame);
    if (id === "APIC" && !metadata.cover) metadata.cover = decodeApicFrame(frame);

    offset += 10 + size;
  }

  return metadata;
}

function decodeApicFrame(frame) {
  if (!frame.length) return "";
  const encoding = frame[0];
  let offset = 1;
  const mimeEnd = findTerminator(frame, offset, 0);
  const mime = latin1(frame, offset, mimeEnd) || "image/jpeg";

  offset = mimeEnd + 1;
  offset += 1;

  const descriptionEnd = findEncodedTerminator(frame, offset, encoding);
  offset = descriptionEnd + terminatorLength(encoding);

  const imageBytes = frame.slice(offset);
  if (!imageBytes.length || !mime.startsWith("image/")) return "";

  return URL.createObjectURL(new Blob([imageBytes], { type: mime }));
}

function decodeTextFrame(frame) {
  if (!frame.length) return "";
  const encoding = frame[0];
  const content = frame.slice(1);
  let text = "";

  if (encoding === 0) text = new TextDecoder("iso-8859-1").decode(content);
  else if (encoding === 3) text = new TextDecoder("utf-8").decode(content);
  else text = decodeUtf16(content, encoding === 2);

  return cleanTagText(text);
}

function cleanTagText(text) {
  const parts = text
    .replace(/\ufeff/g, "")
    .replace(/\u0000/g, " / ")
    .replace(/\s+/g, " ")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  return [...new Set(parts)].join(" / ");
}

function decodeUtf16(bytes, bigEndian) {
  let offset = 0;
  let littleEndian = !bigEndian;

  if (bytes[0] === 0xff && bytes[1] === 0xfe) { littleEndian = true; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { littleEndian = false; offset = 2; }

  const codes = [];
  for (let index = offset; index + 1 < bytes.length; index += 2) {
    codes.push(littleEndian
      ? bytes[index] | (bytes[index + 1] << 8)
      : (bytes[index] << 8) | bytes[index + 1]);
  }
  return String.fromCharCode(...codes);
}

function findEncodedTerminator(bytes, offset, encoding) {
  if (encoding === 0 || encoding === 3) return findTerminator(bytes, offset, 0);
  for (let index = offset; index + 1 < bytes.length; index += 2) {
    if (bytes[index] === 0 && bytes[index + 1] === 0) return index;
  }
  return bytes.length;
}

function terminatorLength(encoding) {
  return encoding === 0 || encoding === 3 ? 1 : 2;
}

function findTerminator(bytes, offset, value) {
  for (let index = offset; index < bytes.length; index += 1) {
    if (bytes[index] === value) return index;
  }
  return bytes.length;
}

function latin1(bytes, start, end) {
  return Array.from(bytes.slice(start, end), (byte) => String.fromCharCode(byte)).join("");
}

function synchsafe(a, b, c, d) {
  return (a << 21) | (b << 14) | (c << 7) | d;
}

function readUint32(bytes, offset) {
  return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

/* ------------------------------------------------------------------ */
/* Acento de color: aplicación instantánea + interpolación suave      */
/* ------------------------------------------------------------------ */

// Cache de los valores actuales → evita leer getComputedStyle cada frame
let currentAccentRGB = [216, 167, 255];
let currentAccentTwoRGB = [255, 158, 216];
let accentTweenId = 0;

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function setAccentVars(a, b) {
  const root = document.documentElement.style;
  const ar = Math.round(a[0]);
  const ag = Math.round(a[1]);
  const ab = Math.round(a[2]);
  const br = Math.round(b[0]);
  const bg = Math.round(b[1]);
  const bb = Math.round(b[2]);

  root.setProperty("--accent-rgb", `${ar}, ${ag}, ${ab}`);
  root.setProperty("--accent-two-rgb", `${br}, ${bg}, ${bb}`);
  root.setProperty("--accent", rgbToHex([ar, ag, ab]));
  root.setProperty("--accent-two", rgbToHex([br, bg, bb]));
}

/**
 * Interpola suavemente los colores actuales hasta los de la nueva canción.
 * Se usa easing easeInOutQuad para que arranque y termine fino.
 */
function tweenAccent(targetHex, durationMs = 600) {
  const target = hexToRgb(targetHex) || [216, 167, 255];
  const targetTwo = rotateColor(target);

  const fromA = [...currentAccentRGB];
  const fromB = [...currentAccentTwoRGB];

  if (accentTweenId) {
    cancelAnimationFrame(accentTweenId);
    accentTweenId = 0;
  }

  const start = performance.now();
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    const e = ease(t);

    const a = [
      fromA[0] + (target[0] - fromA[0]) * e,
      fromA[1] + (target[1] - fromA[1]) * e,
      fromA[2] + (target[2] - fromA[2]) * e
    ];
    const b = [
      fromB[0] + (targetTwo[0] - fromB[0]) * e,
      fromB[1] + (targetTwo[1] - fromB[1]) * e,
      fromB[2] + (targetTwo[2] - fromB[2]) * e
    ];

    setAccentVars(a, b);
    currentAccentRGB = a;
    currentAccentTwoRGB = b;

    if (t < 1) {
      accentTweenId = requestAnimationFrame(step);
    } else {
      accentTweenId = 0;
      currentAccentRGB = target;
      currentAccentTwoRGB = targetTwo;
    }
  };

  accentTweenId = requestAnimationFrame(step);
}

/**
 * Aplica un color. Si `animate` es true, hace un tween suave desde el
 * color actual. Si no, lo aplica instantáneo.
 */
function applyAccent(hex, animate = false) {
  const primary = hexToRgb(hex) || [216, 167, 255];
  const secondary = rotateColor(primary);

  if (!animate || prefersReducedMotion) {
    currentAccentRGB = primary;
    currentAccentTwoRGB = secondary;
    setAccentVars(primary, secondary);
    return;
  }

  tweenAccent(hex, 600);
}

function extractPalette(src, fallback) {
  const image = new Image();
  // Sin crossOrigin: todo es same-origin y esto evita conflictos con el SW
  image.decoding = "async";

  image.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const size = 24;

      canvas.width = size;
      canvas.height = size;
      context.drawImage(image, 0, 0, size, size);

      const pixels = context.getImageData(0, 0, size, size).data;
      let r = 0, g = 0, b = 0, samples = 0;

      for (let i = 0; i < pixels.length; i += 16) {
        const alpha = pixels[i + 3];
        if (alpha < 120) continue;
        const brightness = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        if (brightness < 18 || brightness > 238) continue;

        r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2];
        samples += 1;
      }

      if (samples > 0) applyAccent(rgbToHex([r / samples, g / samples, b / samples]), true);
    } catch {
      applyAccent(fallback, true);
    }
  };

  image.onerror = () => applyAccent(fallback, true);
  image.src = src;
}

// ------------------------------------------------------------------
// Relojes (real y demo)
// ------------------------------------------------------------------
function updateRealClock(force = false) {
  const track = getTrack();
  if (track.demo || isSeeking) return;

  const duration = elements.audio.duration || 0;
  const currentTime = elements.audio.currentTime || 0;
  if (!duration) return;

  elements.seek.value = String((currentTime / duration) * 1000);

  const renderedSecond = Math.floor(currentTime);
  if (force || renderedSecond !== lastRenderedSecond) {
    lastRenderedSecond = renderedSecond;
    elements.currentTime.textContent = formatTime(currentTime);
    elements.durationTime.textContent = formatTime(duration);
  }
}

function updateDemoClock() {
  const track = getTrack();
  if (!track.demo || !isPlaying) return;

  const duration = 100;
  const time = getDemoTime();

  if (!isSeeking) elements.seek.value = String((time / duration) * 1000);

  elements.currentTime.textContent = formatTime(time);
  elements.durationTime.textContent = formatTime(duration);

  if (time >= duration) nextTrack(true);
}

function startDemoLoop() {
  if (demoRafId) return;
  const tick = () => {
    if (!isPlaying || !getTrack().demo) { demoRafId = 0; return; }
    updateDemoClock();
    demoRafId = requestAnimationFrame(tick);
  };
  demoRafId = requestAnimationFrame(tick);
}

function stopDemoLoop() {
  if (demoRafId) {
    cancelAnimationFrame(demoRafId);
    demoRafId = 0;
  }
}

function getDemoTime() {
  if (!isPlaying) return demoPausedAt;
  return performance.now() / 1000 - demoStartedAt;
}

// ------------------------------------------------------------------
// Formato / color helpers
// ------------------------------------------------------------------
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function hexToRgb(hex) {
  const clean = String(hex).trim().replace("#", "");
  if (!/^[a-f\d]{6}$/i.test(clean)) return null;
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16)
  ];
}

function rgbToHex(rgb) {
  return `#${rgb
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function rotateColor(rgb) {
  return [
    Math.min(255, rgb[0] * 0.84 + 48),
    Math.min(255, rgb[1] * 0.72 + 66),
    Math.min(255, rgb[2] * 0.9 + 42)
  ];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

// ------------------------------------------------------------------
// Volumen / mute
// ------------------------------------------------------------------
function setupVolumeIconFallback() {
  if (!elements.volumeIconFallback || elements.mute) return;

  elements.volumeIconFallback.style.cursor = "pointer";
  elements.volumeIconFallback.setAttribute("role", "button");
  elements.volumeIconFallback.setAttribute("tabindex", "0");
  elements.volumeIconFallback.setAttribute("aria-label", "Silenciar");
  elements.volumeIconFallback.setAttribute("title", "Silenciar");

  elements.volumeIconFallback.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleMute();
  });
}

function getVolumeValue() {
  const value = Number(elements.volume?.value);
  if (!Number.isFinite(value)) return 0.82;
  return Math.max(0, Math.min(1, value));
}

function syncOutputVolume() {
  const sliderValue = getVolumeValue();
  const outputVolume = isMuted || sliderValue === 0 ? 0 : sliderValue;

  elements.audio.volume = outputVolume;
  elements.audio.muted = isMuted || sliderValue === 0;

  updateMuteIcon();
}

function toggleMute() {
  isMuted = !isMuted;
  if (!isMuted && getVolumeValue() === 0) {
    elements.volume.value = String(lastVolume || 0.82);
  }
  syncOutputVolume();
}

function updateMuteIcon() {
  const mutedNow = isMuted || getVolumeValue() === 0;
  const label = mutedNow ? "Quitar silencio" : "Silenciar";

  elements.volumeOnIcon?.classList.toggle("hidden", mutedNow);
  elements.volumeOffIcon?.classList.toggle("hidden", !mutedNow);

  if (elements.mute) {
    elements.mute.classList.toggle("is-muted", mutedNow);
    elements.mute.setAttribute("aria-pressed", String(mutedNow));
    elements.mute.title = label;
    elements.mute.setAttribute("aria-label", label);
  }

  if (elements.volumeIconFallback && !elements.mute) {
    elements.volumeIconFallback.style.opacity = mutedNow ? "0.38" : "1";
    elements.volumeIconFallback.style.filter = mutedNow ? "grayscale(1)" : "none";
    elements.volumeIconFallback.setAttribute("aria-label", label);
    elements.volumeIconFallback.setAttribute("title", label);
  }
}

// ------------------------------------------------------------------
// Media Session metadata / position
// ------------------------------------------------------------------
function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;

  try {
    const artUrl = new URL(track.cover || defaultCover, window.location.href).href;
    const artType = getArtworkType(track.cover);

    // Varios tamaños = mejor compatibilidad iOS / Android Auto
    const artwork = [
      { src: artUrl, sizes: "96x96", type: artType },
      { src: artUrl, sizes: "128x128", type: artType },
      { src: artUrl, sizes: "192x192", type: artType },
      { src: artUrl, sizes: "256x256", type: artType },
      { src: artUrl, sizes: "384x384", type: artType },
      { src: artUrl, sizes: "512x512", type: artType }
    ];

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork
    });

    updateMediaPosition(true);
  } catch {
    // opcional
  }
}

function updateMediaPosition(force = false) {
  if (!("mediaSession" in navigator)) return;
  if (typeof navigator.mediaSession.setPositionState !== "function") return;

  // Throttle a 1/s: cada setPositionState re-renderiza el lock screen
  const now = performance.now();
  if (!force && now - lastPositionUpdate < 1000) return;
  lastPositionUpdate = now;

  const track = getTrack();
  if (track.demo) return;
  if (!Number.isFinite(elements.audio.duration) || elements.audio.duration <= 0) return;

  try {
    navigator.mediaSession.setPositionState({
      duration: elements.audio.duration,
      playbackRate: elements.audio.playbackRate || 1,
      position: Math.min(elements.audio.currentTime || 0, elements.audio.duration)
    });
  } catch {
    // best-effort
  }
}

function getArtworkType(src) {
  const clean = String(src || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

// ------------------------------------------------------------------
// Precarga del siguiente track (solo cerca del final)
// ------------------------------------------------------------------
function preloadNextTrack() {
  const next = getTrack(getNextIndex());
  if (!next.src) return;
  if (preloadedLink && preloadedLink.href.endsWith(encodeURI(next.src))) return;

  preloadedLink?.remove();
  preloadedLink = document.createElement("link");
  preloadedLink.rel = "preload";
  preloadedLink.as = "audio";
  preloadedLink.href = next.src;
  document.head.appendChild(preloadedLink);
}

// ------------------------------------------------------------------
// Interacción
// ------------------------------------------------------------------
function togglePlay() {
  if (isPlaying) pauseCurrent();
  else playCurrent().catch(() => {
    elements.status.textContent = "El navegador ha bloqueado el audio por ahora.";
    updatePlayState(false);
  });
}

let lastPointerToggleAt = 0;
elements.play.addEventListener("pointerup", () => {
  lastPointerToggleAt = performance.now();
  togglePlay();
});
elements.play.addEventListener("click", () => {
  if (performance.now() - lastPointerToggleAt < 350) return;
  togglePlay();
});

elements.previous.addEventListener("click", () => previousTrack(true));
elements.next.addEventListener("click", () => nextTrack(true));

elements.library.addEventListener("click", (event) => {
  const card = event.target.closest(".song-card");
  if (!card) return;
  selectTrack(Number(card.dataset.index), true);
});

elements.audio.addEventListener("play", () => updatePlayState(true));

elements.audio.addEventListener("pause", () => {
  if (!getTrack().demo) updatePlayState(false);
});

elements.audio.addEventListener("ended", () => {
  // Sin transición al terminar: la siguiente canción debe empezar ya
  loadTrackInternal(getNextIndex(), true);
});

elements.audio.addEventListener("loadedmetadata", () => {
  elements.durationTime.textContent = formatTime(elements.audio.duration);
  updateMediaPosition(true);
});

elements.audio.addEventListener("timeupdate", () => {
  if (isSeeking || getTrack().demo) return;
  updateRealClock(true);
  updateMediaPosition();

  // Precarga cuando quedan menos de 20s
  const dur = elements.audio.duration || 0;
  const cur = elements.audio.currentTime || 0;
  if (dur && dur - cur < 20) preloadNextTrack();
});

elements.audio.addEventListener("error", () => {
  if (!getTrack().demo) {
    elements.status.textContent = "Ese archivo no carga todavía. Comprueba nombre y carpeta.";
  }
});

elements.seek.addEventListener("input", () => {
  isSeeking = true;
  const track = getTrack();

  if (track.demo) {
    const nextTime = (Number(elements.seek.value) / 1000) * 100;
    elements.currentTime.textContent = formatTime(nextTime);
  } else {
    const duration = elements.audio.duration || 0;
    elements.currentTime.textContent = formatTime((Number(elements.seek.value) / 1000) * duration);
  }
});

elements.seek.addEventListener("change", () => {
  const track = getTrack();

  if (track.demo) {
    demoPausedAt = (Number(elements.seek.value) / 1000) * 100;
    if (isPlaying) demoStartedAt = performance.now() / 1000 - demoPausedAt;
  } else if (elements.audio.duration) {
    elements.audio.currentTime = (Number(elements.seek.value) / 1000) * elements.audio.duration;
  }

  isSeeking = false;
});

elements.volume.addEventListener("input", () => {
  const value = getVolumeValue();
  if (value > 0) { lastVolume = value; isMuted = false; }
  if (value === 0) { isMuted = true; }
  syncOutputVolume();
});

elements.mute?.addEventListener("click", () => toggleMute());

elements.shuffle.addEventListener("click", () => {
  shuffle = !shuffle;
  elements.shuffle.classList.toggle("is-active", shuffle);
});

// ------------------------------------------------------------------
// Atajos de teclado (escritorio)
// ------------------------------------------------------------------
function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    const tag = event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    switch (event.code) {
      case "Space":
        event.preventDefault();
        togglePlay();
        break;
      case "ArrowRight":
        nextTrack(true);
        break;
      case "ArrowLeft":
        previousTrack(true);
        break;
      case "ArrowUp":
        event.preventDefault();
        elements.volume.value = String(Math.min(1, getVolumeValue() + 0.05));
        lastVolume = getVolumeValue();
        syncOutputVolume();
        break;
      case "ArrowDown":
        event.preventDefault();
        elements.volume.value = String(Math.max(0, getVolumeValue() - 0.05));
        lastVolume = getVolumeValue();
        syncOutputVolume();
        break;
      case "KeyM":
        toggleMute();
        break;
      case "KeyS":
        shuffle = !shuffle;
        elements.shuffle.classList.toggle("is-active", shuffle);
        break;
    }
  });
}

// ------------------------------------------------------------------
// Service Worker
// ------------------------------------------------------------------
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Solo en https o localhost (no en file://)
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------
setupVolumeIconFallback();
boot();