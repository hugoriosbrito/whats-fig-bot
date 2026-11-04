import { config } from "./config.js";

// Texto para voz pela API da Fish Audio, modelo S2.1 Pro gratuito (s2.1-pro-free).
// POST /v1/tts devolve o áudio cru no corpo da resposta. O header "model" escolhe
// o modelo; o campo reference_id escolhe a voz (sem ele, a voz padrão da conta).
const endpoint = `${config.fishBaseUrl.replace(/\/+$/, "")}/v1/tts`;

export class TtsError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "TtsError";
    this.reason = reason;
  }
}

export function ttsEnabled() {
  return Boolean(config.fishApiKey);
}

function mapTtsError(status) {
  if (status === 401) return new TtsError("A chave da Fish Audio foi recusada.", "auth");
  if (status === 402) return new TtsError("Sem crédito na Fish Audio para este modelo.", "credit");
  if (status === 429) return new TtsError("A Fish Audio está limitando os pedidos agora.", "rate");
  if (status >= 500) return new TtsError("A Fish Audio está fora do ar agora.", "unavailable");
  return new TtsError(`A Fish Audio recusou o pedido (erro ${status}).`, "other");
}

async function readReason(response) {
  try {
    const body = await response.json();
    return body?.message || body?.reason || "";
  } catch {
    return "";
  }
}

// Devolve o áudio já pronto (MP3 ou OGG/Opus) num Buffer.
export async function synthesize(text, { format = "mp3" } = {}) {
  if (!ttsEnabled()) {
    throw new TtsError("TTS desligado: configure FISH_API_KEY.", "disabled");
  }

  const payload = {
    text,
    format,
    chunk_length: 300,
    normalize: true,
    latency: "normal",
  };
  if (config.fishVoiceId) payload.reference_id = config.fishVoiceId;

  let lastError;
  for (let attempt = 1; attempt <= config.ttsRetries && attempt <= 2; attempt += 1) {
    const started = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.fishApiKey}`,
        "Content-Type": "application/json",
        model: config.fishModel,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.ttsTimeoutMs),
    }).catch((error) => {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new TtsError("A Fish Audio demorou demais para responder.", "timeout");
      }
      throw new TtsError(`Não consegui falar com a Fish Audio: ${error.message}`, "network");
    });

    if (response.ok) {
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) throw new TtsError("A Fish Audio devolveu um áudio vazio.", "empty");
      return { audio, latencyMs: Date.now() - started };
    }

    lastError = mapTtsError(response.status);
    const detail = await readReason(response);
    if (detail) lastError.message += ` ${detail}`;
    // 429 é o único caso que vale repetir; 401/402 não mudam com nova tentativa.
    if (response.status !== 429) break;
    if (attempt < config.ttsRetries) {
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }

  throw lastError;
}
