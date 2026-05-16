/* WalkieR — Push-to-talk walkie talkie with Firebase */

/** Same-origin auth on Vercel (see vercel.json rewrites). Default firebaseapp.com for localhost. */
function resolveAuthDomain() {
  const host = location.hostname;
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  ) {
    return "walkier-1b600.firebaseapp.com";
  }
  return host;
}

const firebaseConfig = {
  apiKey: "AIzaSyDw-fsP8VdwRY1TX_mI-FAcxGPieU0WypA",
  authDomain: resolveAuthDomain(),
  projectId: "walkier-1b600",
  messagingSenderId: "283469627687",
  appId: "1:283469627687:web:113d60070f81525707a902",
  measurementId: "G-CE4VKGK27B",
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const firestore = firebase.firestore();
const FieldValue = firebase.firestore.FieldValue;
const MAX_AUDIO_BYTES = 750000;
const PTT_CHUNK_MS = 80;
const MAX_CHUNK_BYTES = 48000;
const VOICE_BITS_PER_SECOND = 32000;

// --- DOM ---
const joinScreen = document.getElementById("join-screen");
const mainScreen = document.getElementById("main-screen");
const joinForm = document.getElementById("join-form");
const displayNameInput = document.getElementById("display-name");
const channelIdInput = document.getElementById("channel-id");
const joinBtn = document.getElementById("join-btn");
const joinError = document.getElementById("join-error");
const leaveBtn = document.getElementById("leave-btn");
const activeChannelEl = document.getElementById("active-channel");
const connectionStatus = document.getElementById("connection-status");
const membersList = document.getElementById("members-list");
const memberCount = document.getElementById("member-count");
const pttBtn = document.getElementById("ptt-btn");
const incomingIndicator = document.getElementById("incoming-indicator");
const incomingName = document.getElementById("incoming-name");
const notifyBanner = document.getElementById("notify-banner");
const notifyBannerText = document.getElementById("notify-banner-text");
const notifyEnableBtn = document.getElementById("notify-enable-btn");
const micHint = document.getElementById("mic-hint");
const userDisplay = document.getElementById("user-display");
const lastActivity = document.getElementById("last-activity");
const playback = document.getElementById("playback");
const toastRoot = document.getElementById("toast-root");
const recentChannelsEl = document.getElementById("recent-channels");
const recentChipsEl = document.getElementById("recent-chips");
const copyChannelBtn = document.getElementById("copy-channel-btn");
const membersEmpty = document.getElementById("members-empty");
const chatMessagesEl = document.getElementById("chat-messages");
const chatEmptyEl = document.getElementById("chat-empty");
const chatThreadEl = document.getElementById("chat-thread");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send");
const chatBadge = document.getElementById("chat-badge");
const teamBadge = document.getElementById("team-badge");
const navItems = document.querySelectorAll(".nav-item");
const tabPanels = {
  radio: document.getElementById("panel-radio"),
  chat: document.getElementById("panel-chat"),
  team: document.getElementById("panel-team"),
};
const audioViz = document.getElementById("audio-viz");
const pttLabel = document.getElementById("ptt-label");
const pttSublabel = document.getElementById("ptt-sublabel");
const footerStatusDot = document.getElementById("footer-status-dot");

// --- State ---
let uid = null;
let displayName = "";
let channelId = "";
let channelDocRef = null;
let memberDocRef = null;
let messagesCollectionRef = null;
let chatCollectionRef = null;
let membersUnsubscribe = null;
let messagesUnsubscribe = null;
let chatUnsubscribe = null;
let offlineHandler = null;
let joinTimestamp = null;
let currentTab = "radio";
let unreadChatCount = 0;
let userPhotoURL = null;

let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let activeTxMessageRef = null;
let activeTxMimeType = "";
let activeTxSeq = -1;
let txChunkUploadQueue = [];
let txChunkUploadBusy = false;
const streamSessions = new Map();
const streamChunkUnsubs = new Map();
let isTransmitting = false;
let micReady = false;
const playedMessageIds = new Set();
let playbackQueue = [];
let isPlaying = false;

let swRegistration = null;
let notificationsReady = false;
let channelSilenceLoopActive = false;
let lockScreenArtworkUrl = null;
let mediaSessionHandlersReady = false;
const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

const STORAGE_KEY_NAME = "walkier_display_name";
const STORAGE_KEY_CHANNEL = "walkier_last_channel";
const STORAGE_KEY_RECENT = "walkier_recent_channels";

let audioAnalyser = null;
let audioAnalyserRaf = null;


// Restore saved values
const savedName = localStorage.getItem(STORAGE_KEY_NAME);
const savedChannel = localStorage.getItem(STORAGE_KEY_CHANNEL);
if (savedName) displayNameInput.value = savedName;
if (savedChannel) channelIdInput.value = savedChannel;
renderRecentChannels();

// --- Toasts ---
function showToast(message, type = "info") {
  if (!toastRoot) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    el.style.transition = "0.3s ease";
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

// --- Recent channels ---
function getRecentChannels() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT) || "[]");
  } catch {
    return [];
  }
}

function saveRecentChannel(id) {
  const list = getRecentChannels().filter((c) => c !== id);
  list.unshift(id);
  localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(list.slice(0, 5)));
  renderRecentChannels();
}

function renderRecentChannels() {
  if (!recentChipsEl || !recentChannelsEl) return;
  const list = getRecentChannels();
  if (!list.length) {
    recentChannelsEl.classList.add("hidden");
    return;
  }
  recentChannelsEl.classList.remove("hidden");
  recentChipsEl.innerHTML = "";
  list.forEach((ch) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = ch;
    btn.addEventListener("click", () => {
      channelIdInput.value = ch;
      updateChannelPreview();
    });
    recentChipsEl.appendChild(btn);
  });
}

function setFooterMode(mode) {
  if (!footerStatusDot) return;
  footerStatusDot.classList.remove("live", "tx", "rx");
  if (mode) footerStatusDot.classList.add(mode);
}

function setPttState(state) {
  const map = {
    idle: { label: "HOLD TO TALK", sub: "Press and hold", cls: "" },
    tx: { label: "TRANSMITTING", sub: "Release to send", cls: "transmitting" },
    rx: { label: "LISTENING", sub: "Incoming audio", cls: "" },
    off: { label: "MIC BLOCKED", sub: "Allow microphone", cls: "" },
  };
  const s = map[state] || map.idle;
  if (pttLabel) pttLabel.textContent = s.label;
  if (pttSublabel) pttSublabel.textContent = s.sub;
  pttBtn.classList.toggle("transmitting", s.cls === "transmitting");
}

