require("dotenv").config({ path: require("path").join(__dirname, ".env") });
// Preload onnxruntime-node BEFORE @xenova/transformers (embeddings) binds its own ONNX runtime.
// If xenova loads first, the TTS native addon fails with "the operating system cannot run %1".
try { require("onnxruntime-node"); } catch (e) { console.warn("[init] onnxruntime-node preload:", e.message); }
const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");

const {
  db, saveMessage, getRecentMessages, searchMessages, getChatList, getChatConfig, setChatConfig,
  listChatSessions, newChatSession, findChatSession, renameCurrentSession, deleteChatSession
} = require("./storage");
const { isBoss, addBoss, removeBoss, listBosses, seedInitialBosses } = require("./bosses");
const {
  streamMessage, setModel, getModel, dropSession, getCwd, setCwd, getEffort, setEffort, DEFAULT_MODEL, DEFAULT_CWD,
  extractChartUrls, sanitizeMarkdown, splitLong
} = require("./ai");
const { transcribeWhatsappVoice } = require("./voice");
const { downloadAndSave, detectMediaType, listChatFiles, extractMediaMeta } = require("./media");

function extractMediaMetaCaption(message, type) {
  const m = extractMediaMeta(message, type);
  return m?.caption || null;
}
const rag = require("./rag");
const { startProfileGenerator, generateProfileFor } = require("./profile_gen");
const audit = require("./audit");
const backupMod = require("./backup");
const userProfiles = require("./user_profiles");
const scheduler = require("./scheduler");
const pii = require("./pii");
const vision = require("./vision");
const entities = require("./entities");
const learning = require("./learning");
const skills = require("./skills_mod");
const qaLearning = require("./qa_learning");
const tts = require("./tts");
const video = require("./video");
const locations = require("./locations");
const trackingEvents = require("./events");
const aliases = require("./aliases");
const persona = require("./persona");
const plugins = require("./plugins");
const workflows = require("./workflows");
const embeddings = require("./embeddings");
const budgets = require("./budgets");
const translate = require("./translate");
const knowledge = require("./knowledge");
const buttonsMod = require("./buttons");
const calendar = require("./calendar");
const i18n = require("./i18n");
const updater = require("./updater");

const AUTH_DIR = path.join(__dirname, "data", "auth");
fs.mkdirSync(AUTH_DIR, { recursive: true });

let botJid = null;
let botLid = null;
let sock = null;
const groupCache = new Map();   // group metadata cache — improves group message decryption/sender-keys
const lastLocationMsg = new Map();   // sender_jid -> last shared-location message (for forwarding on ask)
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });
const COOLDOWN_MS = 500;
const lastReplyAt = new Map();
const chatState = new Map();

function getChatState(chatId) {
  let s = chatState.get(chatId);
  if (!s) { s = { busy: false, queue: [] }; chatState.set(chatId, s); }
  return s;
}

async function enqueueOrRun(chatId, userText, msg, isGroup, senderJid = null, opts = {}) {
  const state = getChatState(chatId);
  if (state.busy) {
    state.queue.push({ userText, msg, isGroup, senderJid, senderName: msg?.pushName || "user", opts });
    console.log(`[QUEUE] chat=${chatId} queued (total ${state.queue.length})`);
    return;
  }
  state.busy = true;
  try {
    await processUserMessage(chatId, userText, msg, isGroup, senderJid, opts);
    while (state.queue.length > 0) {
      const batch = state.queue.splice(0);
      const combined = batch.length === 1
        ? batch[0].userText
        : `(Sambil lo proses pesan sebelumnya, user kirim ${batch.length} pesan tambahan:)\n${batch.map((b, i) => `${i + 1}. [${b.senderName}] ${b.userText}`).join("\n")}\n\nProcess semua di atas berurutan, atau gabungin jadi satu jawaban kalau berkaitan.`;
      const firstMsg = batch[0].msg;
      await processUserMessage(chatId, combined, firstMsg, isGroup, batch[0].senderJid, batch[0].opts || {});
    }
  } finally {
    state.busy = false;
  }
}
seedInitialBosses(process.env.WA_INITIAL_BOSSES);

function extractText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  return "";
}
function isVoiceMessage(message) { return !!(message?.audioMessage); }
function extractQuoted(message) {
  const ctx = message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return null;
  return { id: ctx.stanzaId, sender: ctx.participant || ctx.remoteJid, text: extractText(ctx.quotedMessage) };
}
function extractMentions(message) {
  if (!message) return [];
  const ctx = message.extendedTextMessage?.contextInfo
    || message.imageMessage?.contextInfo
    || message.videoMessage?.contextInfo
    || message.documentMessage?.contextInfo
    || message.audioMessage?.contextInfo;
  return ctx?.mentionedJid || [];
}
function botNumbers() {
  // Match against both the phone JID and the @lid — group mentions/replies may use either.
  const nums = [];
  if (botJid) nums.push(botJid.split(":")[0].split("@")[0]);
  if (botLid) nums.push(botLid.split(":")[0].split("@")[0]);
  return nums.filter(Boolean);
}
function isMentionedBot(mentions /* botUserJid arg ignored, uses globals */) {
  const nums = botNumbers();
  if (!nums.length || !mentions?.length) return false;
  return mentions.some(j => { const n = String(j).split(":")[0].split("@")[0]; return nums.includes(n); });
}
function isReplyToBot(quoted) {
  if (!quoted) return false;
  // Robust: quoted message is one the bot itself sent (stored from_me=1) — works regardless of @lid.
  if (quoted.id) {
    try { const row = db.prepare("SELECT from_me FROM messages WHERE message_id=?").get(quoted.id); if (row && row.from_me === 1) return true; } catch {}
  }
  const nums = botNumbers();
  if (!nums.length) return false;
  const qSender = String(quoted.sender || "").split(":")[0].split("@")[0];
  return nums.includes(qSender);
}

async function getChatName(chatId) {
  try {
    if (chatId.endsWith("@g.us")) {
      const meta = await sock.groupMetadata(chatId).catch(() => null);
      return meta?.subject || chatId;
    }
    return chatId.split("@")[0];
  } catch { return chatId; }
}

async function sendText(chatId, text, quotedMsg) {
  if (!text) return null;
  try {
    return await sock.sendMessage(chatId, { text: text.slice(0, 4096) }, quotedMsg ? { quoted: quotedMsg } : {});
  } catch (err) { console.error("sendText:", err.message); }
}

async function editText(chatId, msgKey, text) {
  if (!msgKey) return;
  try {
    await sock.sendMessage(chatId, { text: text.slice(0, 4096), edit: msgKey });
  } catch (err) { console.error("editText:", err.message); }
}

async function reactMsg(chatId, key, emoji) {
  try { await sock.sendMessage(chatId, { react: { text: emoji, key } }); } catch {}
}

async function sendImage(chatId, url, caption, quotedMsg) {
  try {
    return await sock.sendMessage(chatId, { image: { url }, caption: caption?.slice(0, 1000) || "" }, quotedMsg ? { quoted: quotedMsg } : {});
  } catch (err) { console.error("sendImage:", err.message); }
}

function mimeFromExt(filePath) {
  const ext = require("path").extname(filePath).toLowerCase();
  const map = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".doc": "application/msword",
    ".xls": "application/vnd.ms-excel",
    ".ppt": "application/vnd.ms-powerpoint",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".zip": "application/zip",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg"
  };
  return map[ext] || "application/octet-stream";
}

async function sendDocument(chatId, filePath, fileName, caption, quotedMsg) {
  try {
    if (!fs.existsSync(filePath)) {
      await sendText(chatId, `❌ File gak ada: \`${filePath}\``, quotedMsg);
      return null;
    }
    const stat = fs.statSync(filePath);
    if (stat.size > 100 * 1024 * 1024) {
      await sendText(chatId, `❌ File terlalu besar (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 100MB)`, quotedMsg);
      return null;
    }
    const finalName = fileName || path.basename(filePath);
    const mimetype = mimeFromExt(filePath);
    return await sock.sendMessage(chatId, {
      document: { url: filePath },
      fileName: finalName,
      mimetype,
      caption: caption?.slice(0, 1000) || ""
    }, quotedMsg ? { quoted: quotedMsg } : {});
  } catch (err) {
    console.error("sendDocument:", err.message);
    await sendText(chatId, `❌ Gagal kirim file: ${err.message.slice(0, 150)}`, quotedMsg);
  }
}

async function sendVoice(chatId, audioPath, isOpus, quotedMsg) {
  try {
    const buf = fs.readFileSync(audioPath);
    return await sock.sendMessage(chatId, {
      audio: buf,
      ptt: isOpus,                         // voice-note bubble only works with ogg/opus
      mimetype: isOpus ? "audio/ogg; codecs=opus" : "audio/mp4"
    }, quotedMsg ? { quoted: quotedMsg } : {});
  } catch (err) {
    console.error("sendVoice:", err.message);
    return null;
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }
}

function extractAttachMarkers(text) {
  if (!text) return { cleaned: text, files: [] };
  const files = [];
  const cleaned = text.replace(/\[ATTACH_FILE:\s*([^\]\n]+?)(?:\s*\|\s*([^\]\n]+?))?\]/g, (m, p, name) => {
    files.push({ path: p.trim(), name: (name || "").trim() || null });
    return "";
  });
  return { cleaned: cleaned.trim(), files };
}

async function sendLocation(chatId, lat, lng, name, quotedMsg) {
  try {
    return await sock.sendMessage(chatId, { location: { degreesLatitude: lat, degreesLongitude: lng, name: name || "" } }, quotedMsg ? { quoted: quotedMsg } : {});
  } catch (e) { console.error("sendLocation:", e.message); return null; }
}

// [SEND_LOCATION: lat,lng | label] -> bot sends a real WhatsApp location pin.
function extractLocationMarkers(text) {
  if (!text) return { cleaned: text, locs: [] };
  const locs = [];
  const cleaned = text.replace(/\[SEND_LOCATION:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:\|\s*([^\]]+?))?\]/g, (m, la, ln, nm) => {
    locs.push({ lat: parseFloat(la), lng: parseFloat(ln), name: (nm || "").trim() });
    return "";
  });
  return { cleaned: cleaned.trim(), locs };
}

// [LESSON: topik | pelajaran] → simpan pelajaran, hapus marker dari output.
function extractLessonMarkers(text, chatId) {
  if (!text) return { cleaned: text, count: 0 };
  let count = 0;
  const cleaned = text.replace(/\[LESSON:\s*([^\]|]+?)\s*\|\s*([\s\S]+?)\]/g, (m, key, lesson) => {
    try { if (learning.saveLesson(chatId, { topicKey: key.trim(), lesson: lesson.trim() })) count++; } catch {}
    return "";
  });
  return { cleaned: cleaned.trim(), count };
}

// [KB_SAVE: judul | isi] → simpan ke knowledge base perusahaan, hapus marker.
function extractKbMarkers(text, senderJid, chatId) {
  if (!text) return { cleaned: text, count: 0 };
  let count = 0;
  const cleaned = text.replace(/\[KB_SAVE:\s*([^\]|]+?)\s*\|\s*([\s\S]+?)\]/g, (m, title, body) => {
    try { if (knowledge.importFromText({ text: body.trim(), title: title.trim(), ownerJid: senderJid, chatId })) count++; } catch {}
    return "";
  });
  return { cleaned: cleaned.trim(), count };
}

// [SKILL_SAVE: nama | kapan dipakai | isi prosedur] → simpan skill, hapus marker.
function extractSkillMarkers(text, chatId) {
  if (!text) return { cleaned: text, names: [] };
  const names = [];
  const cleaned = text.replace(/\[SKILL_SAVE:\s*([^\]|]+?)\s*\|\s*([^\]|]+?)\s*\|\s*([\s\S]+?)\]/g, (m, name, when, content) => {
    try {
      if (skills.saveSkill({ name: name.trim(), description: when.trim(), content: content.trim(), chatId, scope: "global" })) names.push(name.trim());
    } catch {}
    return "";
  });
  return { cleaned: cleaned.trim(), names };
}

class ProgressTracker {
  constructor(chatId, quotedMsg, silent = false) {
    this.chatId = chatId;
    this.quotedMsg = quotedMsg;
    this.silent = silent;          // groups: only ⏳ reaction, no tool-step messages
    this.messageKey = null;
    this.steps = [];
    this.lastEdit = 0;
    this.MIN_INTERVAL = 800;
    this.pending = null;
    this.startedAt = Date.now();
  }
  async ensureMessage() {
    if (this.messageKey) return;
    const r = await sendText(this.chatId, "⏳ _memproses..._", this.quotedMsg);
    this.messageKey = r?.key;
  }
  async addStep(label) {
    const last = this.steps[this.steps.length - 1];
    if (last === label) return;
    this.steps.push(label);
    if (this.silent) return;       // track count for meta, but show nothing
    if (!this.messageKey) await this.ensureMessage();
    if (this.steps.length === 1) { await this.doUpdate(); return; }
    this.scheduleUpdate();
  }
  scheduleUpdate() {
    const now = Date.now();
    if (now - this.lastEdit >= this.MIN_INTERVAL) {
      this.doUpdate();
    } else if (!this.pending) {
      const wait = this.MIN_INTERVAL - (now - this.lastEdit);
      this.pending = setTimeout(() => { this.pending = null; this.doUpdate(); }, wait);
    }
  }
  async doUpdate() {
    if (!this.messageKey) return;
    this.lastEdit = Date.now();
    const recent = this.steps.slice(-8);
    const sec = ((Date.now() - this.startedAt) / 1000).toFixed(0);
    const text = `⏳ _memproses ${sec}s..._\n\n${recent.join("\n")}`;
    await editText(this.chatId, this.messageKey, text);
  }
  async finalize(success = true) {
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
    if (!this.messageKey) return;
    const sec = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const summary = success
      ? `✅ _${this.steps.length} step · ${sec}s_`
      : `❌ _gagal · ${this.steps.length} step · ${sec}s_`;
    await editText(this.chatId, this.messageKey, summary);
  }
  hasMessage() { return !!this.messageKey; }
}

