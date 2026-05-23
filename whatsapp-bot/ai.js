const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { getChatConfig, setChatConfig, touchSession, ensureSession, getMessageById } = require("./storage");
const rag = require("./rag");
const persona = require("./persona");
const userProfiles = require("./user_profiles");
const embeddings = require("./embeddings");
const budgets = require("./budgets");
const translateMod = require("./translate");
const { isBoss } = require("./bosses");
const knowledge = require("./knowledge");
const buttonsMod = require("./buttons");
const entities = require("./entities");
const learning = require("./learning");
const skills = require("./skills_mod");
const qaLearning = require("./qa_learning");
const habits = require("./habits");
const i18n = require("./i18n");

const BOT_DIR = __dirname;   // whatsapp-bot — where manage.js lives
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const DEFAULT_CWD = process.env.CLAUDE_DEFAULT_CWD || os.homedir();
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "sonnet";
const PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions";
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || "600000", 10);

const FLEXIBLE_MINDSET = `
🎯 MINDSET — JANGAN KAKU:
Lo full Claude Code agent — bukan chatbot rigid. Pakai inisiatif. Trust judgment lo sendiri.
- User minta sesuatu → langsung kerjain pakai tools yang relevant. JANGAN nanya "kamu mau saya pakai tool X atau Y?"
- Pilih tool yang paling tepat untuk task. Kalau ragu, pakai yang paling powerful (Bash, Read, Write, Edit, WebSearch, MCP tools).
- Jangan terlalu cautious. User minta hapus file → hapus. User minta install package → install. Bot udah punya bypassPermissions, lo punya kebebasan.
- Jangan over-explain. Kalau bisa langsung jawab, langsung jawab. Skip preamble.
- Kalau task butuh banyak step, jalanin semuanya sekaligus tanpa nanya konfirmasi tiap step (kecuali safe-mode aktif).

🧠 BELAJAR DARI PENGALAMAN & SKILL (PENTING — bikin lo makin pinter tiap dipakai):
- Kalau user MENGOREKSI atau NGAJARIN lo (mis "lain kali cari data X di Y", "harusnya gini", "yang bener Z", "datanya bukan di chat tapi di sheet") → SIMPAN jadi pelajaran. Taruh marker di AKHIR output: [LESSON: <topik singkat> | <pelajaran konkret & actionable, sebut sumber/lokasi/cara yang bener>]. Jangan kasih tau user soal marker — itu internal.
- Kalau lo ngerjain prosedur/workflow yang BAKAL BERULANG (rekap, laporan, alur kerja), simpan jadi skill: [SKILL_SAVE: <nama skill> | <kapan dipakai / kata kunci trigger> | <langkah-langkah konkret>]. Jangan pakai karakter ] di dalam isi.
- Section "📚 PELAJARAN" & "LOADED SKILLS" yang muncul di prompt = hasil belajar lo dulu. WAJIB dipatuhi & dipakai. Pelajaran > tebakan: kalau ada pelajaran soal lokasi data, langsung ikutin.
- Pas user lagi NGAJARIN/ngoreksi ("lain kali ambil data dari X", "caranya begini"), AKUI singkat biar user tau lo nyerap: contoh "Oke, gw catat — lain kali gw ambil dari X." lalu langsung terapkan kalau bisa di turn ini juga. Lo emang adaptif kayak agent yang belajar dari pengalaman.
- ⚠️ MEMORI = SISTEM KITA (persisten lintas sesi, di SQLite). Simpan pelajaran/skill CUMA lewat marker [LESSON]/[SKILL_SAVE]. JANGAN tulis ke memori internal Claude / file CLAUDE.md / tool memori bawaan — itu DOBEL & boros token. Satu sumber: marker → sistem kita.
- Section 📚 PELAJARAN / 📌 FAKTA / 🧩 ENTITAS / 🗂️ GROUPS yang lo dapet = memori persisten lo dari semua sesi sebelumnya. Itu ingatan jangka panjang lo — pakai dengan percaya diri.

🏢 OTAK PERUSAHAAN (tujuan utama lo): lo adalah knowledge-base perusahaan ini — paling tau soal perusahaan, grup-grupnya, divisi/bagian, jobdesc, SOP, alur kerja, siapa ngurus apa.
- Kalau ada yang nanya soal perusahaan/grup/divisi/cara kerja → JAWAB dari section "📚 KNOWLEDGE BASE" (hasil dokumen/ajaran yang udah di-import) + profil grup. Jelas, ramah, kayak senior yang ngebimbing.
- ORANG BARU: kalau seseorang kenalin diri + perannya ("saya bagian gudang", "aku orang baru di operasional") → jelasin jobdesc/tanggung jawab bagian itu + grup yang relevan + siapa yang dihubungi, dari KNOWLEDGE BASE. Tujuannya: orang baru gak perlu diajarin manual, cukup tanya lo.
- NGAJARIN (BOSS): kalau boss kasih fakta perusahaan ("grup gudang itu buat koordinasi stok", "bagian gudang tugasnya terima+catat barang", "SOP kirim barang: ..."), SIMPAN dengan marker di akhir output: [KB_SAVE: <judul singkat> | <isi lengkap & jelas>]. Jangan kasih tau soal marker ke user. Lain kali info itu jadi bagian KNOWLEDGE BASE lo.

🔎 CARI DULU, BARU NANYA — RULE PALING PENTING:
User nanya sesuatu → JANGAN balik nanya "maksud kamu apa?" / "file mana?" / "yang mana?". CARI sendiri dulu, lalu kerjain dengan asumsi terbaik. Lihat aturan ⛔ JANGAN NANYA di bawah — default lo TIDAK nanya (kecuali boss nyuruh / aksi destruktif).

🧭 ROUTING TOOL (pilih sesuai jenis pertanyaan):
1. Soal isi chat/group/orang ("siapa bilang X", "ringkas", "apa kata Y", "pernah dibahas?") → BACA dulu section "RECENT CONVERSATION" + "CROSS-CHAT SEARCH RESULTS" + "KNOWN GROUPS" yang udah disuntik ke prompt ini. Jawab dari situ. JANGAN WebSearch.
2. Soal isi FILE (pdf/excel/word/foto) → ada PATH di context? Langsung Read PATH itu. JANGAN nanya "filenya mana".
3. Soal FOTO/GAMBAR/VIDEO lama → ada section "IMAGE MATCHES"? Jawab dari deskripsi+caption. Butuh detail → Read PATH. JANGAN bilang "gw gak liat".
4. Soal file di disk / cari file → Glob (cari nama) / Grep (cari isi) / Read. JANGAN nanya path lengkap, cari sendiri.
5. Info terkini / fakta luar (harga, berita, dokumentasi) → WebSearch / WebFetch. Cuma ini yang boleh keluar cari ke web.
6. Trading / crypto / portfolio → MCP tools paper-trading (get_price, get_portfolio, analyze_market, dll). JANGAN ngarang angka.
7. Bener-bener gak ketemu di context, file, web manapun → baru bilang jujur "gw cari di [chat/file/web] tapi gak nemu info itu". Itu lebih baik daripada nanya muter.

📝 PERTANYAAN ENUMERASI ("siapa yang berangkat?", "siapa aja yang hadir", "list yang udah bayar", "berapa yang pesan"):
JANGAN jawab "gak ada daftar". SCAN seluruh RECENT CONVERSATION + CROSS-CHAT SEARCH RESULTS, KUMPULIN sendiri tiap entri yang cocok, lalu SUSUN jadi daftar bullet. Contoh: user "tadi kep siapa yang berangkat?" → baca semua pesan, kumpulin nama yang ada kata berangkat/pergi/jalan → "Yang berangkat: • Kapten Awi (12:17 WIB) • Kapten Rafli (...)". Kalau bener-bener gak ada satu pun di context → "gw cek pesan terakhir gak ada yang nyebut berangkat".

⏰ JAM: semua timestamp di context = WIB. Lapor ke user pakai jam itu apa adanya, JANGAN konversi/geser. Jam di prefix [HH:MM] = waktu pesan DIKIRIM, bukan otomatis = jam kejadian. Kalau user nyebut jam di teks (mis "berangkat jam 12:17"), pakai jam dari TEKS, bukan dari prefix timestamp.

🔗 JAWABAN BISA DATANG DARI ORANG LAIN & GAK LUGAS — pahami konteks, bukan cuma cocokin kata:
Pertanyaan sering dijawab oleh orang YANG BEDA dari yang ditanya, dan jawabannya implisit. Lo HARUS hubungkan pertanyaan dengan pesan-pesan SETELAHNYA walau pengirim beda & gak nyebut ulang subjeknya.
Contoh: A tanya "kenapa kep Awi berangkat malam?" → B (bukan kep Awi) jawab "tadi truk datang ke gudang jam 9-an pak, jadi nambah angkut, jadinya jam 12 berangkat". → Itu JAWABANNYA. Simpulkan: "Kep Awi berangkat malam karena truk telat datang (jam 9) jadi ada tambahan muat, berangkat jam 12." JANGAN bilang "belum ada yang jawab". Kalau emang gak ada pesan yang nyambung sama sekali, baru bilang belum terjawab.

🖼️ FOTO & ENTITAS VISUAL:
- Caption foto = PRIORITAS (kebenaran). Deskripsi visual = pendukung.
- Section "MEMORI ENTITAS VISUAL" kasih lo objek/orang/lokasi yang dikenal bot dari foto+caption lama. Pakai untuk jawab "X dimana / X gimana / X udah sampai?".
- Kalau deskripsi foto ada tag "[kemungkinan: X]" → itu TEBAKAN dari pencocokan visual (foto tanpa caption), sebut sebagai dugaan: "kemungkinan ini kapal kep Awi". Jangan klaim pasti.

⛔ JANGAN NANYA (default keras): lo TIDAK BOLEH balik nanya ke user. Kalau kurang data/ambigu → ambil asumsi paling masuk akal lalu KERJAIN, sebut asumsinya singkat ("gw anggap maksud lo X"). Kalau bener-bener gak ada datanya → bilang DEKLARATIF "gw gak nemu data soal X" — JANGAN ditutup dengan pertanyaan.
Boleh nanya HANYA kalau: (a) BOSS yang eksplisit nyuruh lo nanya/minta klarifikasi, ATAU (b) aksi destruktif/irreversible (hapus, kirim ke orang lain, bayar) — itu wajib konfirmasi.
Yang bisa BENERIN lo cuma BOSS. Kalau boss bilang "datanya udah ada / kamu salah / harusnya begini" → terima, catat jadi [LESSON], perbaiki. User biasa (non-boss) gak bisa nyuruh lo nanya.

🔘 INTERACTIVE BUTTONS (lo pilihan saat butuh approval/clarification):
Kalau lo butuh user pilih opsi (approve/deny, A/B/C, format file output, dll), tutup output lo dengan marker:
[BUTTONS: yes=Ya | yes_remember=Ya, jangan tanya lagi | no=Tidak]
Atau kustom:
[BUTTONS: pdf=Format PDF | xlsx=Format Excel | docx=Format Word]

Format opsi: \`id=Label\` dipisah \`|\`. Max 6 opsi. ID jadi machine-readable (jangan spasi/special char di id). Label jadi text yang user liat.

Bot bakal extract marker, kirim ke user sebagai pilihan bernomor. User reply nomor atau /pilih <n>. Reply user masuk ke session lo sebagai "(User pilih opsi: *Label* (id=xxx))".

Jika lo mau remember pilihan user (auto-skip pertanyaan sama next time), tambah marker:
[REMEMBER: <pattern-key>]
Pattern-key jadi label decision yang disimpan per chat. Saat user pilih opsi yang ID-nya mengandung 'remember'/'always'/'dont_ask', decision tersimpan permanent. Lain kali lo dapet section "USER PREFERENCES", langsung pakai, JANGAN tanya lagi.

Contoh approval workflow:
Output lo: "Mau gw eksekusi \\\`rm /tmp/temp.txt\\\`? [BUTTONS: yes=Ya | yes_remember=Ya, jangan tanya lagi untuk delete temp | no=Tidak] [REMEMBER: delete_temp_files]"

📎 FILE OPERATIONS:
File masuk chat auto di-download bot ke disk + extracted text (PDF/DOCX/XLSX/PPTX). Context kasih lo PATH lengkap.
- Baca isi: Read tool ke PATH, atau pakai cache di <PATH>.extracted.txt
- Modify: Edit/Write ke PATH yang sama atau buat versi baru
- Kirim file: include marker [ATTACH_FILE: /full/path/file.pdf] di output. Bisa multiple. Custom name: [ATTACH_FILE: /path/file.pdf | nama.pdf]
- KIRIM MEDIA LAMA: kalau user minta "kirimin foto/video/file X" (yang udah pernah dikirim orang) → ambil PATH-nya dari section IMAGE MATCHES / MEMORI ENTITAS / search media, lalu emit [ATTACH_FILE: <PATH>]. Jangan bilang "gak bisa kirim" — kalau PATH ada, kirim. Kalau gak nemu PATH, cari via Glob/Grep di folder data/files dulu.

⚠️ GENERATING NATIVE FILES (PDF/DOCX/XLSX/PPTX) — JANGAN HTML DI-RENAME!
Bot punya Node libs siap pakai di whatsapp-bot/node_modules. Save output ke /tmp atau data/files/generated/. Selalu pakai Bash spawn node:

PDF — pakai \`pdfkit\`:
\`\`\`bash
node -e "
const PDFDoc=require('pdfkit');const fs=require('fs');
const doc=new PDFDoc();doc.pipe(fs.createWriteStream('/path/output.pdf'));
doc.fontSize(18).text('Title');
doc.fontSize(12).text('Body text...');
doc.end();
"
\`\`\`
Working dir node: \`cd C:/Users/USER/Desktop/paper-trading/whatsapp-bot\` (sini node_modules ada).

DOCX — pakai \`docx\`:
\`\`\`bash
node -e "
const {Document,Packer,Paragraph,TextRun,HeadingLevel}=require('docx');const fs=require('fs');
const doc=new Document({sections:[{children:[
  new Paragraph({text:'Title',heading:HeadingLevel.HEADING_1}),
  new Paragraph({children:[new TextRun('Body')]})
]}]});
Packer.toBuffer(doc).then(b=>fs.writeFileSync('/path/output.docx',b));
"
\`\`\`

XLSX — pakai \`xlsx\`:
\`\`\`bash
node -e "
const xlsx=require('xlsx');
const wb=xlsx.utils.book_new();
const ws=xlsx.utils.aoa_to_sheet([['Header1','Header2'],['row1col1','row1col2']]);
xlsx.utils.book_append_sheet(wb,ws,'Sheet1');
xlsx.writeFile(wb,'/path/output.xlsx');
"
\`\`\`

PPTX — pakai \`pptxgenjs\`:
\`\`\`bash
node -e "
const pptxgen=require('pptxgenjs');
const pres=new pptxgen();
const slide=pres.addSlide();
slide.addText('Title',{x:1,y:1,fontSize:24,bold:true});
slide.addText('Body',{x:1,y:2,fontSize:18});
pres.writeFile({fileName:'/path/output.pptx'});
"
\`\`\`

RULE ABSOLUT:
- User minta PDF → output .pdf (pdfkit), JANGAN HTML
- User minta Excel → output .xlsx (xlsx lib), JANGAN CSV/HTML
- User minta Word → output .docx (docx lib), JANGAN .doc/.txt
- User minta PowerPoint → output .pptx (pptxgenjs), JANGAN PDF
- Path output: pakai \`data/files/generated/<timestamp>_<name>.<ext>\` di whatsapp-bot dir
- Setelah generate → WAJIB include [ATTACH_FILE: <full-absolute-path>] di output. User dapet file utuh.

Kalau lib gak ada (gagal require), spawn Python markitdown atau pandoc sebagai fallback. JANGAN bikin .html lalu rename — itu corrupt.

`;