function startAudioViz() {
  if (!mediaStream || !audioViz) return;
  try {
    const ctx = getPttAudioContext();
    if (!ctx) return;
    const source = ctx.createMediaStreamSource(mediaStream);
    audioAnalyser = ctx.createAnalyser();
    audioAnalyser.fftSize = 32;
    source.connect(audioAnalyser);
    const bars = audioViz.querySelectorAll("span");
    const data = new Uint8Array(audioAnalyser.frequencyBinCount);
    audioViz.classList.remove("hidden");

    const tick = () => {
      if (!isTransmitting || !audioAnalyser) {
        audioViz.classList.add("hidden");
        return;
      }
      audioAnalyser.getByteFrequencyData(data);
      bars.forEach((bar, i) => {
        const v = data[i] || 0;
        bar.style.height = `${8 + (v / 255) * 32}px`;
      });
      audioAnalyserRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    console.warn("Audio viz failed:", e);
  }
}

function stopAudioViz() {
  if (audioAnalyserRaf) cancelAnimationFrame(audioAnalyserRaf);
  audioAnalyserRaf = null;
  audioAnalyser = null;
  if (audioViz) {
    audioViz.classList.add("hidden");
    audioViz.querySelectorAll("span").forEach((b) => {
      b.style.height = "8px";
    });
  }
}

// --- Tabs & chat ---
function switchTab(tab) {
  if (!tabPanels[tab]) return;
  currentTab = tab;

  navItems.forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });

  Object.entries(tabPanels).forEach(([key, panel]) => {
    if (!panel) return;
    const active = key === tab;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });

  if (tab === "chat") {
    unreadChatCount = 0;
    updateChatBadge();
    scrollChatToBottom();
    chatInput?.focus();
  }
}

function updateChatBadge() {
  if (!chatBadge) return;
  if (unreadChatCount > 0 && currentTab !== "chat") {
    chatBadge.textContent = unreadChatCount > 9 ? "9+" : String(unreadChatCount);
    chatBadge.classList.remove("hidden");
  } else {
    chatBadge.classList.add("hidden");
  }
}

function updateTeamBadge(count) {
  if (teamBadge) teamBadge.textContent = String(count);
}

function scrollChatToBottom() {
  if (chatThreadEl) {
    requestAnimationFrame(() => {
      chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
    });
  }
}

function formatChatTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatChatDate(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function renderChatMessages(docs) {
  if (!chatMessagesEl) return;

  chatMessagesEl.innerHTML = "";
  let lastDate = "";

  docs.forEach(({ data: msg }) => {
    const ms = messageCreatedMs(msg);
    const dateLabel = formatChatDate(ms);
    if (dateLabel !== lastDate) {
      lastDate = dateLabel;
      const dateEl = document.createElement("div");
      dateEl.className = "chat-date";
      dateEl.textContent = dateLabel;
      chatMessagesEl.appendChild(dateEl);
    }

    const isOutgoing = msg.senderId === uid;
    const row = document.createElement("div");
    row.className = `chat-row ${isOutgoing ? "outgoing" : "incoming"}`;

    const initials = (msg.senderName || "?").slice(0, 2).toUpperCase();
    const avatarContent = msg.photoURL
      ? `<img src="${escapeHtml(msg.photoURL)}" alt="" />`
      : initials;

    const senderHtml =
      !isOutgoing && msg.senderName
        ? `<span class="chat-sender">${escapeHtml(msg.senderName)}</span>`
        : "";

    const bubbleHtml = `<div class="chat-bubble">${senderHtml}<p class="chat-text">${escapeHtml(msg.text || "")}</p><div class="chat-meta"><span class="chat-time">${formatChatTime(ms)}</span></div></div>`;

    row.innerHTML = isOutgoing
      ? bubbleHtml
      : `<span class="chat-avatar">${avatarContent}</span>${bubbleHtml}`;

    chatMessagesEl.appendChild(row);
  });

  if (chatEmptyEl) {
    chatEmptyEl.classList.toggle("hidden", docs.length > 0);
  }
  scrollChatToBottom();
}

async function sendChatMessage() {
  const text = (chatInput?.value || "").trim();
  if (!text || !chatCollectionRef || !uid) return;

  chatInput.value = "";
  updateChatSendState();

  try {
    await chatCollectionRef.add({
      senderId: uid,
      senderName: displayName,
      photoURL: userPhotoURL || null,
      text,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Chat send error:", err);
    showToast(firebaseErrorMessage(err), "error");
    if (chatInput) chatInput.value = text;
    updateChatSendState();
  }
}

function updateChatSendState() {
  if (!chatSendBtn || !chatInput) return;
  chatSendBtn.disabled = !chatInput.value.trim();
}

function isLanHost() {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname);
}

function isTunnelHost() {
  return location.hostname.endsWith(".loca.lt") || location.hostname.endsWith(".trycloudflare.com");
}

function isVercelHost() {
  return /\.vercel\.app$/i.test(location.hostname);
}

function isDeployedHost() {
  if (isVercelHost()) return true;
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || isLanHost() || isTunnelHost()) {
    return false;
  }
  return window.isSecureContext && location.protocol === "https:";
}

function checkMobileAccess() {
  const el = document.getElementById("mobile-warning");
  if (!el || isDeployedHost()) return;

  const onPhone = isMobileDevice();
  const lanIp = isLanHost();
  const tunnel = isTunnelHost();
  const needsHttps = onPhone && !window.isSecureContext;

  if (!onPhone && !lanIp && !tunnel && !needsHttps) return;

  const lines = [];
  if (lanIp) {
    lines.push("PC IP URLs (http://192.168.x.x) may not work on phones. Use your deployed HTTPS URL instead.");
  }
  if (needsHttps) {
    lines.push("Microphone needs HTTPS — use your deployed URL or a tunnel on your phone.");
  }
  if (tunnel) {
    lines.push(
      "Firebase → Authentication → Authorized domains must include this host (tap to copy):"
    );
    lines.push(`<code class="domain-copy">${location.hostname}</code>`);
    lines.push("Complete the localtunnel password page before using the app.");
  }

  if (lines.length === 0) return;

  el.innerHTML =
    "<strong>Mobile setup</strong>" +
    lines.map((l) => `<span>${l}</span>`).join("");
  el.classList.remove("hidden");
  document.body.classList.add("has-mobile-warning");

  const code = el.querySelector(".domain-copy");
  if (code) {
    code.title = "Tap to copy";
    code.addEventListener("click", () => {
      navigator.clipboard.writeText(location.hostname).catch(() => {});
    });
  }
}

// --- Helpers ---
function showError(el, message) {
  el.textContent = message;
  el.classList.remove("hidden");
}

function hideError(el) {
  el.classList.add("hidden");
  el.textContent = "";
}

function setConnectionState(state, text) {
  connectionStatus.classList.remove("connected", "error");
  if (state === "connected") connectionStatus.classList.add("connected");
  if (state === "error") connectionStatus.classList.add("error");
  connectionStatus.querySelector(".status-text").textContent = text;
}

function setActivity(text) {
  lastActivity.textContent = text;
  if (/transmit/i.test(text)) setFooterMode("tx");
  else if (/listen/i.test(text)) setFooterMode("rx");
  else if (/sent|ready/i.test(text)) setFooterMode("live");
  else if (/mic|block/i.test(text)) setFooterMode("");
}

function sanitizeChannel(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
}

function firebaseErrorMessage(err) {
  const code = err && err.code;
  if (code === "permission-denied") {
    return "Firestore permission denied. Enable Firestore and deploy firestore.rules.";
  }
  if (code === "unavailable" || code === "failed-precondition") {
    return "Firestore is unavailable. Enable it in Firebase Console.";
  }
  if (code === "auth/requires-recent-login") {
    return "Please sign out and sign in again, then retry.";
  }
  return (err && err.message) || "Could not create or join the channel.";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      resolve(typeof result === "string" ? result.split(",")[1] : "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const playbackObjectUrls = new Set();

function revokePlaybackObjectUrl(url) {
  if (!url || !playbackObjectUrls.has(url)) return;
  URL.revokeObjectURL(url);
  playbackObjectUrls.delete(url);
}

function getMessageAudioSrc(msg) {
  if (msg.audioUrl) return msg.audioUrl;
  if (msg._audioBlob) {
    const url = URL.createObjectURL(msg._audioBlob);
    playbackObjectUrls.add(url);
    return url;
  }
  if (!msg.audioBase64) return null;
  const mime = msg.mimeType || "audio/webm";
  try {
    const binary = atob(msg.audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    playbackObjectUrls.add(url);
    return url;
  } catch (err) {
    console.warn("Blob URL playback fallback:", err);
    return `data:${mime};base64,${msg.audioBase64}`;
  }
}

function messageCreatedMs(msg) {
  const t = msg.createdAt;
  if (!t) return 0;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t === "number") return t;
  return 0;
}

function setJoinLoading(loading) {
  joinBtn.disabled = loading || !auth.currentUser;
  joinBtn.querySelector(".btn-label").classList.toggle("hidden", loading);
  joinBtn.querySelector(".btn-spinner").classList.toggle("hidden", !loading);
}

function updateChannelPreview() {
  const preview = document.getElementById("channel-preview");
  if (!preview) return;
  const id = sanitizeChannel(channelIdInput.value);
  preview.textContent = id
    ? `Channel ID: ${id}`
    : "Enter a name — spaces become dashes (e.g. Team Alpha → team-alpha)";
  preview.classList.toggle("invalid", channelIdInput.value.trim().length > 0 && !id);
}

function getMimeType() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const types = ios
    ? ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function vibrate(ms) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// --- Walkie-talkie PTT sounds (Web Audio API) ---
let pttAudioCtx = null;

function getPttAudioContext() {
  if (!pttAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    pttAudioCtx = new Ctx();
  }
  if (pttAudioCtx.state === "suspended") {
    pttAudioCtx.resume();
  }
  return pttAudioCtx;
}

function playTone(ctx, { startFreq, endFreq, duration, type, peakGain, startAt }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || "sine";
  osc.frequency.setValueAtTime(startFreq, startAt);
  if (endFreq !== startFreq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), startAt + duration);
  }
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/** Short rising chirp — "channel open", ready to talk */
function playPttStartSound() {
  try {
    const ctx = getPttAudioContext();
    if (!ctx) return;
    const t = ctx.currentTime;
    playTone(ctx, {
      startFreq: 520,
      endFreq: 1180,
      duration: 0.09,
      type: "sine",
      peakGain: 0.22,
      startAt: t,
    });
    playTone(ctx, {
      startFreq: 780,
      endFreq: 1450,
      duration: 0.07,
      type: "triangle",
      peakGain: 0.1,
      startAt: t + 0.055,
    });
  } catch (e) {
    console.warn("PTT start sound failed:", e);
  }
}

/** Lower falling tone — "over" / release */
function playPttEndSound() {
  try {
    const ctx = getPttAudioContext();
    if (!ctx) return;
    const t = ctx.currentTime;
    playTone(ctx, {
      startFreq: 920,
      endFreq: 380,
      duration: 0.11,
      type: "sine",
      peakGain: 0.2,
      startAt: t,
    });
    playTone(ctx, {
      startFreq: 640,
      endFreq: 280,
      duration: 0.08,
      type: "triangle",
      peakGain: 0.08,
      startAt: t + 0.07,
    });
  } catch (e) {
    console.warn("PTT end sound failed:", e);
  }
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
}

function isIOS() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isStandalonePwa() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function isReceivingAudio() {
  if (isPlaying) return true;
  for (const session of streamSessions.values()) {
    if (session.playing || session.mseStarted) return true;
  }
  return playbackQueue.length > 0;
}

function defaultDisplayName(user) {
  if (user.displayName) return user.displayName.trim().slice(0, 24);
  if (user.email) return user.email.split("@")[0].slice(0, 24);
  return "User";
}

function setJoinReady(ready) {
  joinBtn.disabled = !ready;
}

function authErrorMessage(err) {
  const code = err && err.code;
  if (code === "auth/operation-not-allowed") {
    return "Anonymous sign-in is disabled. Enable Anonymous in Firebase → Authentication → Sign-in method.";
  }
  return (err && err.message) || "Could not connect. Try again.";
}

// --- Screens ---
function showScreen(screen) {
  joinScreen.classList.toggle("active", screen === "join");
  mainScreen.classList.toggle("active", screen === "main");
}

// --- Microphone ---
async function initMicrophone() {
  if (mediaStream) return true;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    micReady = true;
    micHint.classList.add("hidden");
    pttBtn.disabled = false;
    setPttState("idle");
    setFooterMode("live");
    getPttAudioContext();
    showToast("Microphone ready", "success");
    return true;
  } catch (err) {
    console.error("Microphone error:", err);
    micReady = false;
    micHint.classList.remove("hidden");
    pttBtn.disabled = true;
    setPttState("off");
    setActivity("Mic blocked");
    return false;
  }
}

function queueTxChunkUpload(blob) {
  if (!activeTxMessageRef || blob.size < 1) return;
  txChunkUploadQueue.push(blob);
  drainTxChunkUploads();
}

async function drainTxChunkUploads() {
  if (txChunkUploadBusy || !activeTxMessageRef) return;
  txChunkUploadBusy = true;
  while (txChunkUploadQueue.length > 0 && activeTxMessageRef) {
    const blob = txChunkUploadQueue.shift();
    try {
      await uploadTxChunk(blob);
    } catch (err) {
      console.warn("Chunk upload failed:", err);
    }
  }
  txChunkUploadBusy = false;
}

async function uploadTxChunk(blob) {
  if (!activeTxMessageRef || blob.size > MAX_CHUNK_BYTES) return;
  const seq = ++activeTxSeq;
  const buf = await blob.arrayBuffer();
  const audioBase64 = bytesToBase64(new Uint8Array(buf));
  const ref = activeTxMessageRef;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ref
        .collection("chunks")
        .doc(String(seq).padStart(4, "0"))
        .set({ seq, audioBase64, size: blob.size });
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
    }
  }
}

function mseCodecForMime(mimeType) {
  const base = (mimeType || "audio/webm").split(";")[0].trim();
  if (base === "audio/webm") return 'audio/webm; codecs="opus"';
  if (base === "audio/mp4") return 'audio/mp4; codecs="mp4a.40.2"';
  return mimeType || base;
}