const BOT_LOCAL_COMMANDS = new Set([
  "/help", "/start", "/reset", "/id", "/pwd", "/home", "/cd",
  "/sessions", "/list", "/resume", "/new", "/rename", "/delete",
  "/model", "/safe", "/safe-mode", "/permission",
  "/boss-add", "/boss-remove", "/list-bosses", "/list-chats",
  "/dm-on", "/dm-off", "/listen-on", "/listen-off",
  "/summarize", "/whosaid", "/recent", "/files",
  "/search", "/topics", "/profile", "/profile-gen",
  "/effort", "/health", "/send", "/analyze",
  "/persona", "/remind", "/reminders", "/cron", "/audit", "/backup",
  "/users", "/userprofile", "/pii", "/wf", "/workflow", "/workflows",
  "/plugins", "/plugin-reload", "/embedstatus", "/embed-backfill",
  "/lang", "/translate", "/budget", "/budgets",
  "/language", "/import", "/imports", "/import-delete",
  "/pilih", "/pick", "/remembered", "/forget",
  "/event", "/events", "/ics", "/cal",
  "/ui-lang", "/uilang", "/version", "/update-check",
  "/lessons", "/lesson-del", "/skills", "/skill", "/skill-del", "/voice",
  "/facts", "/fact-del", "/lokasi", "/alias", "/senders", "/who", "/habits", "/kb"
]);

