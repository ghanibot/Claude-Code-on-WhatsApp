<p align="center">
  <img src="assets/banner.png" alt="Claude Code on WhatsApp" width="100%">
</p>

<h1 align="center">🤖 Claude Code on WhatsApp</h1>

<p align="center">
  <b>Your AI Personal OS — di WhatsApp, Telegram, dan dashboard web. Run 100% di Termux Android atau Windows/Linux/macOS.</b>
</p>

<p align="center">
  <a href="https://ghanibot.github.io/Claude-Code-on-WhatsApp/"><img src="https://img.shields.io/badge/▶_Live_Demo-Interactive_Presentation-26a69a?style=for-the-badge&logoColor=white" alt="Live Demo"></a>
  <a href="INSTALL.md"><img src="https://img.shields.io/badge/📥_One_Click_Install-Windows_|_Mac_|_Linux_|_Termux-0f1522?style=for-the-badge" alt="Install"></a>
  <a href="https://github.com/ghanibot/Claude-Code-on-WhatsApp/releases/latest"><img src="https://img.shields.io/github/v/release/ghanibot/Claude-Code-on-WhatsApp?style=for-the-badge&color=ffa726" alt="Latest Release"></a>
[![SafeSkill 69/100](https://img.shields.io/badge/SafeSkill-69%2F100_Use%20with%20Caution-orange)](https://safeskill.dev/scan/ghanibot-claude-code-on-whatsapp)
</p>

<p align="center">
  <a href="https://github.com/ghanibot/Claude-Code-on-WhatsApp/stargazers"><img src="https://img.shields.io/github/stars/ghanibot/Claude-Code-on-WhatsApp?style=flat-square&color=26a69a" alt="Stars"></a>
  <img src="https://img.shields.io/badge/Node-20+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/Platform-Windows_|_macOS_|_Linux_|_Termux-blue?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License">
</p>

---

> Bukan chatbot rigid — full Claude Code agent dengan akses file system, web, MCP servers, multi-tool reasoning.

## 🎥 Demo Interaktif

👉 **[Buka Live Demo (Interactive Presentation)](https://ghanibot.github.io/Claude-Code-on-WhatsApp/)**

Animasi presentasi 13 scene yang nunjukin semua fitur secara visual.

## ✨ Highlights

- 💬 **WhatsApp Bridge** — listen semua group + DM, voice/image/PDF auto-process, cross-chat memory
- 📲 **Telegram Bridge** — same engine, beda kanal, streaming progress
- 📊 **Paper Trading MCP** — 81 tools: realtime WS prices, ML signals, auto bot, backtest, native charts
- ⚽ **Futsal Business MCP** — 24 tools: booking, member, KB, expense, P&L + web dashboard
- 🧠 **RAG + Vector Embeddings** — FTS5 + MiniLM 384-dim local, semantic search seluruh chat
- 🎤 **Voice Indonesia** — Groq Whisper transcribe
- 🖼️ **Vision** — Groq vision auto-describe image silent
- 📎 **File Native Generation** — PDF (pdfkit), DOCX, XLSX, PPTX dari chat
- ⏰ **Scheduler** — reminders + cron tasks
- 🔄 **Mini Workflows** — boss instruksi natural → auto-execute pattern
- 🔘 **Interactive Buttons** — Claude pilihan via marker, remember decisions
- 🌐 **Auto-translate** — 19 bahasa, persona switcher 6 mode (auto-adapt)
- 💰 **Per-user Token Budget** — daily limit + audit log
- 🔐 **PII Detection** — KTP/NPWP/credit card/API key auto-flag
- 🔌 **Plugin System** — drop .js ke `plugins/` → hot reload
- 📚 **Knowledge Base Import** — URL/file/text → FTS5 indexed
- 📅 **Calendar Events** — ICS export, no Google OAuth
- 💾 **Daily Auto-backup** — SQLite + rotate
- 📱 **100% Termux Ready** — full stack di HP Android

## 🏗️ Komponen

```
paper-trading/
├── paper-trading-mcp/   - MCP server 81 tools (trading simulator)
├── whatsapp-bot/        - WA bridge (Baileys + Claude Code spawn)
│   ├── admin/           - Web dashboard untuk manage boss/secret/budget
│   └── plugins/         - Drop .js custom commands
├── telegram-bot/        - TG bridge
├── futsal-mcp/          - Futsal business management
│   └── dashboard/       - Web admin localhost:3457
├── src/                 - Paper-trading core
└── docs/
    ├── TERMUX-SETUP.md  - Setup di Android Termux step-by-step
    ├── PROJECT-OVERVIEW.md
    └── VIDEO-DEMO-SCRIPT.md
```

## 🚀 Install — Orang Awam (One-Click)

### 🪟 Windows
1. Download/clone repo
2. **Double-click `install.bat`** → Ikutin prompt
3. Setelah selesai, double-click shortcut **"Claude Code Personal OS"** di Desktop
4. Browser auto-buka setup wizard → isi 5 form (~3 menit)
5. Scan QR WhatsApp yang muncul di terminal

### 🐧 Linux / 🍎 macOS / 📱 Termux Android
```bash
chmod +x install.sh && ./install.sh
```
Auto-detect OS, install dependencies, bikin shortcut Desktop. Setelah selesai, klik shortcut atau run `./start.sh`.

📖 **Detail lengkap step-by-step**: [INSTALL.md](INSTALL.md)

---

## 🛠️ Manual Setup (Developer)

```powershell
git clone <repo-url>
cd paper-trading

# Install Node.js 20+ via nvm/winget
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude login

# Install deps per module
foreach ($d in "paper-trading-mcp","whatsapp-bot","telegram-bot","futsal-mcp") {
  Push-Location $d; npm install; Pop-Location
}

# Setup .env per module (copy dari .env.example)
# Edit isi:
notepad whatsapp-bot\.env
notepad telegram-bot\.env

# Run
cd whatsapp-bot && npm start    # Tab 1
cd telegram-bot && npm start    # Tab 2
cd futsal-mcp && npm run dashboard   # Tab 3 → http://localhost:3457
cd whatsapp-bot && npm run admin     # Tab 4 → http://localhost:3458
```

### Termux Android (Production)

Liat **[TERMUX-SETUP.md](TERMUX-SETUP.md)** — 13 langkah lengkap dari install Termux sampai PM2 auto-boot.

## 🔐 Boss Setup (Important Security)

WhatsApp bot pakai **boss whitelist** — cuma nomor di whitelist yang bisa instruksi Claude.

### 3 cara setup boss:

#### 1. Via Admin Dashboard (recommended)
```powershell
cd whatsapp-bot
npm run admin
# Buka http://localhost:3458 (login dengan ADMIN_USER / ADMIN_PASS dari .env)
# Tab "Bosses" → Tambah nomor lo
# Tab "Secret Code" → Generate atau set manual
```

#### 2. Via .env (saat first setup)
```
WA_INITIAL_BOSSES=628XXXXXXXXX,628YYYYYYYYY
BOSS_SECRET_CODE=ganti-kode-ini
```

#### 3. Via Secret Code di WhatsApp
1. Set `BOSS_SECRET_CODE=xxxxxx` di `.env`
2. Dari nomor WA apapun, DM bot kirim text `xxxxxx`
3. Bot auto-promote sender jadi boss
4. Setelah boss masuk, rotate code di dashboard

## 🎬 Demo Video

Liat **[VIDEO-DEMO-SCRIPT.md](VIDEO-DEMO-SCRIPT.md)** — storyboard 13 scene + AI generation prompts untuk Sora/Veo/Runway.

## 📖 Documentation

- **[PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md)** — arsitektur, fitur lengkap, use cases, stats
- **[TERMUX-SETUP.md](TERMUX-SETUP.md)** — install di Android
- **[VIDEO-DEMO-SCRIPT.md](VIDEO-DEMO-SCRIPT.md)** — produksi video demo
- Per-module README di `whatsapp-bot/README.md`, `telegram-bot/README.md`, dll

## 💰 Cost

- **Claude Code subscription** (Pro/Max): $20-100/bulan
- **Groq API** (Whisper + Vision + LLM cheap): free tier cukup buat personal
- **WhatsApp + Telegram**: gratis
- **Server**: HP Android Termux atau VPS murah ($5/bulan)

Total: ~**$20-100/bulan** untuk full enterprise-grade AI assistant.

## 🛠️ Tech Stack

- Node.js 20+
- SQLite (better-sqlite3) + FTS5 + vector embeddings (Xenova/transformers)
- @whiskeysockets/baileys (WhatsApp)
- @modelcontextprotocol/sdk (MCP servers)
- Express (dashboards)
- QuickChart.io (chart rendering)
- pdfkit, docx, xlsx, pptxgenjs (file generation)
- Groq API (Whisper STT, vision, translation, profile gen)
- Claude Code CLI (main agent loop, subscription billing)

## ⚠️ Disclaimer

- WhatsApp bot pakai **library unofficial (Baileys)** — risk akun ke-banned. Pakai nomor disposable.
- Paper-trading = **simulasi**, bukan real trading. Educational use only.
- Boss whitelist crucial — bypassPermissions default. Jangan expose ke public WA tanpa secure.
- AI dapat melakukan kesalahan — verify financial decisions.

## 📄 License

MIT — see [LICENSE](LICENSE)

## 🤝 Contributing

PR welcome. Open issues for bugs/features. Test di branch fork dulu.

## 🌟 Acknowledgments

Inspired by:
- [Claude Code](https://claude.com/claude-code) (Anthropic)
- [Baileys](https://github.com/WhiskeySockets/Baileys)
- [Putri Bot v11](https://github.com/...) — futsal bot reference
- Model Context Protocol ecosystem
