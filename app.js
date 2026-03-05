// Ton Yakalama Alıştırması
// - Dosyalar: "Deniz can *.mp3" ve "EFENDİM *.mp3"
// - Dosya adları birebir kullanılır

const soundSelect = document.getElementById("soundSelect");
const refAudio = document.getElementById("refAudio");

const analyzeRefBtn = document.getElementById("analyzeRefBtn");
const micBtn = document.getElementById("micBtn");
const stopBtn = document.getElementById("stopBtn");

const targetHzEl = document.getElementById("targetHz");
const targetNoteEl = document.getElementById("targetNote");
const refStatusEl = document.getElementById("refStatus");

const liveHzEl = document.getElementById("liveHz");
const liveNoteEl = document.getElementById("liveNote");
const feedbackEl = document.getElementById("feedback");

const userMarker = document.getElementById("userMarker");
const progressFill = document.getElementById("progressFill");

// Ayarlar
const MIN_HZ = 70;
const MAX_HZ = 400;

const RANGE_SEMITONES = 18;
const SEMITONE_THRESHOLD = 0.5;
const HOLD_SECONDS = 0.8;

// Audio state
let audioCtx = null;
let analyser = null;
let micStream = null;
let rafId = null;

let targetHz = null;
let successTime = 0;
let lastTime = null;

// Helpers
function setFeedback(text) {
  feedbackEl.textContent = text;
}

function resetMeters() {
  liveHzEl.textContent = "—";
  liveNoteEl.textContent = "—";
  progressFill.style.width = "0%";
  userMarker.style.left = "50%";
  successTime = 0;
  lastTime = null;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function hzToNoteName(hz) {
  if (!hz || hz <= 0) return "—";
  const A4 = 440;
  const note = 12 * Math.log2(hz / A4) + 69;
  const rounded = Math.round(note);
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const name = names[(rounded % 12 + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

function semitoneDiff(userHz, targetHz) {
  return 12 * Math.log2(userHz / targetHz);
}

// Autocorrelation pitch detection
function detectPitch(buffer, sampleRate) {
  let rms = 0;
  for (let i = 0; i < buffer.length; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / buffer.length);
  if (rms < 0.01) return null;

  let mean = 0;
  for (let i = 0; i < buffer.length; i++) mean += buffer[i];
  mean /= buffer.length;

  const buf = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) buf[i] = buffer[i] - mean;

  const minLag = Math.floor(sampleRate / MAX_HZ);
  const maxLag = Math.floor(sampleRate / MIN_HZ);

  let bestLag = -1;
  let bestCorr = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < buf.length - lag; i++) corr += buf[i] * buf[i + lag];
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  if (bestLag === -1) return null;

  const hz = sampleRate / bestLag;
  if (hz < MIN_HZ || hz > MAX_HZ) return null;
  return hz;
}

async function ensureAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
}

// Ses seçimi
soundSelect.addEventListener("change", () => {
  refAudio.src = soundSelect.value;

  targetHz = null;
  targetHzEl.textContent = "—";
  targetNoteEl.textContent = "—";

  refStatusEl.textContent = "Yeni sesi dinleyip ‘🎯 Hedef tonu hazırla’ butonuna bas.";
  setFeedback("Mikrofon kapalı.");
  resetMeters();
});

// Hedef tonu hazırla
analyzeRefBtn.addEventListener("click", async () => {
  try {
    refStatusEl.textContent = "Hedef hazırlanıyor…";
    await ensureAudioContext();

    const url = refAudio.currentSrc || refAudio.src;
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arr);

    const ch = decoded.getChannelData(0);
    const sr = decoded.sampleRate;

    const duration = decoded.duration;
    const winSec = Math.min(1.2, Math.max(0.8, duration * 0.3));
    const points = [0.25, 0.5, 0.75].map(p => p * duration);

    const pitches = [];
    const frameSize = 2048;
    const hop = 256;

    for (const t of points) {
      const start = Math.max(0, Math.floor((t - winSec / 2) * sr));
      const end = Math.min(ch.length, start + Math.floor(winSec * sr));
      const slice = ch.slice(start, end);

      for (let i = 0; i + frameSize <= slice.length; i += hop) {
        const frame = slice.slice(i, i + frameSize);
        const hz = detectPitch(frame, sr);
        if (hz) pitches.push(hz);
      }
    }

    if (pitches.length < 10) {
      targetHz = null;
      targetHzEl.textContent = "—";
      targetNoteEl.textContent = "—";
      refStatusEl.textContent = "Hedef bulunamadı. Sesin uzun ‘tek vokal’ kısmını kullanmayı dene.";
      return;
    }

    pitches.sort((a, b) => a - b);
    targetHz = pitches[Math.floor(pitches.length / 2)];

    targetHzEl.textContent = targetHz.toFixed(1);
    targetNoteEl.textContent = hzToNoteName(targetHz);

    refStatusEl.textContent = "✅ Hedef hazır. Şimdi mikrofonu açıp dene.";
    resetMeters();
    setFeedback("Mikrofonu açınca mavi nokta hareket edecek. Hedef çizgisine getir.");
  } catch (e) {
    console.error(e);
    refStatusEl.textContent = "Hedef hazırlanamadı: " + (e?.message || e);
  }
});