async function handleCommand(chatId, senderJid, text, isGroup, msg) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const argText = text.slice(cmd.length).trim();
  const boss = isBoss(senderJid);

  if (!BOT_LOCAL_COMMANDS.has(cmd)) return false;

  if (cmd === "/start" || cmd === "/help") {
    const topic = argText.toLowerCase().replace(/^\//, "");
    if (topic) {
      const HELP_TOPICS = {
        session: `📂 *SESSION (boss)*\n/sessions — list semua session\n/new [nama] — bikin session baru\n/resume <n> — pindah ke session n\n/rename <nama> — ganti nama current\n/delete <n> — hapus session n\n/reset — drop current (next msg bikin baru)`,
        setup: `⚙️ *SETUP (boss)*\n/model auto|haiku|sonnet|opus — model (auto=hemat: simpel→haiku, berat→sonnet)\n/effort [low|medium|high|xhigh|max] — depth reasoning\n/safe on|off — konfirmasi sebelum action risky\n/permission <mode> — bypassPermissions/default/plan/dll\n/cd <path> • /pwd • /home — working dir`,
        rag: `🧠 *MEMORY & SEARCH*\n/search <kata> — cari di SEMUA group/DM\n/whosaid <kata> — siapa pernah bilang\n/summarize [N] — ringkas N pesan terakhir\n/recent [N] — N pesan terakhir\n/topics — daftar group + topiknya\n/profile — profil group ini\n/profile-gen — regen profil group (boss)\n/embedstatus • /embed-backfill — vector index`,
        file: `📎 *FILE*\n/files — list file di chat ini\n/send <path> — kirim file dari disk\n/analyze <path> — analisa isi file\nKirim PDF/DOCX/XLSX/PPTX/foto → auto-extract.\nMinta bikin file → bot generate native (bukan HTML).`,
        lang: `🌐 *BAHASA*\n/lang — set bahasa reply Claude\n/language — list 19 bahasa\n/translate on|off — auto-translate\n/ui-lang id|en — bahasa UI bot/menu`,
        budget: `💰 *BUDGET & AUDIT (boss)*\n/budget [jid] — lihat budget user\n/budgets — semua budget\n/audit [N] — log aksi\n/pii — toggle deteksi data sensitif\n/backup — backup DB manual`,
        auto: `⏰ *OTOMASI (boss)*\n/remind <waktu> <pesan> — reminder\n/reminders — list reminder\n/cron — jadwal berulang\n/event • /events • /ics • /cal — kalender\n/wf • /workflow • /workflows — mini-workflow\n/plugins • /plugin-reload — plugin`,
        admin: `👑 *ADMIN (boss)*\n/boss-add <nomor> • /boss-remove • /list-bosses\n/list-chats — semua chat\n/dm-on|off — bot balas DM\n/listen-on|off — bot dengar group ini\n/users • /userprofile — profil user\n/persona — ganti gaya bot\n/version • /update-check — cek update`,
        button: `🔘 *PILIHAN & PREFERENSI*\n/pilih <n> atau /pick <n> — pilih opsi tombol\n/remembered — preferensi tersimpan\n/forget <pattern> — hapus preferensi`,
        learn: `🧠 *BELAJAR & SKILL*\nBot belajar otomatis dari: (1) koreksi lo, (2) tanya-jawab orang di grup.\n/lessons — pelajaran dari koreksi lo\n/lesson-del <id> — hapus (boss)\n/facts — fakta dari obrolan grup (status + alasan)\n/fact-del <id> — hapus fakta (boss)\n/skills — daftar skill\n/skill <nama> — detail skill\n/skill-del <nama> — hapus skill (boss)`,
        company: `🏢 *OTAK PERUSAHAAN (onboarding)*\nBot tau soal perusahaan, grup, divisi, jobdesc, SOP — orang baru tinggal tanya, gak perlu diajarin manual.\n/kb — liat knowledge base\n/kb add <judul> = <isi> — ajarin fakta (boss)\n/import file — masukin SOP/handbook (reply dokumen)\nAtau ngomong ke bot: "catat: bagian gudang tugasnya..." → bot inget.\nTanya: "saya bagian X kerjaannya apa?", "grup ini buat apa?", "SOP kirim barang gimana?"`,
        voice: `🔊 *VOICE / TTS*\nBot bisa bales pakai voice note (suara natural Supertonic).\n/voice on — semua balasan + voice note (tetap ada teks)\n/voice off — teks aja\n_Kirim voice → bot auto-bales voice juga (mirror), walau mode off._\nSetup model sekali: \`node tts/supertonic/download-model.mjs\``,
        lokasi: `📍 *SHARE LOKASI*\nOrang share lokasi → bot inget. Tanya "kep X dimana / posisi kep X" → bot *forward* pesan lokasi kep itu ke penanya (bukan dihitung).\n/lokasi <nama> — kirim/forward lokasi terakhir orang itu\n/senders — liat akun WA pengirim\n/alias "julukan" = <nomor/nama> — map julukan ke akun (mis kep Agus)\n/alias list • /alias del <julukan>`
      };
      const t = HELP_TOPICS[topic];
      if (t) return sendText(chatId, t, msg);
      return sendText(chatId, `❓ Topik "${topic}" gak ada.\nTopik: session, setup, rag, file, lang, budget, auto, admin, button, company, learn, voice, lokasi`, msg);
    }
    return sendText(chatId,
      `🤖 *Claude Code di WhatsApp*\n\n` +
      `Full Claude Code agent di HP: file system, web, MCP, semua tool.\n\n` +
      `📋 Chat bebas / voice note (auto-transkrip) / kirim file / slash command Claude (/init, /review, dll auto-forward).\n\n` +
      `━━━━━━━━━━━━━━\n` +
      `*Detail per kategori:* ketik \`/help <topik>\`\n` +
      `• \`/help session\` — kelola session\n` +
      `• \`/help setup\` — model, effort, safe, cd\n` +
      `• \`/help rag\` — memory, search, summarize\n` +
      `• \`/help file\` — kirim/analisa/bikin file\n` +
      `• \`/help lang\` — bahasa & translate\n` +
      `• \`/help budget\` — budget, audit, pii\n` +
      `• \`/help auto\` — remind, cron, workflow, kalender\n` +
      `• \`/help admin\` — boss, persona, listen\n` +
      `• \`/help button\` — pilihan & preferensi\n` +
      `• \`/help company\` — otak perusahaan / onboarding\n` +
      `• \`/help learn\` — belajar dari koreksi + skills\n` +
      `• \`/help voice\` — voice note / TTS\n` +
      `• \`/help lokasi\` — share lokasi & peta titik\n` +
      `━━━━━━━━━━━━━━\n` +
      `*Sering dipakai:*\n` +
      `/search <kata> • /summarize • /recent • /files\n` +
      `/model • /effort • /sessions • /new • /health • /id`, msg);
  }
  if (cmd === "/id") return sendText(chatId, `Chat ID: \`${chatId}\`\nSender JID: \`${senderJid}\``, msg);

  if (cmd === "/pwd") return sendText(chatId, `📂 cwd: \`${getCwd(chatId)}\``, msg);
  if (cmd === "/home") { if (!boss) return sendText(chatId, "❌ Boss only.", msg); setCwd(chatId, DEFAULT_CWD); return sendText(chatId, `✅ cwd → \`${DEFAULT_CWD}\``, msg); }
  if (cmd === "/cd") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (!argText) return sendText(chatId, "Format: /cd <path>", msg);
    let abs = argText;
    if (!path.isAbsolute(argText)) abs = path.resolve(getCwd(chatId), argText);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return sendText(chatId, `❌ Folder gak ada: \`${abs}\``, msg);
    setCwd(chatId, abs);
    return sendText(chatId, `✅ cwd → \`${abs}\``, msg);
  }

  if (cmd === "/sessions" || cmd === "/list") {
    const list = listChatSessions(chatId);
    if (!list.length) return sendText(chatId, "📭 Belum ada session. Kirim pesan biasa untuk bikin pertama.", msg);
    const cur = getChatConfig(chatId).claude_session_id;
    const lines = list.map((s, i) => `${s.session_uuid === cur ? "👉" : "  "} *${i + 1}.* ${s.name} \`${s.session_uuid.slice(0, 8)}\` _${s.last_used.slice(0, 16)}_`);
    return sendText(chatId, `📂 *SESSIONS (${list.length})*\n\n${lines.join("\n")}\n\n/resume <nomor>`, msg);
  }
  if (cmd === "/resume") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (!argText) return sendText(chatId, "Format: /resume <nomor>. Liat /sessions.", msg);
    const s = findChatSession(chatId, argText);
    if (!s) return sendText(chatId, `❌ Session "${argText}" gak ada.`, msg);
    setChatConfig(chatId, { claude_session_id: s.session_uuid });
    return sendText(chatId, `✅ → *${s.name}* \`${s.session_uuid.slice(0, 8)}\``, msg);
  }
  if (cmd === "/new") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const s = newChatSession(chatId, argText || null);
    return sendText(chatId, `✨ Session baru: *${s.name}*\n\`${s.uuid.slice(0, 8)}\``, msg);
  }
  if (cmd === "/rename") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (!argText) return sendText(chatId, "Format: /rename <nama>", msg);
    return sendText(chatId, renameCurrentSession(chatId, argText) ? `✅ → *${argText}*` : "❌ Gak ada current session.", msg);
  }
  if (cmd === "/delete") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const d = deleteChatSession(chatId, argText);
    return sendText(chatId, d ? `🗑️ Deleted: *${d.name}*` : `❌ "${argText}" gak ada.`, msg);
  }
  if (cmd === "/reset") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    dropSession(chatId);
    return sendText(chatId, "✅ Current session di-drop. Pesan berikutnya bikin session baru.", msg);
  }

  if (cmd === "/model") {
    const curRaw = getChatConfig(chatId).model;
    const cur = (!curRaw || curRaw === "auto") ? "auto (haiku⇄sonnet otomatis)" : `${curRaw} (manual)`;
    if (!argText) return sendText(chatId, `🧠 Model: *${cur}*\n\nGanti (boss): /model auto | haiku | sonnet | opus\n_auto = hemat: pesan simpel→haiku, berat→sonnet_`, msg);
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const m = argText.toLowerCase();
    const valid = ["auto", "haiku", "sonnet", "opus"];
    if (!valid.includes(m)) return sendText(chatId, `❌ Pilih: ${valid.join(" | ")}`, msg);
    setModel(chatId, m);
    return sendText(chatId, m === "auto" ? `✅ Model → *auto* (hemat: simpel→haiku, berat→sonnet)` : `✅ Model → *${m}* (manual, auto-routing mati)`, msg);
  }

  if (cmd === "/safe" || cmd === "/safe-mode") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const arg = argText.toLowerCase();
    if (arg !== "on" && arg !== "off") {
      const cur = getChatConfig(chatId).safe_mode ? "ON" : "OFF";
      return sendText(chatId, `🔒 Safe mode: *${cur}*\n\n/safe on - konfirmasi sebelum action risky\n/safe off - eksekusi langsung`, msg);
    }
    setChatConfig(chatId, { safe_mode: arg === "on" ? 1 : 0 });
    return sendText(chatId, `✅ Safe → *${arg.toUpperCase()}*`, msg);
  }

  if (cmd === "/permission") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const valid = ["bypassPermissions", "default", "acceptEdits", "auto", "plan", "dontAsk"];
    if (!argText) {
      const cur = getChatConfig(chatId).permission_mode || (process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions");
      return sendText(chatId, `🔐 Permission: *${cur}*\n\nValid: ${valid.join(", ")}`, msg);
    }
    if (!valid.includes(argText)) return sendText(chatId, `❌ Invalid: ${argText}`, msg);
    setChatConfig(chatId, { permission_mode: argText });
    return sendText(chatId, `✅ Permission → *${argText}*`, msg);
  }

  if (cmd === "/boss-add") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const newJid = addBoss(argText);
    return sendText(chatId, newJid ? `✅ Boss: \`${newJid}\`` : "❌ Format salah.", msg);
  }
  if (cmd === "/boss-remove") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    return sendText(chatId, removeBoss(argText) ? "✅ Removed." : "❌ Gak ketemu.", msg);
  }
  if (cmd === "/list-bosses") {
    const list = listBosses();
    if (!list.length) return sendText(chatId, "📭 Belum ada boss.", msg);
    return sendText(chatId, `👑 *BOSSES:*\n${list.map(b => `• \`${b.jid}\`${b.name ? " - " + b.name : ""}`).join("\n")}`, msg);
  }
  if (cmd === "/list-chats") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const list = getChatList();
    if (!list.length) return sendText(chatId, "📭 Belum ada chat.", msg);
    return sendText(chatId, `📋 *CHATS:*\n${list.map(c => `• ${c.is_group ? "👥" : "👤"} *${c.chat_name || c.chat_id}* (${c.msg_count})`).join("\n")}`, msg);
  }

  if (cmd === "/dm-on" || cmd === "/dm-off") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    setChatConfig(chatId, { auto_respond_dm: cmd === "/dm-on" ? 1 : 0 });
    return sendText(chatId, `✅ DM auto-respond = ${cmd === "/dm-on" ? "ON" : "OFF"}`, msg);
  }
  if (cmd === "/listen-on" || cmd === "/listen-off") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    setChatConfig(chatId, { listen_only: cmd === "/listen-on" ? 1 : 0 });
    return sendText(chatId, `✅ Listen-only = ${cmd === "/listen-on" ? "ON" : "OFF"}`, msg);
  }

  if (cmd === "/summarize") {
    const n = parseInt(argText, 10) || 30;
    const msgs = getRecentMessages(chatId, n);
    if (!msgs.length) return sendText(chatId, "❌ Belum ada pesan.", msg);
    return processUserMessage(chatId, `Tolong summarize ${n} pesan terakhir di chat ini secara ringkas. Sebut siapa ngomong apa.`, msg, isGroup);
  }
  if (cmd === "/whosaid") {
    if (!argText) return sendText(chatId, "Format: /whosaid <kata>", msg);
    const found = searchMessages(chatId, argText, 15);
    if (!found.length) return sendText(chatId, `❌ Gak ada pesan dengan "${argText}"`, msg);
    return sendText(chatId, `🔍 *"${argText}":*\n\n${found.map(f => `• *${f.sender_name || "?"}*: ${(f.text || "").slice(0, 100)}`).join("\n")}`, msg);
  }
  if (cmd === "/ui-lang" || cmd === "/uilang") {
    const langs = i18n.availableLangs();
    if (!argText) {
      const cur = i18n.getLang(chatId);
      return sendText(chatId, `🌐 *UI Language:* ${cur}\n\nAvailable: ${langs.join(", ")}\n\nChange: /ui-lang <code>\nApplies to: bot reply texts, system prompts, error messages`, msg);
    }
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (!i18n.setLang(chatId, argText)) return sendText(chatId, `❌ Invalid lang: ${argText}. Available: ${langs.join(", ")}`, msg);
    audit.log({ chat_id: chatId, sender_jid: senderJid, action: "ui_lang_set", target: argText });
    return sendText(chatId, `✅ UI Language → *${argText}*`, msg);
  }

  if (cmd === "/version") {
    const s = updater.getStatus();
    const text =
      `📦 *Bot Version*\n` +
      `Current: v${s.current_version}\n` +
      `Latest: ${s.latest_version ? "v" + s.latest_version : "(unknown)"}\n` +
      `Update available: ${s.update_available ? "🆕 YES" : "✅ NO"}\n` +
      `Last checked: ${s.last_checked_at || "(never)"}\n` +
      `Repo: ${s.repo}` +
      (s.update_available ? `\n\nUpdate via: ./update.sh atau update.bat` : "");
    return sendText(chatId, text, msg);
  }

  if (cmd === "/update-check") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    await sendText(chatId, "⏳ Checking for updates...", msg);
    const r = await updater.checkForUpdate();
    return sendText(chatId, r ? `📦 Current: v${r.current}\nLatest: v${r.latest}\n${r.hasUpdate ? "🆕 Update available!" : "✅ Up to date"}` : "❌ Check failed", msg);
  }

  if (cmd === "/language") {
    const all = translate.listLangs();
    if (!argText) {
      const lines = all.map((l, i) => `*${i + 1}.* \`${l.code}\` — ${l.name}`);
      return sendText(chatId, `🌐 *PILIH BAHASA* (${all.length})\n\n${lines.join("\n")}\n\nReply nomor (e.g. *3*), atau pakai \`/language <code>\` langsung.`, msg);
    }
    let chosen = null;
    if (/^\d+$/.test(argText)) chosen = all[parseInt(argText, 10) - 1];
    else chosen = all.find(l => l.code === argText.toLowerCase() || l.name.toLowerCase() === argText.toLowerCase());
    if (!chosen) return sendText(chatId, `❌ "${argText}" gak valid. /language tanpa argumen untuk liat list.`, msg);
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    translate.setChatLang(chatId, chosen.code);
    audit.log({ chat_id: chatId, sender_jid: senderJid, action: "lang_set", target: chosen.code });
    return sendText(chatId, `✅ Bahasa → *${chosen.name}* (\`${chosen.code}\`)\n\nClaude reply pakai bahasa ini. Aktifkan auto-translate incoming: /translate auto`, msg);
  }

  if (cmd === "/import") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (!argText) return sendText(chatId, `📚 *Import to RAG*\n\n/import url <http://...>\n/import text <text body>\n/import file (reply ke pesan dengan file)\n/imports — list\n/import-delete <id>`, msg);
    const sub = parts[1]?.toLowerCase();
    const rest = text.slice(text.indexOf(sub) + sub.length).trim();
    try {
      let result;
      if (sub === "url") {
        result = await knowledge.importFromUrl({ url: rest, ownerJid: senderJid, chatId });
      } else if (sub === "text") {
        result = knowledge.importFromText({ text: rest, ownerJid: senderJid, chatId });
      } else if (sub === "file") {
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (!quoted) return sendText(chatId, "Reply ke pesan dengan file dulu, baru /import file", msg);
        const qStanza = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
        const qMsg = db.prepare("SELECT media_path, media_filename FROM messages WHERE message_id=?").get(qStanza);
        if (!qMsg?.media_path) return sendText(chatId, "❌ File asal gak ke-save.", msg);
        result = await knowledge.importFromFile({ filePath: qMsg.media_path, ownerJid: senderJid, chatId, title: qMsg.media_filename });
      } else {
        return sendText(chatId, "Format: /import url|text|file ...", msg);
      }
      audit.log({ chat_id: chatId, sender_jid: senderJid, action: "kb_import", target: `#${result.id}`, detail: result.title });
      return sendText(chatId, `✅ Imported #${result.id}: *${result.title}*\nLength: ${result.length} char\n\nSekarang queryable di RAG.`, msg);
    } catch (err) { return sendText(chatId, `❌ ${err.message}`, msg); }
  }

  if (cmd === "/imports") {
    const list = knowledge.listImports(30, boss ? null : senderJid);
    if (!list.length) return sendText(chatId, "📭 Belum ada import. /import url <...>", msg);
    return sendText(chatId, `📚 *KB Imports (${list.length}):*\n\n${list.map(k => `#${k.id} [${k.source_type}] *${k.title}* (${k.length} char)\n  _${k.created_at}_`).join("\n\n")}`, msg);
  }

  if (cmd === "/import-delete") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const id = parseInt(argText, 10);
    return sendText(chatId, knowledge.deleteImport(id) ? `🗑️ Import #${id} dihapus.` : `❌`, msg);
  }

  if (cmd === "/pilih" || cmd === "/pick") {
    const pending = buttonsMod.getLatestPending(chatId);
    if (!pending) return sendText(chatId, "❌ Gak ada pertanyaan pending.", msg);
    const r = buttonsMod.resolveButtonReply(pending.id, argText);
    if (!r) return sendText(chatId, "❌ Pilihan gak valid.", msg);
    await enqueueOrRun(chatId, `(User pilih: *${r.picked.label}* / id=${r.picked.id})`, msg, isGroup, senderJid);
    return true;
  }

  if (cmd === "/remembered") {
    const list = buttonsMod.listRemembered(chatId);
    if (!list.length) return sendText(chatId, "📭 Belum ada decision tersimpan.", msg);
    return sendText(chatId, `🧠 *Remembered decisions:*\n\n${list.map(r => `• ${r.pattern} → *${r.decision}*`).join("\n")}\n\n/forget <pattern> untuk hapus`, msg);
  }
  if (cmd === "/forget") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const ok = buttonsMod.clearRemembered(chatId, argText || null);
    return sendText(chatId, ok ? `✅ Cleared.` : `❌ Gak ada.`, msg);
  }

  if (cmd === "/event") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (!argText) return sendText(chatId, "Format: /event <judul> @ <waktu>\nContoh:\n/event Meeting design @ besok 14:00\n/event Deadline laporan @ 2026-05-20 17:00", msg);
    const m = argText.match(/^(.+?)\s*@\s*(.+)$/);
    if (!m) return sendText(chatId, "Format: /event <judul> @ <waktu>", msg);
    const start = calendar.parseHumanDateTime(m[2]);
    if (!start) return sendText(chatId, `❌ Waktu gak valid: "${m[2]}"`, msg);
    const e = calendar.createEvent({ ownerJid: senderJid, chatId, title: m[1].trim(), startAt: start.toISOString() });
    audit.log({ chat_id: chatId, sender_jid: senderJid, action: "event_create", target: `#${e.id}`, detail: m[1].trim() });
    return sendText(chatId, `📅 Event #${e.id} *${m[1].trim()}*\n🕐 ${start.toLocaleString("id-ID")}\n\n/ics <id> untuk dapet file calendar`, msg);
  }
  if (cmd === "/events") {
    const list = calendar.listEvents({ ownerJid: boss ? null : senderJid, fromDate: new Date().toISOString() });
    if (!list.length) return sendText(chatId, "📭 Gak ada event upcoming.", msg);
    return sendText(chatId, `📅 *Upcoming events (${list.length}):*\n\n${list.map(e => `#${e.id} *${e.title}*\n  🕐 ${new Date(e.start_at).toLocaleString("id-ID")}${e.location ? "\n  📍 " + e.location : ""}`).join("\n\n")}`, msg);
  }
  if (cmd === "/ics") {
    const id = parseInt(argText, 10);
    const list = id ? [calendar.getEvent(id)].filter(Boolean) : calendar.listEvents({ ownerJid: boss ? null : senderJid, fromDate: new Date().toISOString() });
    if (!list.length) return sendText(chatId, "❌ Event gak ada.", msg);
    const r = calendar.exportIcsToFile(list);
    await sendDocument(chatId, r.path, r.filename, `📅 Calendar export (${list.length} event). Import ke Google Calendar / Outlook / Apple Calendar.`, msg);
    return true;
  }
  if (cmd === "/cal") {
    const sub = parts[1]?.toLowerCase();
    if (sub === "delete" || sub === "del") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      return sendText(chatId, calendar.deleteEvent(parseInt(parts[2], 10)) ? `🗑️ Deleted.` : `❌`, msg);
    }
    return sendText(chatId, `📅 Calendar:\n/event <title> @ <time>\n/events\n/ics [id]\n/cal delete <id>`, msg);
  }

  if (cmd === "/lang") {
    const cur = translate.getChatLangConfig(chatId);
    if (!argText) {
      const langs = translate.listLangs().map(l => `${l.code}:${l.name}`).join(", ");
      return sendText(chatId, `🌐 *Lang preference:* ${cur.preferred || "(none)"}\n*Auto-translate mode:* ${cur.mode || "off"}\n\nLangs: ${langs}\n\n/lang <code> - set preferred (Claude reply pakai bahasa ini)\n/lang off - clear\n/translate auto - enable auto translate incoming foreign msg\n/translate off - disable`, msg);
    }
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (argText === "off") {
      translate.setChatLang(chatId, null, "off");
      return sendText(chatId, "✅ Lang cleared.", msg);
    }
    if (!translate.LANG_NAMES[argText]) return sendText(chatId, `❌ Lang code "${argText}" gak valid.`, msg);
    translate.setChatLang(chatId, argText);
    return sendText(chatId, `✅ Lang → *${argText}* (${translate.LANG_NAMES[argText]}). Claude reply bakal pake bahasa ini.`, msg);
  }

  if (cmd === "/translate") {
    if (!argText) {
      const cur = translate.getChatLangConfig(chatId);
      return sendText(chatId, `🌐 *Translate mode:* ${cur.mode}\n*Target lang:* ${cur.preferred || "(set via /lang)"}\n\n/translate auto - auto-translate incoming foreign\n/translate off - matikan\n/translate <text> to <lang> - translate teks sekali`, msg);
    }
    const toMatch = argText.match(/^(.+?)\s+to\s+([a-z]{2})$/i);
    if (toMatch) {
      try {
        const out = await translate.translateText(toMatch[1], toMatch[2].toLowerCase());
        return sendText(chatId, `🌐 _→${toMatch[2]}_\n${out}`, msg);
      } catch (err) { return sendText(chatId, `❌ ${err.message}`, msg); }
    }
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (argText === "auto" || argText === "on") {
      const cur = translate.getChatLangConfig(chatId);
      if (!cur.preferred) return sendText(chatId, "❌ Set /lang <code> dulu.", msg);
      translate.setChatLang(chatId, undefined, "auto");
      return sendText(chatId, `✅ Auto-translate → ON. Pesan bahasa lain auto-translate ke ${cur.preferred}.`, msg);
    }
    if (argText === "off") {
      translate.setChatLang(chatId, undefined, "off");
      return sendText(chatId, "✅ Auto-translate → OFF.", msg);
    }
    return sendText(chatId, "Format salah. /translate auto | off | <text> to <lang>", msg);
  }

  if (cmd === "/budget") {
    const sub = parts[1]?.toLowerCase();
    if (sub === "set") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const jidArg = parts[2];
      const usd = parseFloat(parts[3]);
      if (!jidArg || isNaN(usd)) return sendText(chatId, "Format: /budget set <jid/number> <usd>\nContoh: /budget set 6281234567890 5.0\n(0 = unlimited)", msg);
      const targetJid = require("./bosses").normalizeJid(jidArg);
      budgets.setLimit(targetJid, usd);
      audit.log({ chat_id: chatId, sender_jid: senderJid, action: "budget_set", target: targetJid, detail: `$${usd}/day` });
      return sendText(chatId, `✅ Budget ${targetJid}: $${usd}/day`, msg);
    }
    if (sub === "all") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const list = budgets.listBudgets();
      if (!list.length) return sendText(chatId, "📭 Belum ada budget tracked.", msg);
      const lines = list.slice(0, 30).map(b => `• \`${b.user_jid.split("@")[0]}\` $${b.used_usd_today.toFixed(4)}/$${b.daily_limit_usd.toFixed(2)} (total $${b.used_usd_total.toFixed(2)}, ${b.total_requests}x)`);
      return sendText(chatId, `💰 *Budgets (${list.length}):*\n\n${lines.join("\n")}`, msg);
    }
    const targetJid = sub ? require("./bosses").normalizeJid(sub) : senderJid;
    const b = budgets.getBudget(targetJid);
    if (!b) { budgets.ensureBudget(targetJid, isBoss(targetJid)); return sendText(chatId, `💰 Budget ${targetJid}: baru ke-init. Coba lagi.`, msg); }
    const pct = b.daily_limit_usd > 0 ? (b.used_usd_today / b.daily_limit_usd * 100).toFixed(1) : 0;
    return sendText(chatId, `💰 *Budget ${b.user_jid.split("@")[0]}*\nHari ini: $${b.used_usd_today.toFixed(4)} / $${b.daily_limit_usd.toFixed(2)} (${pct}%)\nTotal lifetime: $${b.used_usd_total.toFixed(2)} (${b.total_requests} request)\nReset: ${b.last_reset_at}`, msg);
  }
  if (cmd === "/budgets") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const list = budgets.listBudgets();
    if (!list.length) return sendText(chatId, "📭 Empty.", msg);
    const lines = list.slice(0, 30).map(b => `• \`${b.user_jid.split("@")[0]}\` $${b.used_usd_today.toFixed(4)}/$${b.daily_limit_usd.toFixed(2)}`);
    return sendText(chatId, `💰 *All budgets:*\n${lines.join("\n")}`, msg);
  }

  if (cmd === "/persona") {
    const list = persona.listPersonas();
    if (!argText) {
      const cur = persona.getPersona(chatId);
      return sendText(chatId, `🎭 Persona: *${cur.name}* (auto: ${cur.auto ? "🟢" : "🔴"})\n\n${list.map(p => `• \`${p.key}\` — ${p.label}`).join("\n")}\n• \`auto\` — adapt by speaker\n\nGanti: /persona casual | formal | professional | funny | technical | supportive | auto`, msg);
    }
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (!persona.setPersona(chatId, argText)) return sendText(chatId, `❌ Invalid: ${argText}`, msg);
    audit.log({ chat_id: chatId, sender_jid: senderJid, sender_name: senderName, action: "persona_change", target: argText });
    return sendText(chatId, `✅ Persona → *${argText}*`, msg);
  }

  if (cmd === "/remind") {
    if (!argText) return sendText(chatId, "Format: /remind <waktu> <pesan>\nContoh:\n/remind 30m call John\n/remind 2h meeting design review\n/remind tomorrow 09:00 deadline laporan", msg);
    const m = argText.match(/^(\S+)\s+(.+)$/);
    if (!m) return sendText(chatId, "Format salah. /remind <waktu> <pesan>", msg);
    const dueAt = scheduler.parseHumanDuration(m[1]);
    if (!dueAt) return sendText(chatId, `❌ Waktu gak valid: "${m[1]}". Pakai: 30s/30m/2h/1d atau ISO date`, msg);
    const r = scheduler.createReminder({ ownerJid: senderJid, targetChatId: chatId, dueAt, message: m[2] });
    audit.log({ chat_id: chatId, sender_jid: senderJid, action: "reminder_create", target: `#${r.id}`, detail: m[2] });
    return sendText(chatId, `⏰ Reminder #${r.id} set: *${new Date(dueAt).toLocaleString("id-ID")}*\n_${m[2]}_`, msg);
  }
  if (cmd === "/reminders") {
    const list = scheduler.listReminders(senderJid);
    if (!list.length) return sendText(chatId, "📭 Gak ada reminder aktif.", msg);
    return sendText(chatId, `⏰ *Reminder aktif (${list.length}):*\n\n${list.map(r => `#${r.id} ${r.due_at.slice(0, 16).replace("T", " ")} — ${r.message}`).join("\n")}\n\nCancel: /remind cancel <id>`, msg);
  }

  if (cmd === "/cron") {
    const sub = parts[1]?.toLowerCase();
    if (sub === "add") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const rest = text.slice(text.indexOf("add") + 3).trim();
      const cronMatch = rest.match(/^"([^"]+)"\s+(.+)$/) || rest.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
      if (!cronMatch) return sendText(chatId, `Format: /cron add "<cron-expr>" <prompt>\nContoh: /cron add "0 8 * * *" ringkasin chat semalem`, msg);
      const id = scheduler.createCron({ ownerJid: senderJid, targetChatId: chatId, name: null, cronExpr: cronMatch[1], prompt: cronMatch[2] });
      audit.log({ chat_id: chatId, sender_jid: senderJid, action: "cron_create", target: `#${id}`, detail: cronMatch[1] });
      return sendText(chatId, `⏱️ Cron #${id} added: \`${cronMatch[1]}\`\n_${cronMatch[2]}_`, msg);
    }
    if (sub === "list" || !sub) {
      const list = scheduler.listCron(senderJid);
      if (!list.length) return sendText(chatId, "📭 Gak ada cron.", msg);
      return sendText(chatId, `⏱️ *Cron tasks (${list.length}):*\n\n${list.map(c => `${c.active ? "🟢" : "🔴"} #${c.id} \`${c.cron_expr}\` — ${c.prompt.slice(0, 60)}\n  next: ${c.next_run || "(none)"}`).join("\n\n")}`, msg);
    }
    if (sub === "delete" || sub === "del" || sub === "rm") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const id = parseInt(parts[2], 10);
      return sendText(chatId, scheduler.deleteCron(id) ? `🗑️ Cron #${id} dihapus.` : `❌ Gak ada.`, msg);
    }
    if (sub === "pause") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const id = parseInt(parts[2], 10);
      return sendText(chatId, scheduler.setCronActive(id, false) ? `⏸️ Cron #${id} paused.` : `❌`, msg);
    }
    if (sub === "resume") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const id = parseInt(parts[2], 10);
      return sendText(chatId, scheduler.setCronActive(id, true) ? `▶️ Cron #${id} resumed.` : `❌`, msg);
    }
    return sendText(chatId, "Format: /cron add | list | delete <id> | pause <id> | resume <id>", msg);
  }

  if (cmd === "/audit") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const n = parseInt(argText, 10) || 20;
    const rows = audit.recent({ limit: n });
    if (!rows.length) return sendText(chatId, "📭 Audit log kosong.", msg);
    const lines = rows.map(r => `[${r.created_at.slice(11, 16)}] *${r.action}* ${r.target || ""} ${r.detail ? `· ${r.detail.slice(0, 50)}` : ""}`);
    return sendText(chatId, `📋 *Audit log (${rows.length} terakhir):*\n\n${lines.join("\n")}`, msg);
  }

  if (cmd === "/backup") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const sub = parts[1]?.toLowerCase();
    if (sub === "now") {
      const p = await backupMod.runBackup();
      return sendText(chatId, p ? `✅ Backup: \`${p}\`` : "❌ Backup gagal.", msg);
    }
    const list = backupMod.listBackups();
    if (!list.length) return sendText(chatId, "📭 Belum ada backup.", msg);
    return sendText(chatId, `💾 *Backups (${list.length}):*\n\n${list.map(b => `• ${b.name} (${b.sizeKb}KB)`).join("\n")}\n\n/backup now untuk run sekarang`, msg);
  }

  if (cmd === "/users") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const list = userProfiles.listProfiles(20);
    if (!list.length) return sendText(chatId, "📭 Belum ada user profile.", msg);
    const lines = list.map(u => `• *${u.display_name || u.user_jid.split("@")[0]}* (${u.message_count}) ${u.communication_style ? "— " + u.communication_style : ""}`);
    return sendText(chatId, `👥 *Users (${list.length}):*\n\n${lines.join("\n")}`, msg);
  }
  if (cmd === "/userprofile") {
    const target = argText.trim();
    let jid = target ? require("./bosses").normalizeJid(target) : senderJid;
    const p = userProfiles.getProfile(jid);
    if (!p) return sendText(chatId, `❌ Profile ${jid} gak ada.`, msg);
    return sendText(chatId, `👤 *${p.display_name || "?"}*\nJID: \`${p.user_jid}\`\nMsgs: ${p.message_count}\nStyle: ${p.communication_style || "?"}\nTraits: ${p.traits || "?"}\nMinat: ${p.interests || "?"}`, msg);
  }

  if (cmd === "/pii") {
    if (!argText) {
      const cur = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE pii_flags IS NOT NULL").get().c;
      return sendText(chatId, `🔐 *PII Detection*\n${cur} pesan ke-flag PII.\n\nFormat:\n/pii check <text> — test pattern\n/pii recent [N] — list pesan ke-flag terakhir`, msg);
    }
    const sub = parts[1]?.toLowerCase();
    if (sub === "check") {
      const t = argText.slice(5).trim();
      const findings = pii.detect(t);
      if (!findings.length) return sendText(chatId, "✅ Aman, gak ada PII.", msg);
      return sendText(chatId, `⚠️ *${findings.length} PII detected:*\n${findings.map(f => `• ${f.name} (${f.severity})`).join("\n")}`, msg);
    }
    if (sub === "recent") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const n = parseInt(parts[2], 10) || 10;
      const rows = db.prepare("SELECT chat_name, sender_name, text, pii_flags, timestamp FROM messages WHERE pii_flags IS NOT NULL ORDER BY id DESC LIMIT ?").all(n);
      if (!rows.length) return sendText(chatId, "📭 Gak ada PII flag.", msg);
      return sendText(chatId, `🔐 *PII recent (${rows.length}):*\n\n${rows.map(r => `${r.chat_name} · ${r.sender_name}: ${JSON.parse(r.pii_flags).map(f => f.name).join(",")}`).join("\n")}`, msg);
    }
    return sendText(chatId, "Format: /pii check <text> | recent", msg);
  }

  if (cmd === "/wf" || cmd === "/workflow" || cmd === "/workflows") {
    const sub = parts[1]?.toLowerCase();
    if (!sub || sub === "list") {
      const list = workflows.list(boss ? null : senderJid);
      if (!list.length) return sendText(chatId, "📭 Gak ada workflow. Boss bisa bikin via natural language atau /wf create", msg);
      return sendText(chatId, `🔄 *Workflows (${list.length}):*\n\n${list.map(w => `${w.status === "active" ? "🟢" : w.status === "pending_approval" ? "⏸️" : "🔴"} #${w.id} *${w.name}*\n  ${w.description?.slice(0, 80) || ""}\n  Trigger: ${w.trigger_type} | Runs: ${w.runs_count}`).join("\n\n")}`, msg);
    }
    if (sub === "approve") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const id = parseInt(parts[2], 10);
      return sendText(chatId, workflows.approve(id) ? `✅ Workflow #${id} approved + active.` : `❌`, msg);
    }
    if (sub === "reject") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const id = parseInt(parts[2], 10);
      return sendText(chatId, workflows.reject(id) ? `🚫 Workflow #${id} rejected.` : `❌`, msg);
    }
    if (sub === "pause") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const id = parseInt(parts[2], 10);
      return sendText(chatId, workflows.pauseWf(id) ? `⏸️ Paused.` : `❌`, msg);
    }
    if (sub === "resume") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const id = parseInt(parts[2], 10);
      return sendText(chatId, workflows.resumeWf(id) ? `▶️ Resumed.` : `❌`, msg);
    }
    if (sub === "delete" || sub === "del") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const id = parseInt(parts[2], 10);
      return sendText(chatId, workflows.deleteWf(id) ? `🗑️ Deleted.` : `❌`, msg);
    }
    return sendText(chatId, "Format: /wf list | approve <id> | reject <id> | pause <id> | resume <id> | delete <id>", msg);
  }

  if (cmd === "/plugins") {
    const list = plugins.list();
    if (!list.length) return sendText(chatId, "📭 Gak ada plugin loaded. Drop file .js ke `plugins/`.", msg);
    return sendText(chatId, `🔌 *Plugins (${list.length}):*\n\n${list.map(p => `• *${p.name}* (${p.file})${p.description ? "\n  " + p.description : ""}${p.commands?.length ? "\n  Commands: " + p.commands.join(", ") : ""}`).join("\n")}`, msg);
  }
  if (cmd === "/plugin-reload") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const loaded = plugins.load();
    return sendText(chatId, `🔌 Reloaded ${loaded.length} plugin.`, msg);
  }

  if (cmd === "/embedstatus") {
    const total = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE text IS NOT NULL AND length(text) > 10").get().c;
    const embedded = db.prepare("SELECT COUNT(*) AS c FROM embeddings").get().c;
    return sendText(chatId, `🧠 *Embeddings:*\nTotal msgs: ${total}\nEmbedded: ${embedded} (${total ? (embedded / total * 100).toFixed(1) : 0}%)\nPending: ${total - embedded}`, msg);
  }
  if (cmd === "/embed-backfill") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    await sendText(chatId, "⏳ Backfilling embeddings...", msg);
    const n = parseInt(argText, 10) || 100;
    const done = await embeddings.backfill(n);
    return sendText(chatId, `✅ Backfilled ${done} embeddings.`, msg);
  }

  if (cmd === "/effort") {
    const valid = ["low", "medium", "high", "xhigh", "max"];
    if (!argText) {
      const cur = getEffort(chatId) || "default";
      return sendText(chatId, `⚡ Effort: *${cur}*\n\nLevel valid: ${valid.join(", ")}\n\n_low_ = cepat & murah\n_medium_ = balance\n_high_ = lebih dalem (default Claude)\n_xhigh_ = ekstra dalem\n_max_ = paling deep, paling mahal/lambat\n\nGanti: /effort medium`, msg);
    }
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (!valid.includes(argText)) return sendText(chatId, `❌ Invalid: ${argText}. Valid: ${valid.join(", ")}`, msg);
    setEffort(chatId, argText);
    return sendText(chatId, `✅ Effort → *${argText}*`, msg);
  }

  if (cmd === "/health") {
    const dbSize = (fs.statSync(path.join(__dirname, "data", "wa.db")).size / 1024 / 1024).toFixed(2);
    const msgCount = db.prepare("SELECT COUNT(*) AS c FROM messages").get().c;
    const fileCount = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE media_path IS NOT NULL").get().c;
    const chatCount = db.prepare("SELECT COUNT(DISTINCT chat_id) AS c FROM messages").get().c;
    const profileCount = db.prepare("SELECT COUNT(*) AS c FROM group_profiles").get().c;
    const bossCount = listBosses().length;
    const sessCount = db.prepare("SELECT COUNT(*) AS c FROM chat_sessions").get().c;
    const uptimeH = (process.uptime() / 3600).toFixed(2);
    const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    const text =
      `💚 *HEALTH CHECK*\n\n` +
      `🤖 Bot uptime: ${uptimeH}h\n` +
      `💾 RAM: ${memMb}MB\n` +
      `🗄️ DB: ${dbSize}MB\n` +
      `💬 Messages: ${msgCount.toLocaleString()}\n` +
      `📎 Files: ${fileCount}\n` +
      `💼 Chats tracked: ${chatCount}\n` +
      `🗂️ Group profiles: ${profileCount}\n` +
      `🗨️ Claude sessions: ${sessCount}\n` +
      `👑 Bosses: ${bossCount}\n` +
      `🟢 WS: ${botJid ? "connected" : "disconnected"}\n` +
      `🎤 Voice: ${process.env.GROQ_API_KEY ? "🟢 Groq" : "🔴"}\n` +
      `🔒 Secret code: ${process.env.BOSS_SECRET_CODE ? "🟢 set" : "🔴"}\n` +
      `🧠 RAG: ✅ FTS5 enabled`;
    return sendText(chatId, text, msg);
  }

  if (cmd === "/send") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (!argText) return sendText(chatId, "Format: /send <path>", msg);
    let p = argText;
    if (!path.isAbsolute(p)) p = path.resolve(getCwd(chatId), p);
    if (!fs.existsSync(p)) return sendText(chatId, `❌ File gak ada: \`${p}\``, msg);
    await sendDocument(chatId, p, path.basename(p), "", msg);
    return true;
  }

  if (cmd === "/analyze") {
    if (!argText) return sendText(chatId, "Format: /analyze <path>", msg);
    let p = argText;
    if (!path.isAbsolute(p)) p = path.resolve(getCwd(chatId), p);
    if (!fs.existsSync(p)) return sendText(chatId, `❌ File gak ada: \`${p}\``, msg);
    const { analyzeFile } = require("./file_analyzer");
    const r = await analyzeFile(p);
    if (!r.ok) return sendText(chatId, `❌ ${r.error}`, msg);
    const metaStr = r.meta ? ` (${Object.entries(r.meta).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : v}`).join(", ")})` : "";
    return sendText(chatId, `📄 *Analyze ${path.basename(p)}*${metaStr}\nSize: ${r.sizeKb}KB | Extracted: ${r.length} chars\n\n*Preview:*\n\`\`\`\n${r.preview}\n\`\`\``, msg);
  }

  if (cmd === "/search") {
    if (!argText) return sendText(chatId, "Format: /search <keyword>\nMencari di SEMUA group/chat yang pernah dipantau bot.", msg);
    const matches = rag.searchAllMessages(argText, { limit: 15 });
    if (!matches.length) return sendText(chatId, `❌ Gak ada match "${argText}" di seluruh chat.`, msg);
    const lines = matches.map((m, i) => {
      const time = rag.fmtWIB(m.timestamp);
      const sender = m.from_me ? "[BOT]" : (m.sender_name || "?");
      const where = m.is_group ? `👥 ${m.chat_name}` : `👤 DM`;
      return `${i + 1}. [${time}] *${sender}* @ ${where}\n   ${(m.text || "(media)").slice(0, 150)}${m.media_filename ? "\n   📎 " + m.media_filename : ""}`;
    });
    return sendText(chatId, `🔎 *SEARCH "${argText}" (${matches.length} match)*\n\n${lines.join("\n\n")}`, msg);
  }

  if (cmd === "/topics") {
    const profiles = rag.getGroupProfiles(null, 30);
    if (!profiles.length) return sendText(chatId, "📭 Belum ada group profile. /profile-gen untuk generate sekarang.", msg);
    const lines = profiles.map((p, i) => `${i + 1}. *${p.chat_name}* (${p.message_count} msg)\n   📌 ${p.topic}\n   _${p.summary || ""}_`);
    return sendText(chatId, `🗂️ *KNOWN GROUPS (${profiles.length}):*\n\n${lines.join("\n\n")}`, msg);
  }

  if (cmd === "/profile") {
    const chatName = await getChatName(chatId);
    const p = db.prepare("SELECT * FROM group_profiles WHERE chat_id=?").get(chatId);
    if (!p) return sendText(chatId, `📭 Belum ada profile untuk "${chatName}". /profile-gen untuk generate.`, msg);
    return sendText(chatId, `🗂️ *${p.chat_name}*\n📌 Topik: ${p.topic}\n_${p.summary || ""}_\n\nMsg count: ${p.message_count}\nGenerated: ${p.last_generated_at}`, msg);
  }

  if (cmd === "/profile-gen") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const chatName = await getChatName(chatId);
    await sendText(chatId, `⏳ Generating profile untuk "${chatName}"...`, msg);
    try {
      const all = db.prepare("SELECT chat_id, chat_name, COUNT(*) AS msg_count, MAX(timestamp) AS last_msg_at FROM messages WHERE chat_id=? GROUP BY chat_id").get(chatId);
      if (!all || all.msg_count < 5) return sendText(chatId, `❌ Pesan terlalu sedikit (${all?.msg_count || 0}). Minimal 5.`, msg);
      const result = await generateProfileFor(all);
      if (!result) return sendText(chatId, "❌ Generate gagal.", msg);
      return sendText(chatId, `✅ *${chatName}*\n📌 ${result.topic}\n_${result.summary}_`, msg);
    } catch (err) {
      return sendText(chatId, `❌ ${err.message.slice(0, 200)}`, msg);
    }
  }

  if (cmd === "/files") {
    const chatName = await getChatName(chatId);
    const files = listChatFiles(chatName, 30);
    if (!files.length) return sendText(chatId, `📭 Belum ada file di chat "${chatName}".`, msg);
    const lines = files.map((f, i) => `${i + 1}. ${f.name} (${(f.size / 1024).toFixed(1)}KB)`);
    return sendText(chatId, `📎 *File di "${chatName}" (${files.length}):*\n\n${lines.join("\n")}\n\n_Path: data/files/${chatName}/_`, msg);
  }

  if (cmd === "/recent") {
    const n = Math.min(parseInt(argText, 10) || 15, 50);
    const msgs = getRecentMessages(chatId, n);
    if (!msgs.length) return sendText(chatId, "❌ Kosong.", msg);
    return sendText(chatId, `📋 *${n} pesan terakhir:*\n\n${msgs.map(m => `• *${m.sender_name || "?"}*: ${(m.text || "(media)").slice(0, 80)}`).join("\n")}`, msg);
  }

  if (cmd === "/kb") {
    const sub = (parts[1] || "").toLowerCase();
    if (sub === "add" || argText.includes("=")) {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const body = argText.replace(/^add\s+/i, "");
      const eq = body.indexOf("=");
      if (eq < 0) return sendText(chatId, 'Format: /kb add <judul> = <isi>\nContoh: /kb add Bagian Gudang = Tugas: terima barang, catat stok, cek kondisi.\nAtau /import file (reply dokumen) buat masukin SOP/handbook.', msg);
      const title = body.slice(0, eq).trim();
      const isi = body.slice(eq + 1).trim();
      const r = knowledge.importFromText({ text: isi, title, ownerJid: senderJid, chatId });
      return sendText(chatId, r ? `✅ KB: *${title}* tersimpan. Orang tinggal tanya, bot jawab dari sini.` : "❌ Gagal.", msg);
    }
    if (sub === "del") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const id = parseInt(argText.replace(/^del\s+/i, ""), 10);
      return sendText(chatId, knowledge.deleteImport(id) ? `🗑️ KB #${id} dihapus.` : `❌ #${id} gak ada.`, msg);
    }
    const list = knowledge.listImports(40);
    if (!list.length) return sendText(chatId, "🏢 KB perusahaan kosong.\nIsi: /kb add <judul> = <isi> · atau /import file (SOP/handbook) · atau ngomong ke bot \"catat: ...\".\nHabis itu siapa aja bisa tanya, bot jawab.", msg);
    const lines = list.map(k => `*#${k.id}* ${k.title} _(${k.source_type})_`);
    return sendText(chatId, `🏢 *KNOWLEDGE BASE PERUSAHAAN (${list.length})*\n\n${lines.join("\n")}\n\n_Tambah: /kb add <judul> = <isi> · Dokumen: /import file · Hapus: /kb del <id>_`, msg);
  }

  if (cmd === "/lessons") {
    const list = learning.listLessons(chatId, 30);
    if (!list.length) return sendText(chatId, "📚 Belum ada pelajaran. Bot belajar otomatis tiap lo koreksi (mis \"lain kali cari data X di Y\").", msg);
    const lines = list.map(l => `*#${l.id}* ${l.scope === "global" ? "🌐" : ""} ${l.lesson.slice(0, 120)}`);
    return sendText(chatId, `📚 *PELAJARAN (${list.length})*\n\n${lines.join("\n")}\n\n_Hapus: /lesson-del <id>_`, msg);
  }
  if (cmd === "/lesson-del") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const id = parseInt(argText, 10);
    if (!id) return sendText(chatId, "Format: /lesson-del <id> (liat /lessons)", msg);
    return sendText(chatId, learning.deleteLesson(id) ? `🗑️ Pelajaran #${id} dihapus.` : `❌ #${id} gak ada.`, msg);
  }
  if (cmd === "/facts") {
    const list = qaLearning.listFacts(chatId, 30);
    if (!list.length) return sendText(chatId, "📌 Belum ada fakta terpelajar. Bot otomatis nyerap dari tanya-jawab di grup (status + alasan).", msg);
    const lines = list.map(f => {
      const when = f.fact_ts ? new Date(f.fact_ts * 1000).toLocaleString("en-GB", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "?";
      return `*#${f.id}* ${f.subject}: ${f.status}${f.reason ? ` _(${f.reason})_` : ""} [${when}]`;
    });
    return sendText(chatId, `📌 *FAKTA TERPELAJAR (${list.length})*\n\n${lines.join("\n")}\n\n_Hapus: /fact-del <id>_`, msg);
  }
  if (cmd === "/fact-del") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    const id = parseInt(argText, 10);
    if (!id) return sendText(chatId, "Format: /fact-del <id> (liat /facts)", msg);
    return sendText(chatId, qaLearning.deleteFact(id) ? `🗑️ Fakta #${id} dihapus.` : `❌ #${id} gak ada.`, msg);
  }

  if (cmd === "/habits") {
    const habits = require("./habits");
    const sub = (parts[1] || "").toLowerCase();
    if (sub === "set" || argText.includes("=")) {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const body = argText.replace(/^set\s+/i, "");
      const eq = body.indexOf("=");
      if (eq < 0) return sendText(chatId, 'Format: /habits set "<topik>" = <nama grup>\nContoh: /habits set harga = gudang', msg);
      const topic = body.slice(0, eq).replace(/["']/g, "").trim();
      const grup = body.slice(eq + 1).trim();
      const r = habits.setRule(topic, grup);
      return sendText(chatId, r.error ? `❌ ${r.error}` : `✅ Pertanyaan soal *${r.topic}* → cari di *${r.group}*`, msg);
    }
    if (sub === "del") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const id = parseInt(argText.replace(/^del\s+/i, ""), 10);
      return sendText(chatId, habits.delHabit(id) ? `🗑️ Habit #${id} dihapus.` : `❌ #${id} gak ada.`, msg);
    }
    const list = habits.listHabits();
    if (!list.length) return sendText(chatId, '🎯 Belum ada habit.\nSet manual: /habits set "<topik>" = <grup>\nOtomatis: tanya + sebut grup (mis "lokasi kep di grup internal").', msg);
    const lines = list.map(h => { let t = []; try { t = JSON.parse(h.topic_tokens); } catch {} return `*#${h.id}* ${t.join(" ")} → *${h.target_chat_name || "?"}* (${h.hits}x)`; });
    return sendText(chatId, `🎯 *HABIT SUMBER (${list.length})*\n\n${lines.join("\n")}\n\n_Set: /habits set "<topik>" = <grup> · Hapus: /habits del <id>_`, msg);
  }
  if (cmd === "/senders" || cmd === "/who") {
    const rows = db.prepare("SELECT sender_name, sender_jid, COUNT(*) c, MAX(timestamp) t FROM messages WHERE from_me=0 GROUP BY sender_jid ORDER BY t DESC LIMIT 25").all();
    if (!rows.length) return sendText(chatId, "Belum ada pengirim terekam.", msg);
    const lines = rows.map(r => `• *${r.sender_name || "?"}* — ${(r.sender_jid || "").split("@")[0]} (${r.c} pesan)`);
    return sendText(chatId, `👥 *AKUN PENGIRIM (25 terbaru)*\n\n${lines.join("\n")}\n\n_Map julukan: /alias "kep Agus" = <nomor/nama>_`, msg);
  }
  if (cmd === "/alias") {
    const sub = (parts[1] || "").toLowerCase();
    if (sub === "del") {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const a = argText.replace(/^del\s+/i, "").trim();
      return sendText(chatId, aliases.deleteAlias(a) ? `🗑️ Alias "${a}" dihapus.` : `❌ "${a}" gak ada.`, msg);
    }
    if (sub === "add" || argText.includes("=")) {
      if (!boss) return sendText(chatId, "❌ Boss only.", msg);
      const body = argText.replace(/^add\s+/i, "");
      const eq = body.indexOf("=");
      if (eq < 0) return sendText(chatId, 'Format: /alias "kep Agus" = <nama akun / nomor>\nLiat akun: /senders', msg);
      const alias = body.slice(0, eq).replace(/["']/g, "").trim();
      const target = body.slice(eq + 1).trim();
      if (!alias || !target) return sendText(chatId, "Alias & target gak boleh kosong.", msg);
      const isNum = /^\d{6,}$/.test(target.replace(/\D/g, "")) && /^\+?\d[\d\s-]+$/.test(target);
      const r = aliases.setAlias(alias, isNum ? null : target, isNum ? target.replace(/\D/g, "") + "@s.whatsapp.net" : null);
      return sendText(chatId, r ? `✅ "${alias}" → ${target}\n_Sekarang tanya "posisi ${alias}" bakal nyambung ke akun itu._` : "❌ Gagal.", msg);
    }
    const list = aliases.listAliases();
    if (!list.length) return sendText(chatId, '🔗 Belum ada alias.\nMap julukan ke akun: /alias "kep Agus" = <nomor/nama>\nLiat akun: /senders', msg);
    const lines = list.map(a => `• *${a.alias}* → ${a.target_name || (a.target_jid || "").split("@")[0]}`);
    return sendText(chatId, `🔗 *ALIAS (${list.length})*\n\n${lines.join("\n")}\n\n_Tambah: /alias "julukan" = <nomor/nama> · Hapus: /alias del <julukan>_`, msg);
  }

  if (cmd === "/lokasi") {
    if (!argText) return sendText(chatId, "Format: /lokasi <nama orang>\nContoh: /lokasi kep johan", msg);
    const found = findPersonLocation(argText);
    if (found?.entry) {
      try { await sock.sendMessage(chatId, { forward: found.entry.msg }, { quoted: msg }); } catch (e) { console.error("fwd:", e.message); }
      const mins = Math.round((Date.now() / 1000 - found.entry.ts) / 60);
      return sendText(chatId, `📍 Lokasi *${found.entry.name}*${found.entry.isLive ? " (live)" : ""} — di-share ${mins < 60 ? mins + " menit" : Math.round(mins / 60) + " jam"} lalu.`, msg);
    }
    if (found?.dbRow) {
      await sendLocation(chatId, found.dbRow.lat, found.dbRow.lng, found.dbRow.sender_name, msg);
      return sendText(chatId, `📍 Lokasi terakhir *${found.dbRow.sender_name}* (yang dia share).`, msg);
    }
    return sendText(chatId, `📍 Belum ada share lokasi dari "${argText}".`, msg);
  }

  if (cmd === "/skills") {
    const list = skills.listSkills(50);
    if (!list.length) return sendText(chatId, "🛠️ Belum ada skill. Bot bikin sendiri pas ada prosedur berulang, atau ajarin: \"kalau aku minta X, lakuin langkah A,B,C\".", msg);
    const lines = list.map(s => `🛠️ *${s.name}* _(${s.uses}x)_${s.description ? `\n   ${s.description.slice(0, 80)}` : ""}`);
    return sendText(chatId, `🛠️ *SKILLS (${list.length})*\n\n${lines.join("\n")}\n\n_Detail: /skill <nama> · Hapus: /skill-del <nama>_`, msg);
  }
  if (cmd === "/skill") {
    if (!argText) return sendText(chatId, "Format: /skill <nama> (liat /skills)", msg);
    const s = skills.getSkill(argText);
    if (!s) return sendText(chatId, `❌ Skill "${argText}" gak ada.`, msg);
    return sendText(chatId, `🛠️ *${s.name}* _(dipakai ${s.uses}x)_\n📌 ${s.description || "-"}\n\n${s.content}`, msg);
  }
  if (cmd === "/skill-del") {
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    if (!argText) return sendText(chatId, "Format: /skill-del <nama>", msg);
    return sendText(chatId, skills.deleteSkill(argText) ? `🗑️ Skill "${argText}" dihapus.` : `❌ "${argText}" gak ada.`, msg);
  }

  if (cmd === "/voice") {
    const arg = argText.toLowerCase();
    const ready = tts.isAvailable();
    if (arg === "test") {
      if (!ready) return sendText(chatId, "❌ Model TTS belum di-download.\nJalankan: `node tts/supertonic/download-model.mjs`", msg);
      await sendText(chatId, "🔊 _tes synth..._", msg);
      try {
        const t0 = Date.now();
        const v = await tts.synthesize("Tes suara. Satu, dua, tiga. Kalau kamu dengar ini, voice note jalan.", { lang: "id" });
        if (!v) return sendText(chatId, "⚠️ synth return null (teks kosong?).", msg);
        await sendVoice(chatId, v.path, v.isOpus, msg);
        return sendText(chatId, `✅ TTS OK\nformat: ${v.isOpus ? "opus (voice note)" : "WAV (ffmpeg gak ada)"}\ndurasi: ${v.durationSec.toFixed(1)}s · ${((Date.now() - t0) / 1000).toFixed(1)}s synth`, msg);
      } catch (e) {
        return sendText(chatId, `❌ TTS GAGAL:\n\`${(e.message || String(e)).slice(0, 300)}\`\n\n_${(e.stack || "").split("\n").slice(1, 3).join(" | ").slice(0, 300)}_`, msg);
      }
    }
    if (arg !== "on" && arg !== "off") {
      const cur = getChatConfig(chatId).voice_mode ? "ON" : "OFF";
      return sendText(chatId, `🔊 Voice mode: *${cur}*${ready ? "" : "\n⚠️ Model TTS belum di-download (jalankan: node tts/supertonic/download-model.mjs)"}\n\n/voice on — semua balasan + voice note\n/voice off — teks aja\n_Voice note auto-aktif kalau lo kirim voice (walau mode off)._`, msg);
    }
    if (!boss) return sendText(chatId, "❌ Boss only.", msg);
    setChatConfig(chatId, { voice_mode: arg === "on" ? 1 : 0 });
    return sendText(chatId, `✅ Voice → *${arg.toUpperCase()}*${arg === "on" && !ready ? "\n⚠️ Model TTS belum di-download." : ""}`, msg);
  }

  return false;
}

async function processUserMessage(chatId, userText, quotedMsg, isGroup, senderJid = null, opts = {}) {
  const tracker = new ProgressTracker(chatId, quotedMsg, isGroup);
  let result = null;
  // Heuristic safety net: capture obvious teaching/correction even if the model doesn't self-flag.
  try {
    const corr = learning.detectCorrection(userText);
    if (corr) { learning.saveLesson(chatId, { topicKey: corr.topicKey, lesson: corr.lesson, source: userText }); console.log(`[LESSON] auto-captured from correction`); }
  } catch {}
  try {
    const context = getRecentMessages(chatId, 35);
    let lastThinkingAt = 0;
    result = await streamMessage(userText, chatId, context, isGroup, (evt) => {
      if (evt.type === "tool_use") tracker.addStep(evt.label).catch(() => {});
      else if (evt.type === "thinking") {
        const now = Date.now();
        if (now - lastThinkingAt > 5000) {
          lastThinkingAt = now;
          tracker.addStep("💭 thinking").catch(() => {});
        }
      }
    }, senderJid);
    await tracker.finalize(true);
  } catch (err) {
    console.error("processUserMessage:", err);
    await tracker.finalize(false);
    if (err.code === "BUDGET_EXCEEDED") {
      const b = err.budget;
      await sendText(chatId, `🚫 *Budget habis*\nLimit harian: $${b.daily_limit_usd.toFixed(2)}\nTerpakai hari ini: $${b.used_usd_today.toFixed(4)}\nReset jam 00:00.\n\nBoss bisa naikin via /budget set <jid> <usd>`, quotedMsg);
    } else {
      await sendText(chatId, `❌ Error: ${err.message.slice(0, 400)}`, quotedMsg);
    }
    return;
  }

  const chartUrls = extractChartUrls(result.text);
  for (const url of chartUrls) {
    await sendImage(chatId, url, "", quotedMsg);
  }

  const { cleaned: afterAttach, files: attachFiles } = extractAttachMarkers(result.text);
  for (const f of attachFiles) {
    console.log(`[ATTACH] sending file: ${f.path}`);
    await sendDocument(chatId, f.path, f.name, "", quotedMsg);
  }

  const { cleaned: afterLoc, locs: sendLocs } = extractLocationMarkers(afterAttach);
  for (const l of sendLocs) {
    console.log(`[LOC] sending pin: ${l.lat},${l.lng}`);
    await sendLocation(chatId, l.lat, l.lng, l.name, quotedMsg);
  }

  const { cleaned: afterLesson, count: lessonCount } = extractLessonMarkers(afterLoc, chatId);
  if (lessonCount) console.log(`[LESSON] saved ${lessonCount} from ${chatId}`);
  const { cleaned: afterKb, count: kbCount } = extractKbMarkers(afterLesson, senderJid, chatId);
  if (kbCount) console.log(`[KB] saved ${kbCount} company-knowledge entries`);
  const { cleaned: afterSkill, names: skillNames } = extractSkillMarkers(afterKb, chatId);
  if (skillNames.length) console.log(`[SKILL] saved: ${skillNames.join(", ")}`);

  const { cleaned: afterRemember, pattern: rememberPat } = buttonsMod.extractRememberPattern(afterSkill);
  const { cleaned: afterButtons, buttons } = buttonsMod.extractButtonMarker(afterRemember);

  if (buttons && buttons.length) {
    const choicesTxt = `${afterButtons || "Pilih opsi:"}\n\n${buttonsMod.formatChoicesText(buttons)}\n\n_Reply nomor atau ketik /pilih <n>_`;
    const r = await sendText(chatId, choicesTxt, quotedMsg);
    buttonsMod.recordPendingChoice({ chatId, ownerJid: senderJid, messageKey: r?.key, options: buttons, rememberPattern: rememberPat });
    return;
  }

  const clean = sanitizeMarkdown(afterButtons.replace(/https:\/\/quickchart\.io\/chart\/render\/[a-zA-Z0-9_-]+/g, "")).trim();
  if (!clean && chartUrls.length === 0 && attachFiles.length === 0) {
    await sendText(chatId, "_(jawaban kosong)_", quotedMsg);
    return;
  }
  if (!clean) return;

  const parts = splitLong(clean);
  const usedTools = tracker.steps.length > 0;
  const showMeta = !isGroup && (usedTools || result.duration > 5000 || (result.cost || 0) > 0.001);
  const eff = getEffort(chatId);
  const meta = showMeta
    ? `\n\n_${result.model}${eff ? "/" + eff : ""} · ${(result.duration / 1000).toFixed(1)}s · $${(result.cost || 0).toFixed(4)}_`
    : "";
  const cName = await getChatName(chatId).catch(() => chatId);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || !p.trim()) continue;
    const isLast = i === parts.length - 1;
    const sent = await sendText(chatId, isLast ? p + meta : p, quotedMsg);
    // Persist the bot's own reply so replies-to-bot are detectable + the bot remembers what it said.
    if (sent?.key?.id) {
      try {
        saveMessage({ chat_id: chatId, chat_name: cName, is_group: isGroup ? 1 : 0, sender_jid: botJid, sender_name: "BOT", message_id: sent.key.id, text: p, timestamp: Math.floor(Date.now() / 1000), from_me: 1 });
      } catch {}
    }
  }

  // Voice reply (mirror voice input OR /voice on) — ALWAYS alongside the text above.
  if (opts.voiceReply && clean) {
    try {
      if (!tts.isAvailable()) {
        console.warn("[TTS] model belum di-download — voice di-skip. Jalankan: node tts/supertonic/download-model.mjs");
      } else {
        const cfgV = getChatConfig(chatId);
        const ttsLang = cfgV.preferred_lang || (i18n.getLang(chatId) === "en" ? "en" : "id");
        await sock.sendPresenceUpdate("recording", chatId).catch(() => {});
        const v = await tts.synthesize(clean, { lang: ttsLang });
        if (v) await sendVoice(chatId, v.path, v.isOpus, quotedMsg);
      }
    } catch (e) {
      console.error("[TTS] synth:", e.message);
      await sendText(chatId, `⚠️ _voice gagal: ${(e.message || String(e)).slice(0, 160)}_`, quotedMsg).catch(() => {});
    }
    finally { await sock.sendPresenceUpdate("paused", chatId).catch(() => {}); }
  }
}

