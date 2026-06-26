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
  leftWave: document.getElementById("leftWave"),
  rightWave: document.getElementById("rightWave"),
  spark: document.getElementById("sparkCanvas"),
  mute: document.getElementById("muteButton"),
  volumeOnIcon: document.getElementById("volumeOnIcon"),
  volumeOffIcon: document.getElementById("volumeOffIcon"),
  volumeIconFallback: document.querySelector(".volume-control svg")
};

let currentIndex = 0;
let isPlaying = false;
let isSeeking = false;
let shuffle = false;
let hasUserSelectedTrack = false;
let audioContext;
let mediaSource;
let analyser;
let masterGain;
let dataArray;
let audioGraphConnected = false;
let mediaSourceConnected = false;
let isMuted = false;
let lastVolume = 0.82;
let visualPulse = 0;
let demoNodes = [];
let demoStartedAt = 0;
let demoPausedAt = 0;
let visualOnlyDemo = false;
let lastPointerToggleAt = 0;
let lastRenderedSecond = -1;
const metadataCache = new Map();
const sparkles = Array.from({ length: 48 }, () => createSparkle());

lastVolume = getVolumeValue() || 0.82;
elements.audio.volume = lastVolume;
elements.audio.muted = false;
setupVolumeIconFallback();
updateMuteIcon();

function boot() {
  elements.count.textContent = playlist.length;
  renderLibrary();
  loadTrack(0, false);
  hydrateAllTrackMetadata();
  draw();
  drawSparkles();
}

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