function canStreamPlaybackMse(mimeType) {
  if (isIOS()) return false;
  if (!window.MediaSource) return false;
  try {
    return MediaSource.isTypeSupported(mseCodecForMime(mimeType));
  } catch {
    return false;
  }
}

function mergeStreamChunks(session) {
  const count = session.msg.chunkCount || session.chunks.size;
  if (!count) return null;
  const parts = [];
  for (let i = 0; i < count; i++) {
    const bytes = session.chunks.get(i);
    if (!bytes) return null;
    parts.push(bytes);
  }
  return new Blob(parts, { type: session.mimeType || "audio/webm" });
}

function cleanupStreamSession(messageId) {
  const unsub = streamChunkUnsubs.get(messageId);
  if (unsub) unsub();
  streamChunkUnsubs.delete(messageId);
  const session = streamSessions.get(messageId);
  if (session?.mseUrl) revokePlaybackObjectUrl(session.mseUrl);
  streamSessions.delete(messageId);
}

function cleanupAllStreamSessions() {
  streamChunkUnsubs.forEach((unsub) => unsub());
  streamChunkUnsubs.clear();
  streamSessions.forEach((_, id) => cleanupStreamSession(id));
}

function ensureStreamSession(messageId, msg) {
  let session = streamSessions.get(messageId);
  if (!session) {
    session = {
      msg,
      mimeType: msg.mimeType || "audio/webm",
      chunks: new Map(),
      ended: msg.streaming === false,
      playing: false,
      mseStarted: false,
      mseFailed: false,
      mseAppendedSeqs: new Set(),
      pendingMse: [],
      mseAppending: false,
      eosCalled: false,
    };
    streamSessions.set(messageId, session);
  } else {
    session.msg = msg;
    if (msg.streaming === false) session.ended = true;
  }
  return session;
}

function subscribeStreamChunks(messageId) {
  if (streamChunkUnsubs.has(messageId) || !messagesCollectionRef) return;
  const unsub = messagesCollectionRef
    .doc(messageId)
    .collection("chunks")
    .orderBy("seq", "asc")
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "added") return;
        onStreamChunk(messageId, change.doc.data());
      });
    });
  streamChunkUnsubs.set(messageId, unsub);
}

function queueMseChunk(session, seq, bytes) {
  if (session.mseAppendedSeqs.has(seq)) return;
  session.mseAppendedSeqs.add(seq);
  session.pendingMse.push(bytes);
  flushMsePending(session);
}

function maybeFinalizeMseStream(session) {
  if (!session.ended || session.eosCalled || session.mseFailed) return;
  const count = session.msg.chunkCount || 0;
  if (count < 1) return;
  for (let i = 0; i < count; i++) {
    if (!session.chunks.has(i) || !session.mseAppendedSeqs.has(i)) return;
  }
  if (
    session.pendingMse.length > 0 ||
    session.mseAppending ||
    session.sourceBuffer?.updating
  ) {
    return;
  }
  session.eosCalled = true;
  try {
    if (session.mediaSource?.readyState === "open") {
      session.mediaSource.endOfStream();
    }
  } catch (_) {}
}

function flushMsePending(session) {
  if (
    !session.sourceBuffer ||
    session.mseAppending ||
    session.mseFailed ||
    session.pendingMse.length === 0 ||
    session.sourceBuffer.updating
  ) {
    maybeFinalizeMseStream(session);
    return;
  }
  session.mseAppending = true;
  const bytes = session.pendingMse.shift();
  try {
    session.sourceBuffer.appendBuffer(bytes);
  } catch (err) {
    console.warn("MSE append failed:", err);
    session.mseAppending = false;
    session.mseFailed = true;
    return;
  }
  session.sourceBuffer.addEventListener(
    "updateend",
    () => {
      session.mseAppending = false;
      flushMsePending(session);
      maybeFinalizeMseStream(session);
    },
    { once: true }
  );
}

async function startMseStreamPlayback(session, messageId) {
  if (session.mseStarted || session.mseFailed) return;
  session.mseStarted = true;
  session.playing = true;
  playedMessageIds.add(messageId);

  const codec = mseCodecForMime(session.mimeType);
  const mediaSource = new MediaSource();
  session.mediaSource = mediaSource;
  session.mseUrl = URL.createObjectURL(mediaSource);
  playbackObjectUrls.add(session.mseUrl);

  channelSilenceLoopActive = false;
  playback.loop = false;
  playback.pause();
  playback.src = session.mseUrl;
  playback.volume = 1;

  incomingName.textContent = session.msg.senderName || "Someone";
  incomingIndicator.classList.remove("hidden");
  setPttState("rx");
  setActivity(`Live · ${session.msg.senderName}`);
  updateChannelMediaMetadata(session.msg);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("MSE timeout")), 4000);
    mediaSource.addEventListener(
      "sourceopen",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
    mediaSource.addEventListener(
      "error",
      () => {
        clearTimeout(t);
        reject(new Error("MSE error"));
      },
      { once: true }
    );
  });

  session.sourceBuffer = mediaSource.addSourceBuffer(codec);
  session.sourceBuffer.mode = "sequence";

  const ordered = [...session.chunks.keys()].sort((a, b) => a - b);
  for (const seq of ordered) {
    queueMseChunk(session, seq, session.chunks.get(seq));
  }
  isPlaying = true;
  const onMsePlaybackEnd = () => {
    playback.removeEventListener("ended", onMsePlaybackEnd);
    if (!streamSessions.has(messageId)) return;
    cleanupStreamSession(messageId);
    isPlaying = false;
    incomingIndicator.classList.add("hidden");
    restoreChannelMediaSession().catch(() => {});
    if (!isTransmitting) {
      setPttState("idle");
      setActivity("Ready");
    }
  };
  playback.addEventListener("ended", onMsePlaybackEnd);
  await playback.play();
  notifyIncomingAudio(session.msg);
  vibrate(40);
}

function onStreamChunk(messageId, chunk) {
  if (playedMessageIds.has(messageId) && !streamSessions.get(messageId)?.mseStarted) return;
  const session = streamSessions.get(messageId);
  if (!session || session.chunks.has(chunk.seq)) return;

  session.chunks.set(chunk.seq, base64ToBytes(chunk.audioBase64));

  if (!session.playing && canStreamPlaybackMse(session.mimeType)) {
    const ready = session.chunks.has(0) && (session.chunks.size >= 2 || session.ended);
    if (ready) {
      startMseStreamPlayback(session, messageId).catch(() => {
        session.mseFailed = true;
        playedMessageIds.delete(messageId);
        teardownMsePlayback(session);
        tryCompleteStreamPlayback(messageId);
      });
      return;
    }
  }

  if (session.mseStarted && session.sourceBuffer && !session.mseFailed) {
    queueMseChunk(session, chunk.seq, session.chunks.get(chunk.seq));
  }

  tryCompleteStreamPlayback(messageId);
}