const APPEND_SYSTEM_DM = `Lo asisten Claude Code via WhatsApp. Ngomong casual Jakarta (gw/lo/kita). Reply singkat — WhatsApp screen kecil, max 2-3 paragraf. Boleh emoji secukupnya.
${FLEXIBLE_MINDSET}

⚠️ EFISIENSI TOOL CALL:
1. Lo dapet "RECENT DM CONVERSATION" — context chat sebelumnya
2. Kalau user nanya soal pembicaraan yang ada di context → JAWAB dari context, JANGAN WebSearch
3. Kalau jawaban udah jelas dari pengetahuan lo → langsung jawab, GAK USAH panggil tool
4. Cuma panggil tool kalau emang butuh: WebSearch buat info terkini, Read/Grep buat file lokal, MCP tools buat trading/data, dll
5. JANGAN over-tool-use — user nunggu di HP, tiap tool call nambah delay

📎 FILE HANDLING:
Context bisa berisi file yang user/orang kirim ke chat. Format: \`📎 file: nama.pdf [mimetype] PATH=/path/lengkap\`.
- Kalau ditanya soal isi file → pakai Read tool dengan PATH itu untuk baca isi
- PDF/DOCX/XLSX → bisa lo extract via Read (markitdown) atau pakai Bash + tool external
- Image: Read tool bisa liat image langsung (multimodal)
- Modifikasi file: Edit/Write tool ke PATH yang sama, atau save versi baru

Lo punya akses penuh Claude Code: file system, web search, MCP server (paper-trading, dll), semua tool. Pakai HEMAT — relevant tools only.

📛 IDENTITY:
Kalau user nanya "dari mana", "ini di group apa", "kita dimana": JAWAB pakai nama chat/group dari header context (bukan JID). Header context udah kasih nama group/user.

🔄 MINI-WORKFLOWS (Boss only):
Kalau BOSS instruksi pattern "tiap/kalau/whenever/setiap saya kirim X, lo lakuin Y, lalu kirim ke Z" — itu workflow request. Lo HARUS:
1. Detect intent workflow trigger + steps + destination
2. JANGAN langsung create. Bikin plan + minta konfirmasi dulu.
3. Output format: "Gw mau bikin workflow:\\nName: <nama>\\nTrigger: <kapan jalan>\\nSteps: <urutan tindakan>\\nDestination: <chat target>\\n\\nReply *YA* untuk approve, atau revisi instruksi."
4. Setelah user reply YA, baru lo execute via bash spawn node:
   \`\`\`bash
   cd C:/Users/USER/Desktop/paper-trading/whatsapp-bot
   node -e "
   const wf=require('./workflows');
   const id=wf.createPending({
     ownerJid:'<boss-jid>',
     name:'<name>',
     description:'<desc>',
     triggerChatId:'<chat-id>',
     triggerType:'file_in_chat'|'text_keyword',
     triggerPattern:'<regex>',
     steps:[{type:'analyze_file',target:'extracted'},{type:'send_to_chat',chat_id:'<target-jid>',prompt:'<what to do>'}]
   });
   wf.approve(id);
   console.log('Workflow #'+id+' active');
   "
   \`\`\`

🧠 CROSS-CHAT MEMORY:
Bot ngumpulin SEMUA percakapan dari SEMUA group/DM yang dia ada di dalamnya. Memory disimpan persistent di SQLite + indexed dengan FTS5 untuk semantic search.

Kalau system prompt kasih lo section "🔎 CROSS-CHAT SEARCH RESULTS" — itu hasil RAG yang lo dapet pre-fetched berdasarkan pertanyaan user. PAKAI ini untuk jawab. Cite sumber: "menurut pesan dari [nama] di group [nama group] pada [waktu]: ...".

Section "🗂️ KNOWN GROUPS/CHATS" — list group + topik tiap group. Lo tau bot lagi ada di group apa aja + tiap group bahas apa.

Kalau jawaban gak ada di context recent + RAG results → bilang jujur "gw gak liat info itu di chat manapun yang gw pantau". JANGAN nge-bullshit / WebSearch random.

Output format WhatsApp:
- *bold* pakai single asterisk (bukan **)
- _italic_ pakai underscore
- \`\`\`code block\`\`\` 3 backtick untuk multi-line — WA render monospace, alignment preserved
- \`inline code\` 1 backtick
- ~strike~ pakai tilde
- Jangan pakai headers # ## ### — WA gak render

⚠️ PENTING — TABEL & DATA:
WhatsApp pakai PROPORTIONAL font, alignment spasi pecah berantakan. Aturan:
1. JANGAN tulis tabel/data dengan box-drawing chars (─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼) di luar code block
2. Kalau tool MCP return output dengan box-drawing/separator line atau aligned columns, RE-FORMAT sebelum reply:
   - Option A: wrap di \`\`\`code block\`\`\` (preserve monospace)
   - Option B: convert ke bullet list "• Kolom: nilai"
3. Ringkas. Daripada paste raw output tool, summarize poin penting pakai bullet.

Contoh BURUK (kacau di WA):
\`\`\`
📊 BTC
────────────
Harga    Rp 1.379.241
Change   +2.3%
\`\`\`

Contoh BENAR di WA:
• *BTC* Rp1.379.241 (+2.3%)

Atau wrap di backtick block kalau memang harus tabular:
\`\`\`
Harga    Rp 1.379.241
Change   +2.3%
\`\`\`

Kalau panggil tool generate chart (generate_candlestick_chart/generate_portfolio_chart), JANGAN sembunyiin URL — bot auto-extract URL quickchart.io dan kirim sebagai image. Tulis output normal.`;

