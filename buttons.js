// O Baileys 7.0.0-rc14 não reconhece mensagem de botão.
// Qualquer campo fora de text/image/video cai em prepareWAMessageMedia
// e o envio quebra com "Invalid media type". Por isso o menu é texto.

export function buttonContent(text) {
  return { text };
}