function teardownMsePlayback(session) {
  if (!session) return;
  try {
    playback.pause();
    playback.loop = false;
    playback.removeAttribute("src");
    playback.load();
  } catch (_) {}
  if (session.mseUrl) revokePlaybackObjectUrl(session.mseUrl);
  session.mseUrl = null;
  session.mediaSource = null;
  session.sourceBuffer = null;
  session.mseStarted = false;
  session.playing = false;
  session.pendingMse = [];
  session.mseAppending = false;
}

function tryCompleteStreamPlayback(messageId) {
  const session = streamSessions.get(messageId);
  if (!session || !session.ended) return;

  const count = session.msg.chunkCount || 0;
  if (count < 1) return;
  for (let i = 0; i < count; i++) {
    if (!session.chunks.has(i)) return;
  }

  if (session.mseStarted && !session.mseFailed) {
    for (let i = 0; i < count; i++) {
      if (!session.chunks.has(i)) return;
      queueMseChunk(session, i, session.chunks.get(i));
    }
    maybeFinalizeMseStream(session);
    return;
  }

  if (session.mseFailed) {
    playedMessageIds.delete(messageId);
    teardownMsePlayback(session);
  }

  if (playedMessageIds.has(messageId)) return;

  const blob = mergeStreamChunks(session);
  if (!blob) return;

  playedMessageIds.add(messageId);
  const msg = { ...session.msg, _audioBlob: blob };
  cleanupStreamSession(messageId);
  enqueuePlayback(msg);
  vibrate(40);
}

function handleStreamingMessage(messageId, msg) {
  if (playedMessageIds.has(messageId)) return;
  ensureStreamSession(messageId, msg);
  subscribeStreamChunks(messageId);
  if (msg.streaming === true && !isReceivingAudio()) {
    incomingIndicator.classList.remove("hidden");
    incomingName.textContent = msg.senderName || "Someone";
    setPttState("rx");
    setActivity(`Receiving ${msg.senderName || "Someone"}…`);
  }
  if (msg.streaming === false) {
    tryCompleteStreamPlayback(messageId);
  }
}

async function startRecording() {
  if (!mediaStream || isTransmitting || !messagesCollectionRef) return;
  const mimeType = getMimeType();
  const recorderOpts = mimeType
    ? { mimeType, audioBitsPerSecond: VOICE_BITS_PER_SECOND }
    : { audioBitsPerSecond: VOICE_BITS_PER_SECOND };

  recordedChunks = [];
  activeTxSeq = -1;
  activeTxMimeType = mimeType || "audio/webm";
  activeTxMessageRef = messagesCollectionRef.doc();
  txChunkUploadQueue = [];

  try {
    await activeTxMessageRef.set({
      senderId: uid,
      senderName: displayName,
      mimeType: activeTxMimeType,
      streaming: true,
      chunkCount: 0,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Stream start failed:", err);
    activeTxMessageRef = null;
    showToast("Could not start transmission", "error");
    return;
  }

  try {
    mediaRecorder = new MediaRecorder(mediaStream, recorderOpts);
  } catch (e) {
    try {
      mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    } catch {
      mediaRecorder = new MediaRecorder(mediaStream);
    }
  }
  activeTxMimeType = mediaRecorder.mimeType || activeTxMimeType;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
      queueTxChunkUpload(e.data);
    }
  };

  mediaRecorder.start(PTT_CHUNK_MS);
  isTransmitting = true;
  if (channelSilenceLoopActive && playback) playback.pause();
  setPttState("tx");
  setActivity("Live…");
  playPttStartSound();
  startAudioViz();
  vibrate(30);

  if (memberDocRef) {
    memberDocRef.update({ talking: true, talkingAt: FieldValue.serverTimestamp() });
  }
}

async function stopRecordingAndSend() {
  if (!isTransmitting || !mediaRecorder) return;

  isTransmitting = false;
  setPttState("idle");
  stopAudioViz();
  playPttEndSound();
  if (channelDocRef && !isReceivingAudio()) {
    startChannelSilenceLoop().catch(() => {});
  }

  if (memberDocRef) {
    memberDocRef.update({ talking: false, talkingAt: null });
  }

  const recorder = mediaRecorder;
  mediaRecorder = null;

  await new Promise((resolve) => {
    recorder.onstop = resolve;
    if (recorder.state !== "inactive") recorder.stop();
    else resolve();
  });

  const mimeType = recorder.mimeType || activeTxMimeType || "audio/webm";
  const txRef = activeTxMessageRef;
  activeTxMessageRef = null;

  await drainTxChunkUploads();

  const chunkCount = activeTxSeq + 1;
  activeTxSeq = -1;

  if (chunkCount > 0 && txRef) {
    try {
      await txRef.update({ streaming: false, chunkCount });
      setActivity("Sent");
      vibrate(20);
    } catch (err) {
      console.error("Finalize stream failed:", err);
      showToast("Send failed — try again", "error");
    }
  } else if (txRef) {
    txRef.delete().catch(() => {});
  }

  if (chunkCount === 0 && recordedChunks.length > 0) {
    const blob = new Blob(recordedChunks, { type: mimeType });
    if (blob.size < 500) {
      setActivity("Too short — hold longer");
      vibrate([50, 50]);
    } else {
      setActivity("Sending…");
      try {
        await uploadAndBroadcast(blob, mimeType);
        setActivity("Sent");
        vibrate(20);
      } catch (err) {
        console.error("Upload failed:", err);
        showToast(firebaseErrorMessage(err), "error");
      }
    }
  } else {
    setActivity("Ready");
  }

  recordedChunks = [];
  setTimeout(() => {
    if (!isTransmitting && !isPlaying) setActivity("Ready");
  }, 800);
}

async function uploadAndBroadcast(blob, mimeType) {
  if (blob.size > MAX_AUDIO_BYTES) {
    throw new Error("Message too long. Hold the button for a shorter clip.");
  }

  const audioBase64 = await blobToBase64(blob);
  await messagesCollectionRef.add({
    senderId: uid,
    senderName: displayName,
    mimeType,
    audioBase64,
    size: blob.size,
    createdAt: FieldValue.serverTimestamp(),
  });
}

// --- Mobile notifications & background audio ---
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register("/sw.js");
    return swRegistration;
  } catch (err) {
    console.warn("Service worker registration failed:", err);
    return null;
  }
}

async function ensureNotificationPermission() {
  if (!("Notification" in window)) {
    showToast("Notifications are not supported in this browser", "info");
    return false;
  }
  if (Notification.permission === "granted") {
    notificationsReady = true;
    updateNotifyBanner();
    return true;
  }
  if (Notification.permission === "denied") {
    updateNotifyBanner();
    return false;
  }
  try {
    await registerServiceWorker();
    const permission = await Notification.requestPermission();
    notificationsReady = permission === "granted";
    updateNotifyBanner();
    return notificationsReady;
  } catch {
    updateNotifyBanner();
    return false;
  }
}