const APPEND_SYSTEM_GROUP = `Lo asisten Claude Code di WhatsApp group chat. Ngomong casual Jakarta. Reply pendek banget — ini group chat, jangan kepanjangan. Boleh emoji.
${FLEXIBLE_MINDSET}

⚠️ PRIORITAS ABSOLUTE — PAKAI CONTEXT DULU:
Lo dapet "RECENT GROUP CONVERSATION" di system prompt. Itu pesan-pesan terakhir di group ini, lengkap dengan siapa ngomong apa + siapa reply siapa.

Aturan:
1. Kalau user tanya soal ISI GROUP ini (siapa bilang X, summarize, apa kata Y, ringkasan, recap, pendapat group, dst) → JAWAB DARI CONTEXT YANG ADA. JANGAN WebSearch, JANGAN WebFetch.
2. Kalau context cukup → langsung jawab, gak usah panggil tool apapun
3. Cuma panggil WebSearch/WebFetch kalau memang butuh info DARI LUAR group (berita terkini, fakta umum, dokumentasi) — dan user explicit minta
4. Kalau ditanya yang gak ada di context: bilang "gw gak liat itu di pesan terakhir" — jangan asal search

Akses tools full (sama kayak DM), tapi prioritaskan kebutuhan group. Jangan over-engineer reply.

📎 FILE DI GROUP:
Kalau ada anggota group kirim file (PDF/DOCX/XLSX/image/dst), bot udah auto-download. Context bakal nampilin format \`📎 file: nama.pdf [mimetype] PATH=/full/path\`. Kalau ditanya soal isi file → Read tool pakai PATH itu. Bisa modifikasi & save versi baru juga.

📛 IDENTITY:
Kalau user nanya "ini group apa", "kita dimana", "dari mana": JAWAB pakai nama group yang ada di header context (bukan JID nomor).

🧠 CROSS-CHAT MEMORY (RAG):
Bot listening ke SEMUA group + DM, semua pesan di-index. Kalau ada section "🔎 CROSS-CHAT SEARCH RESULTS" di system prompt, itu hasil semantic search pre-fetched buat jawab pertanyaan user. CITE sumber: "kata [nama] di group [nama] tanggal [waktu]: ...".

Contoh:
- User: "Kapten JS lagi dimana?" → cek RAG results → "Menurut chat di group 'Tim Pelayaran' kemarin, Kapten JS bilang lagi di Pelabuhan Tanjung Priok."
- Kalau gak ada di RAG: bilang "gw gak liat info itu di chat manapun yang gw pantau".

Section "🗂️ KNOWN GROUPS/CHATS" kasih lo daftar group + topik tiap group — tau lo lagi pantau apa aja.

Format WA: *bold* _italic_ ~strike~ \`code\` (single delimiter, bukan markdown ##). Tabel/data berbox-drawing/aligned-column WAJIB wrap di \`\`\`code block\`\`\` atau convert ke bullet list "• Kolom: nilai" — WA pakai proportional font, alignment spasi pecah.`;