function renderLibrary() {
  elements.library.innerHTML = "";
  const fragment = document.createDocumentFragment();

  playlist.map(normalizeTrack).forEach((track, index) => {
    const button = document.createElement("button");
    button.className = "song-card";
    button.type = "button";
    button.dataset.index = index;
    button.innerHTML = `
      <img src="${track.cover}" alt="" onerror="this.src='${defaultCover}'" />
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

  if (image) image.src = track.cover;
  if (title) title.textContent = track.title;
  if (artist) artist.textContent = track.artist;
}

function selectTrack(index, autoplay) {
  hasUserSelectedTrack = true;

  if (index === currentIndex && autoplay) {
    playCurrent().catch(handlePlayError);
    return;
  }

  loadTrack(index, autoplay);
}

function loadTrack(index, autoplay) {
  currentIndex = wrapIndex(index);
  const track = getTrack();

  stopDemo();
  elements.audio.pause();
  elements.audio.removeAttribute("src");
  elements.audio.load();

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
  applyAccent(track.color);
  setActiveCards();
  renderDetails(track);

  if (!track.demo) {
    elements.audio.src = track.src;
  }

  extractPalette(track.cover, track.color);
  hydrateTrackMetadata(currentIndex);

  if (autoplay) {
    playCurrent().catch(handlePlayError);
  }
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
}

async function playCurrent() {
  const track = getTrack();

  if (track.demo) {
    try {
      await ensureAudioGraph(true);
      visualOnlyDemo = false;
    } catch {
      visualOnlyDemo = true;
      demoStartedAt = performance.now() / 1000 - demoPausedAt;
      elements.status.textContent = "Demo visual activa";
      updatePlayState(true);
      return;
    }

    startDemo();
    updatePlayState(true);
    return;
  }

  try {
    elements.audio.muted = isMuted;
    elements.audio.volume = isMuted ? 0 : getVolumeValue();

    await elements.audio.play();

    updatePlayState(true);
    elements.status.textContent = "";

    try {
      await ensureAudioGraph(false);
    } catch {
      dataArray = null;
    }
  } catch {
    handlePlayError();
  }
}

function handlePlayError() {
  elements.status.textContent = "No puedo reproducir este audio. Revisa la ruta o pulsa otra canción.";
  updatePlayState(false);
}

function pauseCurrent() {
  if (getTrack().demo) {
    pauseDemo();
  } else {
    elements.audio.pause();
  }

  updatePlayState(false);
}

async function ensureAudioGraph(isDemo) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;

  if (!AudioCtx) {
    throw new Error("AudioContext no disponible");
  }

  /*
    Si abres el proyecto como archivo local tipo file:///,
    el navegador puede bloquear el análisis real del audio.
    En ese caso dejamos que el audio se escuche normal
    y las ondas se moverán en modo visual.
  */
  if (!isDemo && window.location.protocol === "file:") {
    throw new Error("AudioContext bloqueado en file://");
  }

  if (!audioContext) {
    audioContext = new AudioCtx();

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.68;

    masterGain = audioContext.createGain();
    dataArray = new Uint8Array(analyser.frequencyBinCount);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  if (!audioGraphConnected) {
    analyser.connect(masterGain);
    masterGain.connect(audioContext.destination);
    audioGraphConnected = true;
  }

  if (!isDemo && !mediaSourceConnected) {
    if (!mediaSource) {
      mediaSource = audioContext.createMediaElementSource(elements.audio);
    }

    mediaSource.connect(analyser);
    mediaSourceConnected = true;
  }

  syncOutputVolume();
}

function startDemo() {
  stopDemo();

  const now = audioContext.currentTime;
  demoStartedAt = now - demoPausedAt;
  const base = [174, 220, 261.63, 329.63];

  demoNodes = base.map((frequency, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = index % 2 ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.detune.setValueAtTime(index * 5, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.035 / (index + 1), now + 0.45);

    oscillator.connect(gain);
    gain.connect(analyser);
    oscillator.start(now);

    return { oscillator, gain };
  });

  elements.status.textContent = "Reproduciendo demo";
}

function pauseDemo() {
  demoPausedAt = getDemoTime();
  stopDemo(false);
  visualOnlyDemo = false;
  elements.status.textContent = "Demo en pausa";
}

function stopDemo(resetTime = true) {
  demoNodes.forEach(({ oscillator, gain }) => {
    try {
      const now = audioContext ? audioContext.currentTime : 0;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0.0001, now, 0.03);
      oscillator.stop(now + 0.12);
    } catch {
      oscillator.disconnect();
    }
  });

  demoNodes = [];

  if (resetTime) {
    demoPausedAt = 0;
  }
}

function updatePlayState(nextState) {
  isPlaying = nextState;
  elements.playIcon.classList.toggle("hidden", isPlaying);
  elements.pauseIcon.classList.toggle("hidden", !isPlaying);
  elements.play.title = isPlaying ? "Pausa" : "Play";
}

function nextTrack() {
  const nextIndex = shuffle ? Math.floor(Math.random() * playlist.length) : currentIndex + 1;
  loadTrack(nextIndex, isPlaying);
}

function previousTrack() {
  loadTrack(currentIndex - 1, isPlaying);
}

function wrapIndex(index) {
  if (!playlist.length) {
    return 0;
  }

  return (index + playlist.length) % playlist.length;
}

function setActiveCards() {
  document.querySelectorAll(".song-card").forEach((card) => {
    card.classList.toggle("is-active", Number(card.dataset.index) === currentIndex);
  });
}

async function hydrateAllTrackMetadata() {
  const selectedSrc = getTrack().src;

  for (let index = 0; index < playlist.length; index += 1) {
    await waitForIdle();
    await hydrateTrackMetadata(index);
  }

  playlist.sort((a, b) => getDateScore(b) - getDateScore(a));
  renderLibrary();

  if (!hasUserSelectedTrack && !isPlaying) {
    loadTrack(0, false);
    return;
  }

  const sortedIndex = Math.max(0, playlist.findIndex((track) => track.src === selectedSrc));
  currentIndex = sortedIndex;
  setActiveCards();
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
      cover: metadata.cover || playlist[index].cover
    };

    metadataCache.set(track.src, "done");
    updateLibraryCard(index);

    if (index === currentIndex) {
      const updatedTrack = getTrack(index);
      elements.title.textContent = updatedTrack.title;
      elements.artist.textContent = updatedTrack.artist;
      elements.cover.src = updatedTrack.cover;
      renderDetails(updatedTrack);
      extractPalette(updatedTrack.cover, updatedTrack.color);
    }
  } catch {
    metadataCache.delete(track.src);
  }
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

async function readId3Metadata(src) {
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

  if (encoding === 0) {
    text = new TextDecoder("iso-8859-1").decode(content);
  } else if (encoding === 3) {
    text = new TextDecoder("utf-8").decode(content);
  } else {
    text = decodeUtf16(content, encoding === 2);
  }

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

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    littleEndian = true;
    offset = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    littleEndian = false;
    offset = 2;
  }

  const codes = [];

  for (let index = offset; index + 1 < bytes.length; index += 2) {
    codes.push(
      littleEndian
        ? bytes[index] | (bytes[index + 1] << 8)
        : (bytes[index] << 8) | bytes[index + 1]
    );
  }

  return String.fromCharCode(...codes);
}

function findEncodedTerminator(bytes, offset, encoding) {
  if (encoding === 0 || encoding === 3) {
    return findTerminator(bytes, offset, 0);
  }

  for (let index = offset; index + 1 < bytes.length; index += 2) {
    if (bytes[index] === 0 && bytes[index + 1] === 0) {
      return index;
    }
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
  return (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3];
}

function applyAccent(hex) {
  const primary = hexToRgb(hex) || [216, 167, 255];
  const secondary = rotateColor(primary);

  document.documentElement.style.setProperty("--accent", rgbToHex(primary));
  document.documentElement.style.setProperty("--accent-rgb", primary.join(", "));
  document.documentElement.style.setProperty("--accent-two", rgbToHex(secondary));
  document.documentElement.style.setProperty("--accent-two-rgb", secondary.join(", "));
}

function extractPalette(src, fallback) {
  const image = new Image();
  image.crossOrigin = "anonymous";

  image.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const size = 40;

      canvas.width = size;
      canvas.height = size;
      context.drawImage(image, 0, 0, size, size);

      const pixels = context.getImageData(0, 0, size, size).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let samples = 0;

      for (let i = 0; i < pixels.length; i += 16) {
        const alpha = pixels[i + 3];

        if (alpha < 120) continue;

        const brightness = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;

        if (brightness < 18 || brightness > 238) continue;

        r += pixels[i];
        g += pixels[i + 1];
        b += pixels[i + 2];
        samples += 1;
      }

      if (samples > 0) {
        applyAccent(rgbToHex([r / samples, g / samples, b / samples]));
      }
    } catch {
      applyAccent(fallback);
    }
  };

  image.onerror = () => applyAccent(fallback);
  image.src = src;
}

function draw() {
  requestAnimationFrame(draw);

  if (analyser && dataArray) {
    analyser.getByteFrequencyData(dataArray);

    const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length / 255;
    visualPulse = visualPulse * 0.84 + average * 0.16;
  }

  drawWave(elements.leftWave, true);
  drawWave(elements.rightWave, false);
  updateRealClock();
  updateDemoClock();
}

function drawWave(canvas, mirror) {
  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;

  if (
    canvas.width !== Math.floor(rect.width * scale)
    || canvas.height !== Math.floor(rect.height * scale)
  ) {
    canvas.width = Math.floor(rect.width * scale);
    canvas.height = Math.floor(rect.height * scale);
  }

  context.clearRect(0, 0, canvas.width, canvas.height);

  const bars = 36;
  const centerX = mirror ? canvas.width * 0.9 : canvas.width * 0.1;
  const gap = canvas.height / bars;
  const maxWidth = canvas.width * 0.82;
  const active = isPlaying;
  const time = performance.now() / 720;

  for (let i = 0; i < bars; i += 1) {
    const dataIndex = Math.min(
      dataArray ? dataArray.length - 1 : 0,
      Math.floor((i / bars) ** 1.55 * (dataArray ? dataArray.length : 1))
    );

    const fakePulse = 0.32 + Math.sin(time * 1.8 + i * 0.58) * 0.16;

    const dataValue = active && dataArray
      ? Math.max(0.035, dataArray[dataIndex] / 255 + visualPulse * 0.28)
      : active
        ? fakePulse
        : 0.22 + Math.sin(time + i * 0.58) * 0.08;

    const width = Math.max(10 * scale, maxWidth * (0.1 + dataValue * 0.9));
    const height = Math.max(3 * scale, gap * 0.36);
    const y = i * gap + gap * 0.32;
    const x = mirror ? centerX - width : centerX;
    const gradient = context.createLinearGradient(x, y, x + width, y);

    gradient.addColorStop(0, `rgba(${getCssRgb("--accent-rgb")}, ${active ? 0.9 : 0.28})`);
    gradient.addColorStop(1, `rgba(${getCssRgb("--accent-two-rgb")}, ${active ? 0.34 : 0.12})`);

    context.fillStyle = gradient;
    roundedRect(context, x, y, width, height, 999 * scale);
    context.fill();
  }
}

function drawSparkles() {
  requestAnimationFrame(drawSparkles);

  const canvas = elements.spark;
  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;

  if (
    canvas.width !== Math.floor(rect.width * scale)
    || canvas.height !== Math.floor(rect.height * scale)
  ) {
    canvas.width = Math.floor(rect.width * scale);
    canvas.height = Math.floor(rect.height * scale);
  }

  context.clearRect(0, 0, canvas.width, canvas.height);

  sparkles.forEach((sparkle) => {
    sparkle.x += sparkle.speedX;
    sparkle.y += sparkle.speedY;
    sparkle.life += sparkle.speedLife;

    if (
      sparkle.x < -20
      || sparkle.x > canvas.width + 20
      || sparkle.y < -20
      || sparkle.y > canvas.height + 20
    ) {
      Object.assign(sparkle, createSparkle(canvas.width, canvas.height));
    }

    const opacity = 0.16 + Math.abs(Math.sin(sparkle.life)) * 0.42;

    context.beginPath();
    context.arc(sparkle.x, sparkle.y, sparkle.radius * scale, 0, Math.PI * 2);
    context.fillStyle = `rgba(${getCssRgb("--accent-rgb")}, ${opacity})`;
    context.fill();
  });
}

function createSparkle(width = window.innerWidth, height = window.innerHeight) {
  const scale = window.devicePixelRatio || 1;

  return {
    x: Math.random() * width * scale,
    y: Math.random() * height * scale,
    radius: 0.7 + Math.random() * 2.3,
    speedX: (-0.18 + Math.random() * 0.36) * scale,
    speedY: (-0.22 - Math.random() * 0.26) * scale,
    life: Math.random() * Math.PI * 2,
    speedLife: 0.015 + Math.random() * 0.03
  };
}

function updateDemoClock() {
  const track = getTrack();

  if (!track.demo || !isPlaying) return;

  const duration = 100;
  const time = getDemoTime();

  if (!isSeeking) {
    elements.seek.value = String((time / duration) * 1000);
  }

  elements.currentTime.textContent = formatTime(time);
  elements.durationTime.textContent = formatTime(duration);

  if (time >= duration) {
    nextTrack();
  }
}

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

function getDemoTime() {
  if (visualOnlyDemo) {
    return performance.now() / 1000 - demoStartedAt;
  }

  if (!audioContext || !isPlaying) {
    return demoPausedAt;
  }

  return audioContext.currentTime - demoStartedAt;
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, height / 2, width / 2);

  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return "0:00";
  }

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");

  return `${mins}:${secs}`;
}

function hexToRgb(hex) {
  const clean = String(hex).trim().replace("#", "");

  if (!/^[a-f\d]{6}$/i.test(clean)) {
    return null;
  }

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

function getCssRgb(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

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

  elements.volumeIconFallback.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
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

  if (masterGain && audioContext) {
    masterGain.gain.setTargetAtTime(outputVolume, audioContext.currentTime, 0.025);
  }

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

function togglePlay() {
  if (isPlaying) {
    pauseCurrent();
  } else {
    playCurrent().catch(() => {
      elements.status.textContent = "El navegador ha bloqueado el audio por ahora.";
      updatePlayState(false);
    });
  }
}

elements.play.addEventListener("pointerup", () => {
  lastPointerToggleAt = performance.now();
  togglePlay();
});

elements.play.addEventListener("click", () => {
  if (performance.now() - lastPointerToggleAt < 350) {
    return;
  }

  togglePlay();
});

elements.previous.addEventListener("click", previousTrack);
elements.next.addEventListener("click", nextTrack);

elements.library.addEventListener("click", (event) => {
  const card = event.target.closest(".song-card");

  if (!card) return;

  selectTrack(Number(card.dataset.index), true);
});

elements.audio.addEventListener("play", () => updatePlayState(true));

elements.audio.addEventListener("pause", () => {
  if (!getTrack().demo) updatePlayState(false);
});

elements.audio.addEventListener("ended", nextTrack);

elements.audio.addEventListener("loadedmetadata", () => {
  elements.durationTime.textContent = formatTime(elements.audio.duration);
});

elements.audio.addEventListener("timeupdate", () => {
  if (isSeeking || getTrack().demo) return;

  updateRealClock(true);
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

    if (isPlaying && audioContext) {
      demoStartedAt = audioContext.currentTime - demoPausedAt;
    }
  } else if (elements.audio.duration) {
    elements.audio.currentTime = (Number(elements.seek.value) / 1000) * elements.audio.duration;
  }

  isSeeking = false;
});

elements.volume.addEventListener("input", () => {
  const value = getVolumeValue();

  if (value > 0) {
    lastVolume = value;
    isMuted = false;
  }

  if (value === 0) {
    isMuted = true;
  }

  syncOutputVolume();
});

elements.mute?.addEventListener("click", () => {
  toggleMute();
});

elements.shuffle.addEventListener("click", () => {
  shuffle = !shuffle;
  elements.shuffle.classList.toggle("is-active", shuffle);
});

boot();