function updateNotifyBanner() {
  if (!notifyBanner) return;
  const onChannel = Boolean(channelDocRef);
  const supported = "Notification" in window;
  const permission = supported ? Notification.permission : "denied";

  if (!onChannel || !supported || permission === "granted") {
    notifyBanner.classList.add("hidden");
    return;
  }

  if (notifyBannerText) {
    if (permission === "denied") {
      notifyBannerText.textContent = isIOS()
        ? "Notifications blocked. Open Settings → WalkieR → Notifications to allow alerts."
        : "Notifications are blocked in browser settings.";
    } else if (isIOS() && !isStandalonePwa()) {
      notifyBannerText.textContent =
        "On iPhone: Share → Add to Home Screen, open WalkieR from the icon, then tap Enable alerts.";
    } else {
      notifyBannerText.textContent = "Tap Enable alerts to hear when someone talks while the app is in the background.";
    }
  }

  if (notifyEnableBtn) {
    notifyEnableBtn.classList.toggle("hidden", permission === "denied");
  }

  notifyBanner.classList.remove("hidden");
}

function requestNotificationsFromUserGesture() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  Notification.requestPermission().then((permission) => {
    notificationsReady = permission === "granted";
    updateNotifyBanner();
    if (permission === "granted") {
      showToast("Notifications enabled", "success");
    }
  });
}

async function enableNotificationsFromButton() {
  const granted = await ensureNotificationPermission();
  if (granted) {
    showToast("Notifications enabled for voice alerts", "success");
  } else if (Notification.permission === "denied") {
    showToast("Enable notifications in system Settings", "info");
  }
}

function shouldNotifyForIncoming() {
  return document.hidden || !document.hasFocus();
}

async function notifyIncomingAudio(message) {
  if (!notificationsReady || !shouldNotifyForIncoming()) return;

  const sender = message.senderName || "Someone";
  const title = `${sender} · voice message`;
  const body = channelId ? `Channel ${channelId}` : "WalkieR";
  const tag = `walkier-${channelId || "audio"}`;

  try {
    if (swRegistration && swRegistration.active) {
      swRegistration.active.postMessage({
        type: "walkier-notify",
        title,
        body,
        tag,
      });
      return;
    }
    if (swRegistration && "showNotification" in swRegistration) {
      await swRegistration.showNotification(title, {
        body,
        tag,
        renotify: true,
        vibrate: [120, 60, 120],
      });
      return;
    }
    new Notification(title, { body, tag, renotify: true });
  } catch (err) {
    console.warn("Notification failed:", err);
  }
}

function getLockScreenArtwork() {
  if (lockScreenArtworkUrl) return lockScreenArtworkUrl;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 512, 512);
    g.addColorStop(0, "#34d399");
    g.addColorStop(1, "#059669");
    ctx.fillStyle = g;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(0, 0, 512, 512, 112);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, 512, 512);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.arc(256, 256, 160, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillRect(236, 160, 40, 100);
    ctx.fillRect(196, 248, 120, 48);
    lockScreenArtworkUrl = canvas.toDataURL("image/png");
  } catch {
    lockScreenArtworkUrl = "/icons/icon.svg";
  }
  return lockScreenArtworkUrl;
}

function setupMediaSessionHandlers() {
  if (!("mediaSession" in navigator) || mediaSessionHandlersReady) return;
  try {
    navigator.mediaSession.setActionHandler("play", async () => {
      await resumeAudioSession();
      if (channelDocRef && !isReceivingAudio()) {
        await startChannelSilenceLoop();
      } else if (playback.src && playback.paused) {
        await playback.play();
      }
      navigator.mediaSession.playbackState = "playing";
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      if (playback && !playback.paused) playback.pause();
      navigator.mediaSession.playbackState = "paused";
    });
    mediaSessionHandlersReady = true;
  } catch (err) {
    console.warn("Media session handlers failed:", err);
  }
}

function updateChannelMediaMetadata(message) {
  if (!("mediaSession" in navigator)) return;
  const artwork = [
    { src: getLockScreenArtwork(), sizes: "512x512", type: "image/png" },
    { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
  ];
  try {
    if (message) {
      const sender = message.senderName || "Someone";
      navigator.mediaSession.metadata = new MediaMetadata({
        title: sender,
        artist: channelId ? `WalkieR · ${channelId}` : "WalkieR",
        album: "Voice message",
        artwork,
      });
    } else {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: channelId ? `#${channelId}` : "WalkieR",
        artist: "WalkieR — Live channel",
        album: displayName ? `You: ${displayName}` : "Push-to-talk radio",
        artwork,
      });
    }
    navigator.mediaSession.playbackState = "playing";
  } catch (err) {
    console.warn("Media session metadata failed:", err);
  }
}

function updateMediaPositionFromPlayback() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const duration = playback.duration;
  if (!duration || !Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: playback.playbackRate || 1,
      position: Math.min(playback.currentTime, duration),
    });
  } catch (err) {
    console.warn("Media position state failed:", err);
  }
}

function clearMediaSession() {
  if (!("mediaSession" in navigator)) return;
  stopChannelSilenceLoop(true);
  try {
    navigator.mediaSession.playbackState = "none";
    navigator.mediaSession.metadata = null;
    if (navigator.mediaSession.setPositionState) {
      navigator.mediaSession.setPositionState({
        duration: 0,
        playbackRate: 1,
        position: 0,
      });
    }
  } catch (err) {
    console.warn("Media session clear failed:", err);
  }
}

async function resumeAudioSession() {
  const ctx = getPttAudioContext();
  if (ctx && ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (err) {
      console.warn("AudioContext resume failed:", err);
    }
  }
}

async function startChannelSilenceLoop() {
  if (!playback || channelSilenceLoopActive || isReceivingAudio()) return;
  try {
    playback.loop = true;
    playback.src = SILENT_WAV;
    playback.volume = 0.01;
    playback.setAttribute("playsinline", "");
    playback.setAttribute("webkit-playsinline", "");
    await waitForPlaybackReady(playback);
    await playback.play();
    channelSilenceLoopActive = true;
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = "playing";
    }
  } catch (err) {
    console.warn("Channel silence loop failed:", err);
    channelSilenceLoopActive = false;
  }
}

function stopChannelSilenceLoop(force = false) {
  channelSilenceLoopActive = false;
  if (!playback || (isPlaying && !force)) return;
  try {
    playback.pause();
    playback.loop = false;
    playback.removeAttribute("src");
    playback.load();
    playback.volume = 1;
  } catch (err) {
    console.warn("Stop channel silence failed:", err);
  }
}

async function restoreChannelMediaSession() {
  if (!channelDocRef) return;
  updateChannelMediaMetadata(null);
  await startChannelSilenceLoop();
}

async function prepareMobileChannelAudio() {
  if (playback) {
    playback.setAttribute("playsinline", "");
    playback.setAttribute("webkit-playsinline", "");
  }
  await registerServiceWorker();
  if (Notification.permission === "granted") {
    notificationsReady = true;
  }
  setupMediaSessionHandlers();
  await resumeAudioSession();
  updateChannelMediaMetadata(null);
  await startChannelSilenceLoop();
}