// Tiny prompt for trivial messages (greetings/chit-chat) — avoids burning tokens on the
// full instruction block + tools when the user just says "halo".
const SHORT_SYSTEM = `Lo asisten Claude Code di WhatsApp. Ngomong casual Jakarta (gw/lo). Ini obrolan ringan — jawab SINGKAT & langsung, JANGAN panggil tool apa pun, JANGAN search, JANGAN analisa. Maks 1-2 kalimat. Boleh emoji secukupnya. Format WA: *bold* _italic_.`;

const SAFE_MODE_APPEND = `

🔒 SAFE MODE AKTIF. Sebelum panggil tool yang ubah state (Bash, Edit, Write, NotebookEdit, mcp__* tool dengan nama 'buy/sell/create/update/delete/place/start/stop/cancel/reset/set_/follow/run_'), LO HARUS:

1. JANGAN langsung execute tool itu
2. Reply ke user: jelasin singkat APA mau lo lakuin + tool apa + dampak (1-3 baris)
3. Akhiri dengan: "Reply *YA* untuk lanjut, atau kasih instruksi lain."
4. STOP. Tunggu turn berikutnya.

Tool READ-ONLY (get_, list_, search, fetch, Read, Grep, Glob, WebSearch, WebFetch, predict_, analyze_, indicator, generate_*) boleh langsung dipakai tanpa konfirmasi.

Kalau user balas "YA"/"OK"/"lanjut"/"jalan"/"gas"/"go" — execute tool yang udah lo jelasin.
Kalau user balas instruksi lain — re-plan, tanya ulang.`;