// Find a person's last shared location for "kep X dimana?" — prefer a cached (forwardable)
// message; else fall back to DB coords (fresh pin). Resolves nicknames via aliases.
function findPersonLocation(query) {
  const targets = aliases.expandTargets(query);                 // [target_name_keys..., jids...]
  for (const t of targets) if (/@/.test(t) && lastLocationMsg.has(t)) return { entry: lastLocationMsg.get(t) };
  const qn = aliases.norm(query);
  for (const [, e] of lastLocationMsg) {
    const nm = aliases.norm(e.name);
    if (nm && (qn.includes(nm) || targets.some(t => !/@/.test(t) && (nm.includes(t) || t.includes(nm))))) return { entry: e };
  }
  const row = locations.latestForName(query, null);
  return row ? { dbRow: row } : null;
}

// Caption present -> learn entity (caption authoritative). Captionless -> try to recognize a
// known object by visual features; returns a short inference tag to append to the description.
async function learnImageEntities(chatId, caption, visionDesc, imagePath, ts) {
  try {
    if (caption && caption.trim()) {
      const { entities: ents, location } = await entities.extractFromCaption(caption);
      for (const e of ents) {
        entities.upsertEntity(chatId, { name: e.name, kind: e.kind, features: visionDesc, location, ts, imagePath });
      }
      return null;
    }
    const m = entities.matchByFeatures(chatId, visionDesc);
    if (m) {
      entities.upsertEntity(chatId, { name: m.entity.name, kind: m.entity.kind, features: "", location: null, ts, imagePath });
      const loc = m.entity.last_location ? ` — terakhir di ${m.entity.last_location}` : "";
      return `\n[kemungkinan: ${m.entity.name}${loc}]`;
    }
    return null;
  } catch (err) { console.error("learnImageEntities:", err.message); return null; }
}