function waitForPlaybackReady(el) {
  return new Promise((resolve) => {
    if (el.readyState >= 2) {
      resolve();
      return;
    }
    const done = () => {
      el.removeEventListener("canplay", done);
      el.removeEventListener("loadeddata", done);
      el.removeEventListener("error", done);
      resolve();
    };
    el.addEventListener("canplay", done, { once: true });
    el.addEventListener("loadeddata", done, { once: true });
    el.addEventListener("error", done, { once: true });
    setTimeout(done, 4000);
  });
}

async function unlockPlaybackElement() {
  if (!playback) return;
  try {
    await startChannelSilenceLoop();
    stopChannelSilenceLoop();
    playback.volume = 1;
  } catch (err) {
    console.warn("Playback unlock failed:", err);
  }
}

async function playMessageAudio(src, message) {
  stopChannelSilenceLoop(true);
  channelSilenceLoopActive = false;
  playback.loop = false;
  playback.pause();
  playback.src = src;
  playback.volume = 1;
  await waitForPlaybackReady(playback);
  updateChannelMediaMetadata(message);

  const onTimeUpdate = () => updateMediaPositionFromPlayback();
  playback.addEventListener("timeupdate", onTimeUpdate);

  await playback.play();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = "playing";
  }
  updateMediaPositionFromPlayback();

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      playback.removeEventListener("timeupdate", onTimeUpdate);
      playback.onended = null;
      playback.onerror = null;
      resolve();
    };
    playback.onended = finish;
    playback.onerror = () => {
      const d = playback.duration;
      if (!d || !Number.isFinite(d) || playback.currentTime >= d - 0.2) {
        finish();
      } else {
        console.warn("Playback interrupted:", playback.error);
      }
    };
    setTimeout(finish, 90000);
  });
}

/** Non-blocking; must not fail channel join. */
function prepareMobileChannelAudioSafe() {
  prepareMobileChannelAudio().catch((err) => {
    console.warn("Mobile audio prep failed:", err);
  });
}

function promptNotificationsAfterJoin() {
  updateNotifyBanner();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && channelDocRef) {
    resumeAudioSession();
    if (!isReceivingAudio() && !channelSilenceLoopActive) {
      startChannelSilenceLoop();
    }
    if (playbackQueue.length > 0) processPlaybackQueue();
  }
});

// --- Playback queue ---
function enqueuePlayback(message) {
  notifyIncomingAudio(message);
  playbackQueue.push(message);
  processPlaybackQueue();
}

async function processPlaybackQueue() {
  if (isPlaying || playbackQueue.length === 0) return;
  isPlaying = true;

  const msg = playbackQueue.shift();
  incomingName.textContent = msg.senderName || "Someone";
  incomingIndicator.classList.remove("hidden");
  setPttState("rx");
  setActivity(`Listening to ${msg.senderName}`);
  updateChannelMediaMetadata(msg);

  let src = null;
  try {
    await resumeAudioSession();
    src = getMessageAudioSrc(msg);
    if (!src) {
      console.warn("Message has no playable audio");
    } else {
      await playMessageAudio(src, msg);
    }
  } catch (e) {
    console.warn("Playback failed:", e);
  } finally {
    revokePlaybackObjectUrl(src);
    incomingIndicator.classList.add("hidden");
    isPlaying = false;

    if (playbackQueue.length > 0) {
      processPlaybackQueue();
    } else {
      await restoreChannelMediaSession();
      if (!isTransmitting) {
        setPttState("idle");
        setActivity("Ready");
      }
    }
  }
}