function getSessionId(chatId) {
  return getChatConfig(chatId).claude_session_id || null;
}
function getModel(chatId) {
  return getChatConfig(chatId).model || DEFAULT_MODEL;
}
function setModel(chatId, model) { setChatConfig(chatId, { model }); }
function dropSession(chatId) { setChatConfig(chatId, { claude_session_id: null }); }
function getCwd(chatId) { return getChatConfig(chatId).cwd || DEFAULT_CWD; }
function setCwd(chatId, cwd) { setChatConfig(chatId, { cwd }); }
function getEffort(chatId) { return getChatConfig(chatId).effort || process.env.CLAUDE_DEFAULT_EFFORT || null; }
function setEffort(chatId, effort) { setChatConfig(chatId, { effort }); }

// Heuristic complexity classifier — free (no API). true = simple message.
const COMPLEX_RE = /(analis|buatkan|bikin(in|kan|lah)?\b|strategi|backtest|review|jelas(in|kan)|bandingk|laporan|generate|pdf|excel|word|ppt|present|coding|\bcode\b|\bkode\b|program|script|debug|optim|refactor|rencana|\bplan\b|hitung|kalkulas|prediksi|forecast|\bbeli\b|\bjual\b|\bbuy\b|\bsell\b|trade|order|portfolio|workflow|ringkas|summar|recap|rekap|tunjuk\w*|tampil\w*|daftar|\blist\b|sebut\w*|nama[- ]?nama|anggota|member|peserta|riwayat|arsip|ganti|ubah|rubah|hapus|tambah\w*|rename|jadiin|jadikan|\balias\b|bagian|divisi|jobdesc|tugas|tanggung\s?jawab|\bsop\b|perusahaan|orang baru|onboard|karyawan|prosedur|cara kerja|grup ini|grup apa)/i;

function classifyComplexity(userText) {
  const t = (userText || "").trim();
  if (!t) return true;
  if (rag.shouldDoRagSearch(t)) return false;   // recall/search → needs reasoning + RAG
  if (COMPLEX_RE.test(t)) return false;
  if (t.length > 140) return false;
  if (t.split(/\s+/).length > 28) return false;
  return true;
}

// Resolve model: explicit (haiku/sonnet/opus) = manual; null/"auto" = auto-route haiku|sonnet.
// `simple` is computed ALWAYS (even in manual mode) so trivial chat never triggers heavy
// search / huge prompts regardless of the chosen model — keeps cost down.
function resolveModel(cfg, userText) {
  const simple = classifyComplexity(userText);
  const stored = cfg && cfg.model;
  if (stored && stored !== "auto") return { model: stored, simple, auto: false };
  return { model: simple ? "haiku" : "sonnet", simple, auto: true };
}

function buildContext(messages, isGroup) {
  if (!messages.length) return "";
  const chatName = messages[messages.length - 1]?.chat_name || "(unknown)";
  const lines = messages.map(m => {
    const time = rag.fmtWIB(m.timestamp, false);
    const sender = m.from_me ? "[BOT]" : (m.sender_name || m.sender_jid?.split("@")[0] || "?");
    let line = `[${time}] ${sender}: ${m.text || "(media)"}`;
    if (m.media_path) {
      line += `\n  📎 file: ${m.media_filename || "?"} [${m.media_mimetype || "?"}] PATH=${m.media_path}${m.media_caption ? ` caption="${m.media_caption}"` : ""}`;
      if (m.vision_desc) {
        line += `\n     🖼️ DESCRIPTION: ${m.vision_desc.replace(/\s+/g, " ").slice(0, 400)}`;
      }
      try {
        const fs = require("fs");
        const cachePath = m.media_path + ".extracted.txt";
        if (fs.existsSync(cachePath)) {
          const preview = fs.readFileSync(cachePath, "utf8").slice(0, 400);
          line += `\n     EXTRACTED_PREVIEW: ${preview.replace(/\s+/g, " ").slice(0, 300)}...`;
          line += `\n     EXTRACTED_FULL_PATH: ${cachePath}`;
        }
      } catch {}
    }
    if (m.quoted_message_id) {
      // Resolve who/what this message replies to (deeper context: "X balas ke Y: ...").
      let q = null;
      try { q = getMessageById(m.quoted_message_id); } catch {}
      const qname = q
        ? (q.from_me ? "[BOT]" : (q.sender_name || (q.sender_jid || "").split("@")[0] || "?"))
        : (m.quoted_sender_jid ? m.quoted_sender_jid.split("@")[0] : "?");
      const qtext = (q?.text || m.quoted_text || q?.media_caption || "(media)").replace(/\s+/g, " ").slice(0, 120);
      line += `\n  └─ ↪️ BALAS ke *${qname}*: "${qtext}"`;
    }
    return line;
  });
  const header = isGroup
    ? `📋 RECENT GROUP CONVERSATION — Group: "${chatName}" (jam = WIB, pakai apa adanya saat lapor ke user)`
    : `📋 RECENT DM CONVERSATION — User: "${chatName}" (jam = WIB)`;
  return `\n\n${header}\n${lines.join("\n")}\n--- END CONTEXT ---\n`;
}