async function handleMessage(m) {
  try {
    const msg = m.messages?.[0];
    if (!msg || !msg.message) return;
    const chatIdRaw = msg.key.remoteJid;
    if (!chatIdRaw || chatIdRaw === "status@broadcast") return;
  const chatId = jidNormalizedUser(chatIdRaw);
  const fromMe = !!msg.key.fromMe;
  const isGroup = chatId.endsWith("@g.us");
  const senderRaw = isGroup ? (msg.key.participant || msg.participant) : chatIdRaw;
  const senderJid = senderRaw ? jidNormalizedUser(senderRaw) : null;
  const senderName = msg.pushName || (senderJid ? senderJid.split("@")[0] : "?");
  let text = extractText(msg.message);
  const quoted = extractQuoted(msg.message);
  const mentions = extractMentions(msg.message);
  const isVoice = isVoiceMessage(msg.message);
  const mediaType = detectMediaType(msg.message);
  const chatName = await getChatName(chatId);

  // Shared location (pin or live). Capture + attribute; silent unless bot is engaged.
  const locRaw = msg.message?.locationMessage || msg.message?.liveLocationMessage;
  if (locRaw && !fromMe && typeof locRaw.degreesLatitude === "number") {
    const isLive = !!msg.message?.liveLocationMessage;
    try {
      locations.saveLocation({
        chat_id: chatId, chat_name: chatName, sender_jid: senderJid, sender_name: senderName,
        lat: locRaw.degreesLatitude, lng: locRaw.degreesLongitude, place_name: locRaw.name || null,
        is_live: isLive ? 1 : 0, ts: msg.messageTimestamp
      });
      lastLocationMsg.set(senderJid, { msg, ts: msg.messageTimestamp, name: senderName, isLive });  // cache for forwarding
      console.log(`[LOC] ${senderName} ${isLive ? "live" : "pin"}: ${locRaw.degreesLatitude},${locRaw.degreesLongitude}`);
      await reactMsg(chatId, msg.key, "📍");
      saveMessage({
        chat_id: chatId, chat_name: chatName, is_group: isGroup ? 1 : 0, sender_jid: senderJid, sender_name: senderName,
        message_id: msg.key.id, text: `[${isLive ? "live location" : "lokasi"}] ${senderName} share lokasi${locRaw.name ? " " + locRaw.name : ""}`,
        timestamp: msg.messageTimestamp, from_me: 0
      });
    } catch (err) { console.error("location capture:", err.message); }
    if (!isMentionedBot(mentions, botJid) && !isReplyToBot(quoted)) return;  // silent unless engaged
    if (!text) text = `(${senderName} barusan share lokasi)`;
  }

  if (isVoice && !fromMe) {
    try {
      await sock.sendPresenceUpdate("composing", chatId);
      const transcript = await transcribeWhatsappVoice(msg, logger);
      if (transcript) {
        text = transcript;
        console.log(`[VOICE] ${senderJid}: "${text.slice(0, 80)}"`);
        await sendText(chatId, `🎤 _"${text}"_`, msg);
      }
    } catch (err) {
      console.error("voice err:", err.message);
      await sendText(chatId, `❌ Gagal transkrip voice: ${err.message.slice(0, 200)}`, msg);
      return;
    }
  }

  let mediaInfo = null;
  let fileOnlyMessage = false;
  if (mediaType && !fromMe) {
    const isImage = mediaType === "image";
    const isVideo = mediaType === "video";
    const isVisual = isImage || isVideo;
    const hasCaption = !!extractMediaMetaCaption(msg.message, mediaType);
    const mentionedBotEarly = isMentionedBot(mentions, botJid);
    const repliedBotEarly = isReplyToBot(quoted, botJid);
    const wantsAttention = isVisual
      ? (mentionedBotEarly || repliedBotEarly)
      : (hasCaption || mentionedBotEarly || repliedBotEarly);
    const silentVisual = isVisual && !wantsAttention;

    // Image → Gemini event extraction (structured events + summary). Video → Groq frames. No Claude tokens.
    const describeMedia = async () => {
      if (isImage) {
        // Groq-first event extraction (Timemark: reads GPS+time+place+handwritten label), Gemini fallback inside.
        try {
          const r = await trackingEvents.extractFromImage(mediaInfo.path, {
            caption: mediaInfo.caption, chatId, chatName, senderName, ts: msg.messageTimestamp
          });
          if (r && (r.summary || r.rawDesc)) return r.summary || r.rawDesc;
        } catch (e) { console.error("event extract:", e.message); }
        return vision.describeImage(mediaInfo.path, { mimetype: mediaInfo.mimetype, caption: mediaInfo.caption });
      }
      if (isVideo) return video.describeVideo(mediaInfo.path, { caption: mediaInfo.caption });
      return null;
    };

    if (silentVisual) {
      try {
        mediaInfo = await downloadAndSave(msg, chatName, mediaType, logger);
        if (mediaInfo) {
          console.log(`[MEDIA-SILENT] ${mediaType} saved: ${mediaInfo.filename} (${(mediaInfo.size / 1024).toFixed(1)}KB)${mediaInfo.caption ? " caption=\"" + mediaInfo.caption.slice(0, 40) + "\"" : ""}`);
          await reactMsg(chatId, msg.key, "💾");
          if (!text) text = mediaInfo.caption || `[${mediaType}: ${mediaInfo.filename}]`;
          if (process.env.GROQ_API_KEY) {
            (async () => {
              try {
                let desc = await describeMedia();
                if (desc) {
                  const annot = await learnImageEntities(chatId, mediaInfo.caption, desc, mediaInfo.path, msg.messageTimestamp);
                  if (annot) desc += annot;
                  mediaInfo.visionDesc = desc;
                  db.prepare("UPDATE messages SET vision_desc=? WHERE message_id=?").run(desc, msg.key.id);
                  console.log(`[VISION-SILENT] ${mediaInfo.filename}: ${desc.slice(0, 80)}`);
                }
              } catch (err) { console.error("silent vision:", err.message); }
            })();
          }
        }
      } catch (err) { console.error("silent media:", err.message); }
    } else {
      await sock.sendPresenceUpdate("composing", chatId).catch(() => {});
      const ackMsg = await sendText(chatId, `📥 _menerima file..._`, msg);
      try {
        mediaInfo = await downloadAndSave(msg, chatName, mediaType, logger);
      } catch (err) { console.error("media download:", err.message); }
      if (mediaInfo) {
        console.log(`[MEDIA] ${mediaType} from ${senderJid}: ${mediaInfo.filename} (${(mediaInfo.size / 1024).toFixed(1)}KB) → ${mediaInfo.path}`);
        const captionInfo = mediaInfo.caption ? ` — "${mediaInfo.caption}"` : "";
        if (!text) {
          text = mediaInfo.caption || `[${mediaType}: ${mediaInfo.filename}${captionInfo}]`;
          fileOnlyMessage = !mediaInfo.caption;
        }
        let summary = `📎 *${mediaInfo.filename}* (${(mediaInfo.size / 1024).toFixed(1)}KB)`;
        if (mediaInfo.extraction) {
          const meta = mediaInfo.extraction.meta || {};
          const metaBits = [];
          if (meta.pages) metaBits.push(`${meta.pages} halaman`);
          if (meta.sheets) metaBits.push(`${meta.sheets.length} sheet`);
          if (meta.slideCount) metaBits.push(`${meta.slideCount} slide`);
          if (meta.lines) metaBits.push(`${meta.lines} baris`);
          if (metaBits.length) summary += ` · ${metaBits.join(", ")}`;
          summary += `\n✅ Extract OK (${mediaInfo.extraction.length} char)`;
        } else if (isVisual && process.env.GROQ_API_KEY) {
          try {
            if (isVideo && ackMsg?.key) await editText(chatId, ackMsg.key, `${summary}\n🎬 _nonton video..._`);
            let desc = await describeMedia();
            if (desc) {
              const annot = await learnImageEntities(chatId, mediaInfo.caption, desc, mediaInfo.path, msg.messageTimestamp);
              if (annot) desc += annot;
              mediaInfo.visionDesc = desc;
              db.prepare("UPDATE messages SET vision_desc=? WHERE message_id=?").run(desc, msg.key.id);
              summary += `\n${isVideo ? "🎬" : "👁️"} ${desc.slice(0, 220)}`;
            }
          } catch (err) { console.error("vision desc:", err.message); }
        } else if (mediaType === "document") {
          summary += `\n⚠️ Format belum bisa di-extract auto`;
        }
        if (ackMsg?.key) await editText(chatId, ackMsg.key, summary);
        else await sendText(chatId, summary, msg);
      } else {
        if (ackMsg?.key) await editText(chatId, ackMsg.key, "❌ _gagal download file_");
      }
    }
  }

  console.log(`[MSG] ${isGroup ? "GROUP" : "DM"} chat=${chatId} sender=${senderJid} fromMe=${fromMe} boss=${isBoss(senderJid)} voice=${isVoice} media=${mediaType || "-"} text="${(text || "").slice(0, 60)}"`);

  if (!text && !quoted && !mediaInfo) return;

  if (fileOnlyMessage && mediaInfo) {
    text = `(User kirim file tanpa caption: "${mediaInfo.filename}" — PATH=${mediaInfo.path}) Tolong baca isi file ini (extracted preview ada di context), kasih ringkasan singkat 3-5 kalimat. Kalau tabular sebut struktur kolom. Tutup dengan: "Mau gw analisa lebih dalem, atau ada yang mau lo lakuin dengan file ini?"`;
  }

  const piiFindings = pii.detect(text);
  if (piiFindings.length) console.log(`[PII] ${senderJid} chat=${chatName}: ${piiFindings.map(f => f.name).join(",")}`);

  saveMessage({
    chat_id: chatId, chat_name: chatName, is_group: isGroup ? 1 : 0,
    sender_jid: senderJid, sender_name: senderName, message_id: msg.key.id,
    text, quoted_message_id: quoted?.id || null, quoted_text: quoted?.text || null,
    quoted_sender_jid: quoted?.sender || null, mentioned_jids: JSON.stringify(mentions),
    timestamp: msg.messageTimestamp, from_me: fromMe ? 1 : 0,
    media_path: mediaInfo?.path || null,
    media_filename: mediaInfo?.filename || null,
    media_mimetype: mediaInfo?.mimetype || null,
    media_caption: mediaInfo?.caption || null,
    pii_flags: piiFindings.length ? JSON.stringify(piiFindings.map(f => ({ name: f.name, severity: f.severity }))) : null,
    vision_desc: mediaInfo?.visionDesc || null
  });
  if (!fromMe) userProfiles.incrementActivity(senderJid, senderName);

  // Auto-learn alias from a self-introduction ("saya kep Agus" → this account = kep Agus).
  if (!fromMe && text && senderJid) {
    try {
      const intro = aliases.detectSelfIntro(text);
      if (intro) { aliases.setAlias(intro, senderName, senderJid); console.log(`[ALIAS] auto: "${intro}" = ${senderName} (${senderJid.split("@")[0]})`); }
    } catch {}
  }

  if (!fromMe && text && text.length >= 4 && !text.startsWith("/")) {
    try {
      const tr = await translate.maybeTranslateIncoming(chatId, text);
      if (tr && tr.text !== text) {
        await sendText(chatId, `🌐 _${tr.from}→${tr.to}_\n${tr.text}`, msg);
      }
    } catch (err) { console.error("auto translate:", err.message); }
  }

  if (fromMe) return;

  const chatCfg = getChatConfig(chatId);
  if (chatCfg.listen_only) return;

  const lastReply = lastReplyAt.get(chatId) || 0;
  if (Date.now() - lastReply < COOLDOWN_MS) return;

  const secretCode = process.env.BOSS_SECRET_CODE;
  if (secretCode && text.trim() === secretCode) {
    addBoss(senderJid, senderName);
    console.log(`👑 SECRET CODE used by ${senderJid}`);
    await sendText(chatId, `👑 Lo sekarang boss.\nJID: \`${senderJid}\`\n\nCoba: /help`, msg);
    lastReplyAt.set(chatId, Date.now());
    return;
  }

  const trimmed = text.trim();
  if (/^[1-6]$/.test(trimmed)) {
    const pending = buttonsMod.getLatestPending(chatId);
    if (pending) {
      const r = buttonsMod.resolveButtonReply(pending.id, trimmed);
      if (r) {
        await reactMsg(chatId, msg.key, "👉");
        lastReplyAt.set(chatId, Date.now());
        await enqueueOrRun(chatId, `(User pilih opsi: *${r.picked.label}* (id=${r.picked.id}))`, msg, isGroup, senderJid);
        return;
      }
    }
  }

  if (text.startsWith("/")) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    const pluginResult = await plugins.handleCommand(cmd, { chatId, senderJid, senderName, text, isGroup, msg, sock });
    if (pluginResult) {
      if (pluginResult.reply) await sendText(chatId, pluginResult.reply, msg);
      lastReplyAt.set(chatId, Date.now());
      return;
    }
    const handled = await handleCommand(chatId, senderJid, text, isGroup, msg);
    if (handled !== false) {
      audit.log({ chat_id: chatId, sender_jid: senderJid, sender_name: senderName, action: "command", target: cmd });
      lastReplyAt.set(chatId, Date.now());
      return;
    }
  }

  const mentioned = isMentionedBot(mentions, botJid);
  const repliedToBot = isReplyToBot(quoted, botJid);
  const senderIsBoss = isBoss(senderJid);

  const silentImageOnly = mediaType === "image" && mediaInfo && !mentioned && !repliedToBot;

  let shouldRespond = false;
  if (isGroup) {
    if (mentioned || repliedToBot) shouldRespond = true;
  } else {
    if ((senderIsBoss || chatCfg.auto_respond_dm) && !silentImageOnly) shouldRespond = true;
  }
  if (!shouldRespond) return;

  try {
    const triggerType = mediaInfo ? "file_in_chat" : "text_keyword";
    const activeWfs = workflows.getActiveByTrigger(chatId, triggerType);
    for (const wf of activeWfs) {
      const ctxWf = { text, media_filename: mediaInfo?.filename, sender_jid: senderJid };
      if (workflows.matchTriggerPattern(wf, ctxWf)) {
        console.log(`[WORKFLOW] firing #${wf.id} (${wf.name})`);
        const steps = JSON.parse(wf.steps_json || "[]");
        for (const step of steps) {
          try {
            if (step.type === "send_to_chat") {
              const promptText = (step.prompt || "Forward this:") + `\n\n${mediaInfo ? `File path: ${mediaInfo.path}\n` : ""}Content: ${(text || "").slice(0, 500)}`;
              await enqueueOrRun(step.chat_id, promptText, null, step.chat_id.endsWith("@g.us"));
            } else if (step.type === "analyze_file" && mediaInfo) {
              await sendText(chatId, `🔄 _Workflow #${wf.id} jalan: analyzing file_`, msg);
            }
          } catch (err) { console.error(`workflow step err:`, err.message); }
        }
        workflows.incrementRuns(wf.id);
        audit.log({ chat_id: chatId, sender_jid: senderJid, action: "workflow_fire", target: `#${wf.id}`, detail: wf.name });
      }
    }
  } catch (err) { console.error("workflow check:", err.message); }

  // "kep X dimana / posisi kep X" -> forward that person's shared location to the asker (not computed).
  if (text && !text.startsWith("/") && /\b(posisi|lokasi|di\s?mana|dimana|share\s?lok|lacak)\b/i.test(text)) {
    const found = findPersonLocation(text);
    if (found?.entry) {
      try {
        await sock.sendMessage(chatId, { forward: found.entry.msg }, { quoted: msg });
        const mins = Math.round((Date.now() / 1000 - found.entry.ts) / 60);
        await sendText(chatId, `📍 Lokasi *${found.entry.name}*${found.entry.isLive ? " (live)" : ""} — di-share ${mins < 60 ? mins + " menit" : Math.round(mins / 60) + " jam"} lalu.`, msg);
        await reactMsg(chatId, msg.key, "✅");
      } catch (e) { console.error("forward loc:", e.message); }
      return;
    }
    if (found?.dbRow) {
      await sendLocation(chatId, found.dbRow.lat, found.dbRow.lng, found.dbRow.sender_name, msg);
      await sendText(chatId, `📍 Lokasi terakhir *${found.dbRow.sender_name}* (yang dia share).`, msg);
      await reactMsg(chatId, msg.key, "✅");
      return;
    }
    // tidak ketemu -> lanjut ke Claude (boleh bilang gak ada / bantu hal lain)
  }

  lastReplyAt.set(chatId, Date.now());
  await reactMsg(chatId, msg.key, "⏳");
  await sock.sendPresenceUpdate("composing", chatId).catch(() => {});
  // Voice reply if user sent a voice note (mirror) OR /voice on for this chat.
  const voiceReply = isVoice || !!getChatConfig(chatId).voice_mode;
  try {
    await enqueueOrRun(chatId, text, msg, isGroup, senderJid, { voiceReply });
    await reactMsg(chatId, msg.key, "✅");
  } catch (err) {
    await reactMsg(chatId, msg.key, "❌");
    throw err;
  } finally {
    await sock.sendPresenceUpdate("paused", chatId).catch(() => {});
  }
  } catch (err) {
    console.error("[CRITICAL ERROR] handleMessage:", err);
  }
}

