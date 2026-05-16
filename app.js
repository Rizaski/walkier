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
let isTransmitting = false;
let micReady = false;
const playedMessageIds = new Set();
let playbackQueue = [];
let isPlaying = false;

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

function getMessageAudioSrc(msg) {
  if (msg.audioUrl) return msg.audioUrl;
  if (msg.audioBase64) {
    return `data:${msg.mimeType || "audio/webm"};base64,${msg.audioBase64}`;
  }
  return null;
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
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
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

function startRecording() {
  if (!mediaStream || isTransmitting) return;
  const mimeType = getMimeType();
  const options = mimeType ? { mimeType } : undefined;

  recordedChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mediaStream, options);
  } catch (e) {
    mediaRecorder = new MediaRecorder(mediaStream);
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.start(100);
  isTransmitting = true;
  setPttState("tx");
  setActivity("Transmitting…");
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

  if (recordedChunks.length === 0) {
    setActivity("Ready");
    return;
  }

  const mimeType = recorder.mimeType || "audio/webm";
  const blob = new Blob(recordedChunks, { type: mimeType });
  recordedChunks = [];

  if (blob.size < 500) {
    setActivity("Too short — hold longer");
    vibrate([50, 50]);
    return;
  }

  setActivity("Sending…");
  await uploadAndBroadcast(blob, mimeType);
  setActivity("Sent");
  showToast("Message sent", "success");
  vibrate(20);
  setTimeout(() => {
    if (!isTransmitting && !isPlaying) setActivity("Ready");
  }, 1500);
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

// --- Playback queue ---
function enqueuePlayback(message) {
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

  try {
    const src = getMessageAudioSrc(msg);
    if (!src) return;
    playback.src = src;
    playback.load();
    await playback.play();
    await new Promise((resolve) => {
      playback.onended = resolve;
      playback.onerror = resolve;
    });
  } catch (e) {
    console.warn("Playback failed:", e);
  }

  incomingIndicator.classList.add("hidden");
  isPlaying = false;

  if (playbackQueue.length > 0) {
    processPlaybackQueue();
  } else if (!isTransmitting) {
    setPttState("idle");
    setActivity("Ready");
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
    if (!anyoneElseTalking && !isPlaying) {
      incomingIndicator.classList.add("hidden");
    }
  });

  messagesUnsubscribe = messagesCollectionRef
    .orderBy("createdAt", "desc")
    .limit(50)
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "added") return;
        const msg = change.doc.data();
        const id = change.doc.id;
        if (!getMessageAudioSrc(msg)) return;
        if (msg.senderId === uid) return;
        if (playedMessageIds.has(id)) return;
        if (messageCreatedMs(msg) < joinTimestamp - 2000) return;

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
  playbackQueue = [];
  incomingIndicator.classList.add("hidden");

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
  joinChannel(displayNameInput.value, channelIdInput.value);
});

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

if (copyChannelBtn) copyChannelBtn.disabled = true;
checkMobileAccess();