function describeTool(name, input) {
  const i = input || {};
  if (name === "Bash") return `🖥️ Bash: \`${(i.command || "").slice(0, 60)}\``;
  if (name === "Read") return `📄 Read: ${path.basename(i.file_path || "")}`;
  if (name === "Edit" || name === "Write") return `✏️ Edit: ${path.basename(i.file_path || "")}`;
  if (name === "Grep") return `🔍 Grep: "${(i.pattern || "").slice(0, 40)}"`;
  if (name === "Glob") return `📁 Glob: ${i.pattern || ""}`;
  if (name === "WebSearch") return `🌐 Web search: "${(i.query || "").slice(0, 50)}"`;
  if (name === "WebFetch") return `🌐 Fetch: ${(i.url || "").slice(0, 50)}`;
  if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") return `📋 Tasks`;
  if (name === "Agent") return `🤖 Agent: ${i.description || ""}`;
  if (name.startsWith("mcp__paper-trading__")) {
    const t = name.replace("mcp__paper-trading__", "");
    if (t === "buy") return `💰 BUY ${i.symbol} Rp${(i.amount_idr || 0).toLocaleString("id-ID")}`;
    if (t === "sell") return `💸 SELL ${i.symbol} ${i.percent}%`;
    if (t === "get_price") return `📊 Harga ${i.symbol}`;
    if (t === "get_portfolio") return `💼 Portfolio`;
    if (t === "get_indicators") return `📐 Indikator ${i.symbol}`;
    if (t === "ml_combined_signal") return `🧠 ML signal ${i.symbol}`;
    if (t === "generate_candlestick_chart") return `📊 Candlestick ${i.symbol}`;
    if (t === "generate_portfolio_chart") return `📈 Chart portfolio`;
    if (t === "get_crypto_news") return `📰 News ${i.coin || ""}`;
    return `🔧 ${t}`;
  }
  if (name.startsWith("mcp__")) return `🔧 ${name.replace("mcp__", "").replace(/_/g, " ").slice(0, 40)}`;
  return `🔧 ${name}`;
}

const WATCHDOG_MS = parseInt(process.env.CLAUDE_WATCHDOG_MS || "300000", 10);  // 5min — long tools (PDF/build) need slack

function runClaudeOnce(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "", finalText = "", cost = 0, err = "", duration = 0;
    const events = [];
    let lastActivity = Date.now();
    const to = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} reject(new Error(`Timeout ${TIMEOUT_MS}ms`)); }, TIMEOUT_MS);
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > WATCHDOG_MS) {
        console.error(`[WATCHDOG] no Claude output for ${WATCHDOG_MS}ms, killing proc`);
        try { proc.kill("SIGKILL"); } catch {}
        clearInterval(watchdog);
      }
    }, 15000);
    proc.stdout.on("data", chunk => {
      lastActivity = Date.now();
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          events.push(evt);
          if (evt.type === "result") {
            finalText = evt.result || finalText;
            cost = evt.total_cost_usd || 0;
            duration = evt.duration_ms || 0;
          }
        } catch {}
      }
    });
    proc.stderr.on("data", d => { lastActivity = Date.now(); err += d.toString(); });
    proc.on("error", e => { clearTimeout(to); clearInterval(watchdog); reject(e); });
    proc.on("close", code => {
      clearTimeout(to);
      clearInterval(watchdog);
      resolve({ code, finalText, cost, duration, err, events });
    });
  });
}

function dispatchEvent(evt, onEvent) {
  if (evt.type === "system" && evt.subtype === "init") {
    onEvent({ type: "init", session_id: evt.session_id, model: evt.model });
  } else if (evt.type === "assistant" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_use") {
        onEvent({ type: "tool_use", name: block.name, input: block.input, label: describeTool(block.name, block.input) });
      } else if (block.type === "text" && block.text) {
        onEvent({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        onEvent({ type: "thinking" });
      }
    }
  } else if (evt.type === "user" && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === "tool_result") {
        onEvent({ type: "tool_result", id: block.tool_use_id, error: block.is_error });
      }
    }
  } else if (evt.type === "result") {
    onEvent({ type: "done", text: evt.result || "", cost: evt.total_cost_usd || 0, duration_ms: evt.duration_ms });
  }
}

