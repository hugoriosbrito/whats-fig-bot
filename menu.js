import { config } from "./config.js";

const CATEGORIES = [
  {
    id: "1",
    names: ["figurinhas", "fig", "figurinha"],
    title: "Figurinhas",
    body: `*Figurinhas*

*!fig* — manda a foto ou o vídeo com essa legenda.
*!fig fit* — cabe inteira.
*!fig fill* — preenche e corta a borda.
*!fig stretch* — estica.
*!fig top* — corta pela parte de cima.
*!fig bottom* — corta pela parte de baixo.
*!emoji* 😀 🔥 — junta dois emojis numa figurinha.

Também vale responder a mídia, ou mandar *!fig* com um link de foto, vídeo ou GIF do X.`,
  },
  {
    id: "2",
    names: ["midia", "mídia", "media"],
    title: "Mídia",
    body: `*Mídia*

*!tomp3* — responde um vídeo ou áudio e eu devolvo o som.
*!tomp4* — responde uma figurinha animada ou um GIF e eu devolvo o vídeo.
*!tts seu texto* — eu falo o texto.

Os dois primeiros gastam uma figurinha do dia e entram na mesma fila.`,
  },
  {
    id: "3",
    names: ["jogos", "jogo"],
    title: "Jogos",
    body: `*Jogos*

*!pescar* — gasta uma isca.
*!pesca* — vê o que você pescou.
*!slots* — gira o caça-níquel. *!slots 3* gira três vezes.
*!roleta* — roleta russa, só no grupo e só no texto.
*!anagrama* — adivinha a palavra embaralhada.
*!stop* — letra e categorias. A resposta vai no meu privado.

Jogos gastam o limite de figurinha do dia.`,
  },
  {
    id: "4",
    names: ["relacionamento", "social", "namoro"],
    title: "Relacionamento",
    body: `*Relacionamento* — só no grupo

*!namorar* @pessoa — pede em namoro.
*!casar* @pessoa — pede em casamento, se já namoram.
*!separar* — pede o fim.
*!recusar* — recusa o pedido que chegou.
*!celibar* — encerra todos os seus.
*!coisar* @pessoa — manda uma frase.
*!trair* @pessoa — registra na ficha.
*!relacionamento* — a sua ficha.
*!relacionamentos* — a lista do grupo.`,
  },
  {
    id: "5",
    names: ["zoeira", "zoera"],
    title: "Zoeira",
    body: `*Zoeira*

*!biscoito* — frase da sorte.
*!cantada* — no grupo, para alguém marcado ou aleatório.
*!presente* — sorteia um presente.
*!pix* @pessoa — transferência fictícia.
*!boleto* — sorteia quem “paga”. *!pagar* quita.
*!aniversario* @pessoa — parabéns.
*!pecar* e *!meus-pecados*.
*!violencia*, *!morreu*, *!genshin*, *!hora*.
*!pinto* — medição no grupo, uma a cada 3 dias. *!pinto-ranking* mostra o grupo.`,
  },
  {
    id: "6",
    names: ["conta", "limite", "vip"],
    title: "Conta",
    body: `*Conta*

*!resto* — quantas figurinhas e áudios restam hoje.
*!ajuda* — como o bot funciona.

Cada número tem ${config.dailyLimit} figurinhas por dia e ${config.cooldownSeconds}s entre cada uma.
Áudios: ${config.ttsDailyLimit} por dia.

VIP é uma cota maior, cadastrada pelo admin. O *!resto* mostra o seu limite.`,
  },
];

export function menuHome(admin) {
  const extra = admin
    ? "\n\nAdmin: *!anunciar* manda um texto no privado de quem já usou o bot, em lotes."
    : "";
  return {
    text: `*FigBot*\n\n*1* Figurinhas\n*2* Mídia\n*3* Jogos\n*4* Relacionamento\n*5* Zoeira\n*6* Conta\n\nManda o número ou *!menu jogos*.${extra}`,
  };
}

export function menuCategory(name, admin) {
  const key = String(name || "").toLowerCase();
  const found = CATEGORIES.find((item) => item.id === key || item.names.includes(key));
  if (!found) return null;
  let text = found.body;
  if (found.id === "6" && admin) {
    text += "\n\n*!anunciar seu texto* avisa quem já usou o bot, em lotes de 5.\n*!anunciar-parar* interrompe.";
  }
  return { text };
}

export const HELP = `Como funciona:

- Manda *!menu* e escolhe uma categoria, ou aperta um botão.
- Foto com *!fig* vira figurinha. Vídeo curto também.
- *!fig top* e *!fig bottom* cortam pela ponta.
- *!tts seu texto* vira uma mensagem de voz.
- Cada número tem ${config.dailyLimit} figurinhas por dia.
- Sem comando, eu fico quieto.`;

export function categoryIds() {
  return CATEGORIES.map((item) => item.id);
}
