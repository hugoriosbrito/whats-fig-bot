// Config central do bot. Tudo ajustável por variável de ambiente (painel sillydev → Environment).
export const config = {
  // Limite diário de figurinhas por pessoa (anti-ban: evita flood)
  dailyLimit: Number(process.env.DAILY_LIMIT || 15),

  // Janela anti-flood: mínimo de segundos entre uma figurinha e outra da mesma pessoa
  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 10),

  // Tamanho máximo do arquivo de entrada (MB). Protege os 256MB de RAM do free tier:
  // mídia é processada via stream em disco, nunca inteira na memória.
  maxMediaMB: Number(process.env.MAX_MEDIA_MB || 16),

  // Duração máxima de vídeo aceita para virar figurinha animada (segundos)
  maxVideoSeconds: Number(process.env.MAX_VIDEO_SECONDS || 10),

  // Onde a sessão do WhatsApp é salva (precisa persistir no disco do servidor)
  sessionDir: process.env.SESSION_DIR || "session",

  // Onde o controle de uso diário é salvo (sobrevive a restart)
  dataDir: process.env.DATA_DIR || "data",

  // Prefixo dos comandos (ex: !fig, !menu)
  prefix: process.env.PREFIX || "!",

  // ── Texto para voz (Fish Audio — modelo S2.1 Pro gratuito) ──
  // A chave sai em fish.audio → Get Started → Get your API key.
  // Sem chave, o comando de voz fica desligado e avisa isso no chat.
  fishApiKey: process.env.FISH_API_KEY || "",

  // Endereço da API. Só mude se a Fish Audio mudar o domínio.
  fishBaseUrl: process.env.FISH_BASE_URL || "https://api.fish.audio",

  // Modelo usado no header "model". No free tier só s2.1-pro-free funciona sem crédito.
  fishModel: process.env.FISH_MODEL || "s2.1-pro-free",

  // Voz (id de modelo de voz da Fish Audio). Vazio usa a voz padrão da conta.
  fishVoiceId: process.env.FISH_VOICE_ID || "",

  // Quantos caracteres por áudio. Protege o free tier e evita áudio gigante.
  ttsMaxChars: Number(process.env.TTS_MAX_CHARS || 300),

  // Teto de tamanho do áudio final (bytes).
  ttsMaxBytes: Number(process.env.TTS_MAX_BYTES || 8 * 1024 * 1024),

  // Limite de áudios por pessoa por dia (anti-spam, separado das figurinhas)
  ttsDailyLimit: Number(process.env.TTS_DAILY_LIMIT || 10),

  // Espera entre áudios da mesma pessoa (segundos)
  ttsCooldownSeconds: Number(process.env.TTS_COOLDOWN_SECONDS || 10),

  // Quanto esperar a Fish Audio responder (ms)
  ttsTimeoutMs: Number(process.env.TTS_TIMEOUT_MS || 90000),

  // Tentativas em caso de 429 (rate limit)
  ttsRetries: Number(process.env.TTS_RETRIES || 2),
};