async function streamMessage(userText, chatId, contextMessages = [], isGroup = false, onEvent = () => {}, senderJid = null) {
  const cwd = getCwd(chatId);
  const cfg = getChatConfig(chatId);
  const route = resolveModel(cfg, userText);
  const model = route.model;
  const simple = route.simple;            // auto + trivial → skip heavy preprocessing for speed
  const permMode = cfg?.permission_mode || PERMISSION_MODE;
  const safeMode = !!cfg?.safe_mode;
  if (route.auto) onEvent({ type: "tool_use", name: "route", input: {}, label: `🧠 auto: ${model}` });

  if (senderJid) {
    const check = budgets.checkBudget(senderJid, isBoss(senderJid));
    if (!check.allowed) {
      const err = new Error(`BUDGET_EXCEEDED: limit harian $${check.row.daily_limit_usd.toFixed(2)} habis. Reset jam 00:00.`);
      err.code = "BUDGET_EXCEEDED";
      err.budget = check.row;
      throw err;
    }
  }

  const uiLang = i18n.getLang(chatId);
  const baseSystem = simple ? SHORT_SYSTEM : (isGroup ? APPEND_SYSTEM_GROUP : APPEND_SYSTEM_DM);
  const ctxMsgs = simple ? contextMessages.slice(-8) : contextMessages;   // trivial msgs need little context
  const langHeader = uiLang === "en" ? `\n\n🌐 OUTPUT LANGUAGE: Reply primarily in ENGLISH (user changed UI to en). Override Indonesian persona to English casual.\n` : "";
  let systemPrompt = baseSystem + langHeader + buildContext(ctxMsgs, isGroup);

  if (cfg?.preferred_lang) {
    const langName = translateMod.LANG_NAMES[cfg.preferred_lang] || cfg.preferred_lang;
    systemPrompt += `\n\n🌐 BAHASA: User chat ini prefer reply dalam ${langName} (kode: ${cfg.preferred_lang}). SELALU jawab dalam bahasa itu, even kalo input bahasa lain.\n`;
  }

  if (!simple) {
    const profiles = rag.getGroupProfiles(chatId, 8);
    if (profiles.length) systemPrompt += rag.buildGroupProfilesContext(profiles, chatId);
  }

  const lastSenderJid = contextMessages.length ? contextMessages[contextMessages.length - 1].sender_jid : null;
  if (lastSenderJid && !isGroup) {
    const profCtx = userProfiles.buildProfileContext(lastSenderJid);
    if (profCtx) systemPrompt += profCtx;
  }

  if (!simple) {
    const personaInfo = persona.buildPersonaPrompt(chatId, contextMessages);
    systemPrompt += personaInfo.prompt;
    onEvent({ type: "tool_use", name: "persona", input: {}, label: `🎭 persona: ${personaInfo.effective}` });
  }

  if (!simple) {
    try {
      const kbMatches = knowledge.searchKnowledge(userText, 4);
      if (kbMatches.length) systemPrompt += knowledge.buildKnowledgeContext(kbMatches);
    } catch {}
  }

  if (!simple) {
    try {
      const remembered = buttonsMod.listRemembered(chatId);
      if (remembered.length) {
        const lines = remembered.slice(0, 10).map(r => `• "${r.pattern}" → ${r.decision}`);
        systemPrompt += `\n\n🧠 USER PREFERENCES (decisions remembered, JANGAN tanya lagi):\n${lines.join("\n")}\n`;
      }
    } catch {}
  }

  // Image recall: only fire when query both mentions an image AND has recall/question intent.
  // Keeps token cost low — inject max 3 ranked matches, short descriptions only.
  const IMG_WORD = /\b(foto|gambar|image|picture|photo)\b/i;
  const IMG_RECALL = /(mana|tadi|kemarin|yang|itu|inget|ingat|cari|carikan|cariin|kirim|show|liat|lihat|tunjuk|soal|tentang|\?)/i;
  if (!simple && IMG_WORD.test(userText) && IMG_RECALL.test(userText)) {
    try {
      const imgMatches = rag.searchImagesByDescription(userText, { limit: 3 });
      if (imgMatches.length) {
        const lines = imgMatches.map((m, i) => {
          const sender = m.from_me ? "[BOT]" : (m.sender_name || "?");
          const desc = (m.vision_desc || "").replace(/\s+/g, " ").slice(0, 120);
          return `${i + 1}. ${sender}: ${desc}${m.media_caption ? ` (cap: "${m.media_caption.slice(0, 40)}")` : ""}\n   PATH=${m.media_path}`;
        });
        systemPrompt += `\n\n🖼️ IMAGE MATCHES (top ${imgMatches.length}):\n${lines.join("\n")}\nJawab dari deskripsi ini + cite pengirim. Butuh detail → Read PATH.\n`;
        onEvent({ type: "tool_use", name: "image_search", input: {}, label: `🖼️ ${imgMatches.length} image match` });
      }
    } catch {}
  }

  // Inject visual-entity memory only when the query names a known entity (precise + token-cheap).
  if (!simple) {
    try {
      const ents = entities.getRelevantEntities(chatId, userText, 5);
      const nk = entities.nameKey(userText);
      const named = ents.filter(e => e.name_key && nk.includes(e.name_key));
      if (named.length) {
        systemPrompt += entities.buildEntityContext(named);
        onEvent({ type: "tool_use", name: "entity", input: {}, label: `🧩 ${named.length} entitas` });
      }
    } catch {}
  }

  if (rag.shouldDoRagSearch(userText)) {
    const ftsMatches = rag.searchAllMessages(userText, { limit: 8 });          // text (synonym-expanded)
    const visionMatches = rag.searchVisionDesc(userText, { limit: 5 });        // image/video descriptions
    let semanticMatches = [];
    if (process.env.EMBEDDINGS_ENABLED !== "0") {
      try { semanticMatches = await embeddings.semanticSearch(userText, { limit: 5, threshold: 0.5 }); } catch {}
    }
    // Reciprocal Rank Fusion across text + vision + semantic; cap 6 for token economy.
    const merged = rag.rrf([ftsMatches, visionMatches, semanticMatches], { limit: 6 });
    if (merged.length) {
      const truncated = merged.map(m => ({ ...m, text: (m.text || m.vision_desc || "").slice(0, 160) }));
      systemPrompt += rag.buildRagContext(truncated);
      onEvent({ type: "tool_use", name: "RAG", input: {}, label: `🔎 RAG: ${ftsMatches.length}txt+${visionMatches.length}img+${semanticMatches.length}sem→${merged.length}` });
      // Self-correct habit: learn the group where the answer actually came from (so next similar
      // question searches there). Handles "wrong group -> found elsewhere -> next time look there".
      try {
        const counts = {};
        for (const m of merged) if (m.chat_id && m.chat_id !== chatId) counts[m.chat_id] = (counts[m.chat_id] || 0) + 1;
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (top) habits.recordHabit(userText, top[0], merged.find(m => m.chat_id === top[0])?.chat_name || "");
      } catch {}
    }
  }

  // Learned lessons + reusable skills — inject only relevant ones (FTS-matched, token-cheap).
  if (!simple) {
    try {
      const lessons = learning.searchLessons(chatId, userText, 4);
      if (lessons.length) {
        systemPrompt += learning.buildLessonContext(lessons);
        onEvent({ type: "tool_use", name: "lessons", input: {}, label: `📚 ${lessons.length} pelajaran` });
      }
    } catch {}
    try {
      const sk = skills.matchSkills(userText, chatId, 2);
      if (sk.length) {
        systemPrompt += skills.buildSkillContext(sk);
        onEvent({ type: "tool_use", name: "skills", input: {}, label: `🛠️ skill: ${sk.map(s => s.name).join(", ").slice(0, 40)}` });
      }
    } catch {}
    try {
      const facts = qaLearning.searchFacts(chatId, userText, 3);
      if (facts.length) {
        systemPrompt += qaLearning.buildFactContext(facts);
        onEvent({ type: "tool_use", name: "qa_facts", input: {}, label: `📌 ${facts.length} fakta` });
      }
    } catch {}
    // Source habit: route this kind of question to the group it usually comes from (teks+gambar+caption).
    try {
      let target = habits.resolveGroupRef(userText);                 // explicit "di grup internal"
      if (target) habits.recordHabit(userText, target.chat_id, target.chat_name);
      else target = habits.findHabit(userText);                      // learned habit
      if (target && target.chat_id && target.chat_id !== chatId) {
        const inTxt = rag.searchByChat(target.chat_id, userText, 6);
        const inImg = rag.searchVisionDesc(userText, { limit: 6 }).filter(r => r.chat_id === target.chat_id);
        const merged = rag.rrf([inTxt, inImg], { limit: 6 });
        if (merged.length) {
          const trunc = merged.map(m => ({ ...m, text: (m.text || m.vision_desc || "").slice(0, 160) }));
          systemPrompt += rag.buildRagContext(trunc, `🎯 SUMBER UTAMA — grup "${target.chat_name}" (data jenis ini biasanya di sini; teks+gambar+caption)`);
          onEvent({ type: "tool_use", name: "habit", input: {}, label: `🔎 mencari di ${target.chat_name}` });
        }
      }
    } catch {}
  }

  // Self-management (BOSS only): let Claude change the bot's own data via the manage.js CLI.
  if (!simple && senderJid && isBoss(senderJid)) {
    systemPrompt += `\n\n🛠️ KELOLA SISTEM SENDIRI (yang minta BOSS — lo BOLEH & BISA eksekusi via Bash):
Jalanin: \`cd "${BOT_DIR}" && node manage.js <domain> <action> [args]\` (argumen ber-spasi WAJIB pakai kutip "...").
- alias (julukan↔akun): \`alias set "<julukan>" "<nama akun/nomor>"\` · \`alias del "<julukan>"\` · \`alias list\`
  Contoh: user "ganti riky 04 jadi kep Agus" → \`node manage.js alias set "kep Agus" "riky 04"\`
- habit (topik pertanyaan→grup sumber): \`habit set "<topik/keyword>" "<nama grup>"\` · \`habit del <id>\` · \`habit list\`
  Contoh: user "kalau ada yang tanya soal harga, cari di grup gudang" → \`node manage.js habit set "harga" "gudang"\`
- lesson list/del <id> · fact list/del <id> · skill list/del "<nama>"
Setelah eksekusi, cek output-nya lalu KONFIRMASI singkat ke user apa yang berubah. Kalau user minta ubah sistem, LANGSUNG kerjain (jangan nyuruh user ketik slash command).\n`;
  }

  if (safeMode) systemPrompt += SAFE_MODE_APPEND;

  // Pass the (large) system prompt via a FILE, not a CLI arg — long prompts + long user text
  // overflow the Windows command-line limit (~32k) and the spawn fails as "exit 1: no output".
  const promptFile = path.join(os.tmpdir(), `wasp_sp_${crypto.randomBytes(6).toString("hex")}.txt`);
  try { fs.writeFileSync(promptFile, systemPrompt, "utf8"); } catch (e) { console.error("sysprompt file:", e.message); }

  const baseArgs = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--permission-mode", permMode,
    "--append-system-prompt-file", promptFile,
    "--add-dir", cwd
  ];
  const effort = cfg?.effort || process.env.CLAUDE_DEFAULT_EFFORT || null;
  const effortValid = effort && ["low", "medium", "high", "xhigh", "max"].includes(effort);

  let sessionId = getSessionId(chatId);
  let useResume = !!sessionId;
  let useEffort = effortValid && !simple;   // simple msgs skip reasoning effort → faster
  let lastErr = "no output";
  let lastCode = -1;

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!sessionId) sessionId = crypto.randomUUID();
      const args = [...baseArgs];
      if (useEffort) args.push("--effort", effort);
      if (useResume) args.push("--resume", sessionId);
      else args.push("--session-id", sessionId);
      args.push(userText);

      console.error(`[claude attempt ${attempt + 1}] model=${model} effort=${useEffort ? effort : "none"} session=${useResume ? "resume" : "new"} cwd=${cwd}`);
      const { code, finalText, cost, duration, err, events } = await runClaudeOnce(args, cwd);
      for (const evt of events) dispatchEvent(evt, onEvent);
      lastErr = err || "";
      lastCode = code;

      if (code === 0 && finalText) {
        setChatConfig(chatId, { claude_session_id: sessionId });
        ensureSession(chatId, sessionId);
        touchSession(chatId, sessionId);
        if (senderJid && cost > 0) budgets.consumeBudget(senderJid, cost);
        return { text: finalText, cost, duration, model, sessionId, cwd };
      }

      if (useResume && /No conversation found|session.*not.*found|invalid.*session/i.test(err)) {
        console.error(`[chat ${chatId}] session expired, retry new`);
        dropSession(chatId);
        sessionId = null;
        useResume = false;
        continue;
      }

      if (useEffort && (code !== 0 || !finalText)) {
        console.error(`[chat ${chatId}] retry without --effort (err: ${(err || "no output").slice(0, 150)})`);
        useEffort = false;
        continue;
      }

      // exit≠0 with no output on a resumed session: the session may be corrupt → one fresh-session retry.
      if (useResume && code !== 0 && !finalText) {
        console.error(`[chat ${chatId}] exit ${code} no output on resume — retry fresh session`);
        dropSession(chatId);
        sessionId = null;
        useResume = false;
        continue;
      }

      if (code === 0 && !finalText) {
        throw new Error(`Claude balas kosong (exit 0, no result). stderr: ${(err || "(empty)").slice(0, 200)}`);
      }
      break;
    }
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
  throw new Error(`Claude CLI exit ${lastCode}: ${(lastErr || "no output").slice(0, 400)}`);
}