// Mikrofonu aç
micBtn.addEventListener("click", async () => {
  try {
    if (!targetHz) {
      setFeedback("Önce ‘🎯 Hedef tonu hazırla’ butonuna bas.");
      return;
    }

    await ensureAudioContext();

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
    });

    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    micBtn.disabled = true;
    stopBtn.disabled = false;

    resetMeters();
    setFeedback("Dinliyorum… Hedef çizgisine yaklaş.");
    tick();
  } catch (e) {
    console.error(e);
    setFeedback("Mikrofon açılamadı: " + (e?.message || e));
  }
});

// Durdur
stopBtn.addEventListener("click", () => stopAll());

function stopAll() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }

  analyser = null;

  micBtn.disabled = false;
  stopBtn.disabled = true;

  resetMeters();
  setFeedback("Mikrofon kapalı.");
}

// Canlı ölçüm
function tick(ts) {
  rafId = requestAnimationFrame(tick);
  if (!analyser || !audioCtx || !targetHz) return;

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  const hz = detectPitch(buf, audioCtx.sampleRate);

  const now = ts || performance.now();
  const dt = lastTime ? (now - lastTime) / 1000 : 0;
  lastTime = now;

  if (!hz) {
    successTime = Math.max(0, successTime - dt * 0.8);
    progressFill.style.width = `${Math.min(1, successTime / HOLD_SECONDS) * 100}%`;
    return;
  }

  liveHzEl.textContent = hz.toFixed(1);
  liveNoteEl.textContent = hzToNoteName(hz);

  const diff = semitoneDiff(hz, targetHz);
  const pos01 = clamp01((diff + RANGE_SEMITONES) / (2 * RANGE_SEMITONES));
  userMarker.style.left = `${(pos01 * 100).toFixed(2)}%`;

  const abs = Math.abs(diff);

  if (abs <= SEMITONE_THRESHOLD) {
    successTime += dt;
    const pct = Math.min(1, successTime / HOLD_SECONDS) * 100;
    progressFill.style.width = `${pct}%`;

    if (successTime >= HOLD_SECONDS) {
      progressFill.style.width = "100%";
      setFeedback("✅ Başarılı!");
      successTime = HOLD_SECONDS;
    } else {
      setFeedback("🟢 Çok iyi! Biraz daha böyle devam.");
    }
  } else {
    successTime = Math.max(0, successTime - dt * 0.6);
    progressFill.style.width = `${Math.min(1, successTime / HOLD_SECONDS) * 100}%`;
    setFeedback(diff < 0 ? "⬆️ Sesini incelt (daha tiz)." : "⬇️ Sesini kalınlaştır (daha pes).");
  }
}

window.addEventListener("beforeunload", stopAll);