let reconnectAttempts = 0;
let qrShownOnce = false;
let isConnected = false;
let reconnecting = false;
const MAX_RECONNECT = 20;

function scheduleReconnect(reasonName, reason) {
  // Guard: stacked/dying sockets can emit multiple 'close' — only one reconnect in flight.
  if (reconnecting) return;
  reconnecting = true;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT) {
    console.log(`❌ Reconnect gagal ${MAX_RECONNECT}x berturut. Stop loop.`);
    console.log("   Cek koneksi internet, lalu restart bot (start.bat).");
    reconnecting = false;
    return;
  }
  const delay = Math.min(3000 * reconnectAttempts, 30000);
  console.log(`❌ Koneksi putus (${reasonName}/${reason}). Reconnect #${reconnectAttempts}/${MAX_RECONNECT} dalam ${delay / 1000}s...`);
  setTimeout(() => {
    reconnecting = false;
    start().catch(e => {
      console.error("reconnect fail:", e.message);
      scheduleReconnect("start-error", -1);
    });
  }, delay);
}

async function start() {
  // Cleanup previous socket so old listeners/keepalive timers don't stack (root cause of reconnect storms).
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.ws?.close(); } catch {}
    try { sock.end(undefined); } catch {}
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const hasAuth = !!state.creds?.registered;

  sock = makeWASocket({
    version, logger,
    // Cacheable signal key store: fewer "Bad MAC" / pending-key decryption failures.
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "120.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 25000,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 5,
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    // Lets Baileys answer decryption-retry requests so peers stop "Waiting for this message".
    getMessage: async (key) => {
      try {
        const row = db.prepare("SELECT text FROM messages WHERE message_id=?").get(key.id);
        if (row && row.text) return { conversation: row.text };
      } catch {}
      return undefined;
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrShownOnce = true;
      console.log("\n📱 SCAN QR INI DI WHATSAPP HP LO (cukup sekali):\n");
      qrcode.generate(qr, { small: true });
      console.log("\n   WhatsApp → Setelan → Perangkat Tertaut → Tautkan Perangkat → Scan QR di atas\n");
      console.log("   (Auth tersimpan permanen di data/auth — gak perlu scan lagi setelah ini)\n");
    }
    if (connection === "connecting") {
      console.log("🔌 Connecting ke WhatsApp...");
    }
    if (connection === "open") {
      isConnected = true;
      reconnecting = false;
      reconnectAttempts = 0;
      botJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
      botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;   // group mentions often use @lid
      console.log(`✅ TERHUBUNG: ${botJid || sock.user?.id}${botLid ? " (lid " + botLid + ")" : ""}`);
      console.log(`👑 Bosses: ${listBosses().length}`);
      console.log(`💬 Bot siap. Kirim pesan ke nomor bot dari HP lo.`);
    }
    if (connection === "close") {
      isConnected = false;
      const reason = lastDisconnect?.error?.output?.statusCode;
      const reasonName = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === reason) || "unknown";

      if (reason === DisconnectReason.loggedOut) {
        console.log("⚠️  LOGGED OUT dari WhatsApp. Auth invalid.");
        console.log("   Hapus folder data/auth lalu restart untuk scan QR baru.");
        return;
      }
      if (reason === DisconnectReason.connectionReplaced) {
        console.log("⚠️  Koneksi diambil alih device lain. Mungkin ada 2 instance jalan.");
        console.log("   Pastikan cuma 1 bot running. Stop yang lain dulu.");
        return;
      }
      // restartRequired (515): normal setelah pairing — reconnect cepat, jangan dihitung sebagai gagal.
      if (reason === DisconnectReason.restartRequired) {
        console.log("🔄 Restart required (normal pasca-pairing). Reconnect cepat...");
        if (reconnecting) return;
        reconnecting = true;
        setTimeout(() => { reconnecting = false; start().catch(e => console.error("restart fail:", e.message)); }, 1500);
        return;
      }

      scheduleReconnect(reasonName, reason);
    }
  });

  sock.ev.on("messages.upsert", (m) => {
    handleMessage(m).catch(err => console.error("handleMessage:", err.message));
  });

  // Keep group metadata cache fresh (helps decrypt group messages reliably).
  const refreshGroup = async (jid) => { try { if (jid) groupCache.set(jid, await sock.groupMetadata(jid)); } catch {} };
  sock.ev.on("groups.update", (us) => { for (const u of us || []) refreshGroup(u.id); });
  sock.ev.on("group-participants.update", (u) => refreshGroup(u.id));
  sock.ev.on("groups.upsert", (gs) => { for (const g of gs || []) { try { groupCache.set(g.id, g); } catch {} } });

  // Best-effort: live-location coordinate updates arrive as message updates. Attribute by JID.
  sock.ev.on("messages.update", (updates) => {
    for (const u of updates || []) {
      try {
        const live = u.update?.message?.liveLocationMessage;
        if (!live || typeof live.degreesLatitude !== "number") continue;
        const cid = jidNormalizedUser(u.key.remoteJid);
        const isG = cid.endsWith("@g.us");
        const sj = jidNormalizedUser(isG ? (u.key.participant || u.key.remoteJid) : u.key.remoteJid);
        const prev = locations.latestForJid(sj, cid);
        locations.saveLocation({
          chat_id: cid, chat_name: prev?.chat_name || "", sender_jid: sj, sender_name: prev?.sender_name || (sj ? sj.split("@")[0] : "?"),
          lat: live.degreesLatitude, lng: live.degreesLongitude, is_live: 1, ts: Math.floor(Date.now() / 1000)
        });
        console.log(`[LOC] live update ${sj}: ${live.degreesLatitude},${live.degreesLongitude}`);
      } catch {}
    }
  });
}