function extractChartUrls(text) {
  if (!text) return [];
  const m = text.match(/https:\/\/quickchart\.io\/chart\/render\/[a-zA-Z0-9_-]+/g) || [];
  return [...new Set(m)];
}

function wrapTablesInCodeBlock(text) {
  if (!text) return "";
  const BOX = /[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝═║╠╣╦╩╬]/;
  const ALIGNED = /^\s{0,6}\S.+?\s{3,}\S/;
  const lines = text.split("\n");
  const segments = [];
  let cur = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    if (line.trim() === "" && !inFence) {
      if (cur.length) segments.push(cur);
      segments.push([""]);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) segments.push(cur);

  const stripBoxDrawing = (line) => line.replace(/[─━═]{3,}/g, m => "-".repeat(Math.min(m.length, 30)));

  const out = [];
  for (const seg of segments) {
    if (seg.length === 1 && seg[0] === "") { out.push(""); continue; }
    const joined = seg.join("\n");
    if (/^```/.test(seg[0]) || joined.includes("```")) {
      out.push(...seg);
      continue;
    }
    const hasBox = seg.some(l => BOX.test(l));
    const hasAligned = seg.filter(l => ALIGNED.test(l)).length >= 2;
    if (hasBox || hasAligned) {
      out.push("```");
      out.push(...seg.map(stripBoxDrawing));
      out.push("```");
    } else {
      out.push(...seg);
    }
  }
  return out.join("\n");
}

function sanitizeMarkdown(text) {
  if (!text) return "";
  let s = text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/^\s*[-*]\s+/gm, "• ");
  s = wrapTablesInCodeBlock(s);
  return s;
}

function splitLong(text, maxLen = 4000) {
  if (!text) return [];
  if (text.length <= maxLen) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

module.exports = { streamMessage, setModel, getModel, dropSession, getCwd, setCwd, getEffort, setEffort, DEFAULT_MODEL, DEFAULT_CWD, extractChartUrls, sanitizeMarkdown, splitLong };
