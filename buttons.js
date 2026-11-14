// Botões nativos do WhatsApp. Se o app não desenhar, o texto do comando continua na mensagem.

const buttonsMessage = {
  contentText: "",
  footerText: "Ou manda o comando escrito.",
  headerType: 1,
  buttons: [],
};

export function buttonContent(text, buttons) {
  const usable = (buttons || []).filter((item) => item?.id && item?.text).slice(0, 3);
  if (!usable.length) return { text };
  return {
    buttonsMessage: {
      ...buttonsMessage,
      contentText: text,
      buttons: usable.map((item) => ({
        buttonId: item.id,
        type: 1,
        buttonText: { displayText: item.text.slice(0, 20) },
      })),
    },
  };
}

export function buttonReplyId(message) {
  const unwrapped =
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message;
  const response = unwrapped?.buttonsResponseMessage;
  if (response?.selectedButtonId) return response.selectedButtonId;
  const interactive = unwrapped?.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (!interactive?.paramsJson) return "";
  try {
    const params = JSON.parse(interactive.paramsJson);
    return params.id || params.selected_id || "";
  } catch {
    return "";
  }
}