// --- Firebase channel ---
async function joinChannel(name, channel) {
  hideError(joinError);
  setJoinLoading(true);

  try {
    displayName = name.trim().slice(0, 24);
    channelId = sanitizeChannel(channel);
    if (!displayName) {
      throw new Error("Enter your display name.");
    }
    if (!channelId) {
      throw new Error("Enter a channel name (letters and numbers).");
    }
    if (channelId.length < 2) {
      throw new Error("Channel name must be at least 2 characters.");
    }

    const user = auth.currentUser;
    if (!user) {
      throw new Error("Connecting… try again in a moment.");
    }
    uid = user.uid;

    localStorage.setItem(STORAGE_KEY_NAME, displayName);
    localStorage.setItem(STORAGE_KEY_CHANNEL, channelId);
    channelIdInput.value = channelId;

    channelDocRef = firestore.collection("channels").doc(channelId);
    memberDocRef = channelDocRef.collection("members").doc(uid);
    messagesCollectionRef = channelDocRef.collection("messages");
    chatCollectionRef = channelDocRef.collection("chat");
    userPhotoURL = user.photoURL || null;

    const channelSnap = await channelDocRef.get();
    if (!channelSnap.exists) {
      await channelDocRef.set({
        name: channelId,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    await memberDocRef.set({
      name: displayName,
      email: user.email || null,
      photoURL: user.photoURL || null,
      joinedAt: FieldValue.serverTimestamp(),
      talking: false,
      online: true,
    });

    offlineHandler = () => {
      memberDocRef.update({
        online: false,
        talking: false,
        leftAt: FieldValue.serverTimestamp(),
      });
    };
    window.addEventListener("pagehide", offlineHandler);

    joinTimestamp = Date.now();
    setupListeners();
    await initMicrophone();
    await unlockPlaybackElement();

    saveRecentChannel(channelId);
    activeChannelEl.textContent = channelId;
    userDisplay.textContent = displayName;
    setConnectionState("connected", "Live");
    setFooterMode("live");
    setPttState("idle");
    if (copyChannelBtn) copyChannelBtn.disabled = false;
    switchTab("radio");
    unreadChatCount = 0;
    updateChatBadge();
    showScreen("main");
    showToast(`Joined #${channelId}`, "success");
    prepareMobileChannelAudioSafe();
    promptNotificationsAfterJoin();
    updateNotifyBanner();
  } catch (err) {
    console.error("Join channel error:", err);
    showError(joinError, firebaseErrorMessage(err));
    setConnectionState("error", "Offline");
    teardownChannelRefs();
  } finally {
    setJoinLoading(false);
  }
}

function teardownChannelRefs() {
  if (membersUnsubscribe) membersUnsubscribe();
  if (messagesUnsubscribe) messagesUnsubscribe();
  if (chatUnsubscribe) chatUnsubscribe();
  if (offlineHandler) window.removeEventListener("pagehide", offlineHandler);

  membersUnsubscribe = null;
  messagesUnsubscribe = null;
  chatUnsubscribe = null;
  offlineHandler = null;
  channelDocRef = null;
  memberDocRef = null;
  messagesCollectionRef = null;
  chatCollectionRef = null;
  joinTimestamp = null;
  cleanupAllStreamSessions();
  unreadChatCount = 0;
  updateChatBadge();
  if (chatMessagesEl) chatMessagesEl.innerHTML = "";
  if (chatEmptyEl) chatEmptyEl.classList.remove("hidden");
}

function setupListeners() {
  if (membersUnsubscribe) membersUnsubscribe();
  if (messagesUnsubscribe) messagesUnsubscribe();
  if (chatUnsubscribe) chatUnsubscribe();

  membersUnsubscribe = channelDocRef.collection("members").onSnapshot((snapshot) => {
    const entries = [];
    snapshot.forEach((doc) => {
      const member = doc.data();
      if (member && member.online !== false) {
        entries.push([doc.id, member]);
      }
    });

    memberCount.textContent = String(entries.length);
    updateTeamBadge(entries.length);
    if (membersEmpty) {
      membersEmpty.classList.toggle("hidden", entries.length > 0);
    }

    membersList.querySelectorAll("li:not(.empty-state)").forEach((el) => el.remove());

    entries
      .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""))
      .forEach(([id, member]) => {
        const li = document.createElement("li");
        const initials = (member.name || "?").slice(0, 2).toUpperCase();
        const isYou = id === uid;
        const talking = member.talking === true;
        const photo = member.photoURL
          ? `<img src="${escapeHtml(member.photoURL)}" alt="" />`
          : initials;
        const statusText = talking ? "Transmitting" : isYou ? "You" : "Online";
        const statusClass = talking ? "live" : "";

        li.innerHTML = `
          <span class="member-avatar${talking ? " talking" : ""}">${photo}</span>
          <span class="member-meta">
            <span class="member-name">${escapeHtml(member.name || "Unknown")}</span>
            <span class="member-status ${statusClass}">${statusText}</span>
          </span>
          <span class="member-badge${isYou ? " you" : ""}${talking ? " talking" : ""}">
            ${talking ? "Live" : isYou ? "You" : "On"}
          </span>
        `;
        membersList.appendChild(li);

        if (talking && !isYou) {
          incomingIndicator.classList.remove("hidden");
          incomingName.textContent = member.name || "Someone";
        }
      });

    const anyoneElseTalking = entries.some(
      ([id, m]) => id !== uid && m.talking === true
    );
    if (!anyoneElseTalking && !isReceivingAudio()) {
      incomingIndicator.classList.add("hidden");
    }
  });

  messagesUnsubscribe = messagesCollectionRef
    .orderBy("createdAt", "desc")
    .limit(50)
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const msg = change.doc.data();
        const id = change.doc.id;
        if (msg.senderId === uid) return;
        if (messageCreatedMs(msg) < joinTimestamp - 2000) return;

        const isStream =
          msg.streaming === true ||
          (typeof msg.chunkCount === "number" && msg.chunkCount > 0 && !msg.audioBase64);

        if (isStream) {
          if (change.type === "added" || change.type === "modified") {
            handleStreamingMessage(id, msg);
          }
          return;
        }

        if (change.type !== "added") return;
        if (!msg.audioBase64) return;
        if (playedMessageIds.has(id)) return;

        playedMessageIds.add(id);
        enqueuePlayback(msg);
        vibrate(40);
      });
    });

  chatUnsubscribe = chatCollectionRef
    .orderBy("createdAt", "asc")
    .limitToLast(100)
    .onSnapshot((snapshot) => {
      const docs = [];
      snapshot.forEach((doc) => {
        docs.push({ id: doc.id, data: doc.data() });
      });
      renderChatMessages(docs);

      snapshot.docChanges().forEach((change) => {
        if (change.type !== "added") return;
        const msg = change.doc.data();
        if (msg.senderId === uid) return;
        if (messageCreatedMs(msg) < joinTimestamp - 1000) return;
        if (currentTab !== "chat") {
          unreadChatCount += 1;
          updateChatBadge();
          if (currentTab === "radio") {
            showToast(`${msg.senderName || "Someone"}: ${(msg.text || "").slice(0, 40)}`, "info");
          }
        }
      });
    });

  setConnectionState("connected", "Live");
  if (memberDocRef) memberDocRef.update({ online: true });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

async function leaveChannel() {
  if (isTransmitting) await stopRecordingAndSend();

  if (memberDocRef) {
    await memberDocRef.update({
      online: false,
      talking: false,
      leftAt: FieldValue.serverTimestamp(),
    });
  }

  teardownChannelRefs();

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  micReady = false;
  pttBtn.disabled = true;
  playedMessageIds.clear();
  cleanupAllStreamSessions();
  updateNotifyBanner();
  activeTxMessageRef = null;
  txChunkUploadQueue = [];
  playbackQueue = [];
  isPlaying = false;
  if (playback) {
    playback.pause();
    playback.loop = false;
  }
  incomingIndicator.classList.add("hidden");
  playbackObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  playbackObjectUrls.clear();
  clearMediaSession();

  stopAudioViz();
  setPttState("idle");
  setFooterMode("");
  switchTab("radio");
  showScreen("join");
  setConnectionState("", "Connecting…");
}

// --- Push-to-talk events ---
function onPttStart(e) {
  e.preventDefault();
  if (!micReady || pttBtn.disabled) return;
  startRecording();
}

function onPttEnd(e) {
  e.preventDefault();
  if (!isTransmitting) return;
  stopRecordingAndSend();
}

pttBtn.addEventListener("mousedown", onPttStart);
pttBtn.addEventListener("mouseup", onPttEnd);
pttBtn.addEventListener("mouseleave", onPttEnd);

pttBtn.addEventListener("touchstart", onPttStart, { passive: false });
pttBtn.addEventListener("touchend", onPttEnd, { passive: false });
pttBtn.addEventListener("touchcancel", onPttEnd, { passive: false });

pttBtn.addEventListener("contextmenu", (e) => e.preventDefault());

// --- Form ---
channelIdInput.addEventListener("input", updateChannelPreview);
updateChannelPreview();

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  requestNotificationsFromUserGesture();
  joinChannel(displayNameInput.value, channelIdInput.value);
});

if (notifyEnableBtn) {
  notifyEnableBtn.addEventListener("click", () => {
    enableNotificationsFromButton();
  });
}

leaveBtn.addEventListener("click", () => {
  leaveChannel();
  showToast("Left channel", "info");
});

if (copyChannelBtn) {
  copyChannelBtn.addEventListener("click", async () => {
    if (!channelId) return;
    try {
      await navigator.clipboard.writeText(channelId);
      showToast("Channel name copied", "success");
    } catch {
      showToast(channelId, "info");
    }
  });
}

navItems.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendChatMessage();
  });
}

if (chatInput) {
  chatInput.addEventListener("input", updateChatSendState);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
}

// Prevent accidental page scroll while holding PTT
document.body.addEventListener("touchmove", (e) => {
  if (isTransmitting) e.preventDefault();
}, { passive: false });

async function initAuth() {
  try {
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    if (!auth.currentUser) {
      await auth.signInAnonymously();
    }
  } catch (err) {
    console.error("Auth error:", err);
    showError(joinError, authErrorMessage(err));
  }

  auth.onAuthStateChanged((user) => {
    if (user) {
      uid = user.uid;
      setJoinReady(true);
    } else {
      uid = null;
      setJoinReady(false);
    }
  });
}

initAuth();
registerServiceWorker();

if (copyChannelBtn) copyChannelBtn.disabled = true;
checkMobileAccess();
