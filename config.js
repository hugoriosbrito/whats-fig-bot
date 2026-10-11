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
};