process.on("uncaughtException", (err) => {
  if (/Timed Out|Request Time-out|init queries|rate-overlimit|Connection Closed/i.test(err.message || "")) return;
  console.error("uncaughtException:", err.message);
});
process.on("unhandledRejection", (err) => {
  const m = err?.message || String(err);
  if (/Timed Out|Request Time-out|init queries|rate-overlimit|Connection Closed/i.test(m)) return;
  console.error("unhandledRejection:", m);
});

async function registerCommands() {
  if (!sock) return;
  // Placeholder — WhatsApp doesn't support bot commands menu like Telegram
}

(async () => {
  console.log("🚀 WhatsApp ↔ Claude Code Bridge v2");
  console.log(`Model default: ${DEFAULT_MODEL}`);
  console.log(`Permission: ${process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions"}`);
  console.log(`Default cwd: ${DEFAULT_CWD}`);
  console.log(`Voice: ${process.env.GROQ_API_KEY ? "🟢 Groq Whisper" : "🔴 GROQ_API_KEY missing"}`);
  console.log(`Secret code: ${process.env.BOSS_SECRET_CODE ? "🟢 set" : "🔴 not set"}`);
  const bossesNow = listBosses();
  console.log(`Bosses (${bossesNow.length}): ${bossesNow.map(b => b.jid).join(", ") || "(none)"}`);
  try { require("./admin/server"); }
  catch (err) { console.error("⚠️  Admin dashboard fail:", err.message); }

  try {
    const notify = require("./notify");
    updater.startUpdater(notify.sendNotification);
  } catch (err) { console.error("updater start:", err.message); }

  startProfileGenerator();
  qaLearning.startQaLearner();
  userProfiles.startUserProfileGenerator();
  backupMod.startBackupScheduler();
  plugins.load();
  if (process.env.EMBEDDINGS_ENABLED !== "0") embeddings.startEmbeddingsBackground();
  scheduler.startScheduler({
    onReminderDue: async (r) => {
      console.log(`[REMINDER] firing #${r.id} → ${r.target_chat_id}`);
      await sendText(r.target_chat_id, `⏰ *Reminder*\n${r.message}`, null);
      audit.log({ chat_id: r.target_chat_id, sender_jid: r.owner_jid, action: "reminder_fire", target: `#${r.id}` });
    },
    onCronDue: async (c) => {
      console.log(`[CRON] firing #${c.id} → ${c.target_chat_id}`);
      try {
        await enqueueOrRun(c.target_chat_id, `[CRON #${c.id}: ${c.name}] ${c.prompt}`, null, c.target_chat_id.endsWith("@g.us"));
        audit.log({ chat_id: c.target_chat_id, sender_jid: c.owner_jid, action: "cron_fire", target: `#${c.id}` });
      } catch (err) { console.error("cron err:", err.message); }
    }
  });
  await start();
})();
