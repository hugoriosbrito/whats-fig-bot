# Jogos, mídia, relacionamento, zoeira e menu

Data: 2026-11-14

Portar para o FigBot o que roda localmente no Ravena (`moothz/ravena-ai`, MIT) nas áreas de jogos, figurinhas, conversão de mídia, interação e zoeira, mais um menu por categorias. Sem copiar a arquitetura do Ravena.

## Fora de escopo

- Waifuletes / mudae (API fechada)
- Fazenda, RavenaBank, runas, petalitas
- Download de YouTube, TikTok, Instagram, Twitter e SoundCloud
- Perfis de LoL, Valorant, Wild Rift, Steam, PSN, Roblox, Minecraft
- Corte de figurinha por IA (`sqi`) e scraper de figurinha de terceiros (`figa`)
- `!g-interagir` e qualquer resposta automática com LLM
- Silenciar ou remover participante na roleta
- Imagem gerada da pesca (`canvas`)
- Julgamento do stop por LLM

## Menu

`!menu` (também `!start`, `!oi`, `!ola`) mostra só as categorias:

```
*FigBot*

*1* Figurinhas
*2* Mídia
*3* Jogos
*4* Relacionamento
*5* Zoeira
*6* Conta

Manda o número ou *!menu jogos*.
```

`!1` … `!6` e `!menu <categoria>` abrem a categoria. Não há estado de tela: cada mensagem traz o comando completo.

| Número | Nome | Atalho |
|---|---|---|
| 1 | Figurinhas | figurinhas, fig |
| 2 | Mídia | midia, mídia |
| 3 | Jogos | jogos |
| 4 | Relacionamento | relacionamento, social |
| 5 | Zoeira | zoeira |
| 6 | Conta | conta |

Cada categoria lista o comando, um exemplo e uma linha do que faz. `!ajuda` explica o prefixo e aponta para `!menu`, sem repetir todos os comandos.

Comandos que continuam iguais: `!resto`, `!vip`, `!tirarvip`, `!vips`, `!tts`.

`!anunciar` é de admin e não aparece no menu geral. A categoria Conta, para admin, ganha uma linha explicando o comando.

## Módulos

O `bot.js` só despacha. Cada módulo exporta um handler que devolve texto (ou envia mídia e devolve nada). Erro vira mensagem no chat, no mesmo tom do bot.

| Arquivo | Responsabilidade |
|---|---|
| `menu.js` | Textos do menu e das categorias |
| `games.js` | Pesca, slots, roleta, anagrama, stop |
| `media.js` | `!tomp3`, `!tomp4`, `!emoji` |
| `social.js` | Relacionamento de grupo |
| `jokes.js` | Zoeira, inclusive `!pinto` |
| `store.js` | Leitura e escrita JSON ou MySQL |
| `announce.js` | Fila de anúncio do admin |

`sticker.js` ganha os modos `top` e `bottom`.

## Figurinhas

Modos de `!fig`: `fit` (padrão em foto), `fill` (padrão em vídeo do WhatsApp), `stretch`, `top`, `bottom`.

- `top` corta o quadrado pela parte de cima.
- `bottom` corta pela parte de baixo.
- Foto e vídeo usam a mesma regra de corte. Link do X continua no modo pedido, com `fit` se não houver modo.

`!emoji 😀 🔥` combina dois emojis numa figurinha 512×512 (Sharp desenha os dois glifos). Gasta uma cota de figurinha e entra na fila. Sem FFmpeg.

## Mídia

`!tomp3` responde um vídeo ou áudio e devolve MP3 como documento de áudio. `!tomp4` responde uma figurinha animada ou GIF e devolve MP4. Os dois:

- entram na mesma fila do `!fig`
- gastam uma cota de figurinha e respeitam o cooldown
- recusam arquivo maior que `MAX_MEDIA_MB` e vídeo maior que `MAX_VIDEO_SECONDS`
- se o FFmpeg não existir, respondem isso e não derrubam o bot

## Jogos

Cota e cooldown iguais aos da figurinha (`checkQuota` / `checkCooldown` com kind `fig`), porque pesam no grupo. Zoeira e relacionamento não gastam cota.

### Pesca

- `!pescar` gasta 1 isca.
- Máximo de 5 iscas. Regenera 1 a cada 60 minutos, até o teto.
- Inventário de no máximo 10 peixes por pessoa. O 11º descarta o mais leve.
- Peso de 0,1 kg a 30 kg, distribuição inclinada para peixes pequenos.
- Lista de nomes: as 209 entradas `peixe` de `data/custom-variables.json` do Ravena, copiadas para `data/phrases.json` com nota da licença MIT.
- `!pesca` mostra iscas, próximo regen, inventário e peso total.
- `!pesca-ranking` top 10 do grupo por peso total.
- Texto apenas. Sem imagem, sem lendário global, sem rede.

### Slots

- `!slots` gira 1 vez. `!slots 3` gira até 3, limitado às moedas que a pessoa tem.
- Máximo de 5 moedas. Regenera 1 a cada 30 minutos.
- Três rolos, símbolos fixos (peixe, isca, moeda, estrela, lixo).
- Cada giro gasta 1 moeda antes de sortear.
- Três iguais: devolve essa 1 moeda e soma de 2 a 8, teto de estoque 50.
- Dois iguais: devolve 1 moeda.
- Nenhum igual: perde a moeda.
- `!slots-ranking` top 10 do grupo por vitórias de três iguais.
- Sem runa, fazenda, isca de pesca ou prêmio colecionável.

### Roleta russa

- `!roleta` só no grupo.
- Tambor de 6 posições, 1 bala, por grupo. A bala avança a cada jogada e o tambor recarrega depois do estouro.
- Quem perde “morre” na mensagem. Ninguém é silenciado nem removido.
- `!roleta-ranking` conta sobrevivências no grupo.
- Sem `!roleta-silenciar`.

### Anagrama

- `!anagrama` inicia uma rodada no grupo, se não houver outra.
- Palavra sorteada de `data/anagrama/portuguese.txt` (cópia do Ravena, 4 a 12 letras, sem hífen).
- A palavra embaralhada vai no grupo. Acerto de qualquer membro vale 1 ponto e abre outra palavra, até 5 palavras ou `!anagrama-parar`.
- `!anagrama-dica` revela a próxima letra ainda oculta, no máximo 3 por rodada.
- `!anagrama-ranking` pontos acumulados do grupo.
- Partida ativa só na memória. Restart acaba a rodada e avisa na próxima tentativa.

### Stop

- `!stop` só no grupo. Sorteia 1 letra (sem K, W, Y) e 5 categorias de uma lista fixa em português (nome, fruta, animal, objeto, cor, país, comida, profissão, marca, cidade).
- Quem joga manda no privado: `!stop-resp fruta: banana, animal: bode`.
- 90 segundos. `!stop-fim` encerra antes, se quem começou pedir.
- Pontos: começa com a letra, não vazia e única na categoria = 10. Repetida = 5. Não confere se a palavra existe.
- `!stop-ranking` pontos acumulados do grupo.
- Partida ativa só na memória.

## Relacionamento

Só no grupo. A outra pessoa entra por menção. Sem menção, o comando explica como usar.

Estados por par, no grupo: pedido de namoro, namoro, pedido de casamento, casamento, pedido de separação. Um pedido aberto expira em 24 horas.

| Comando | Efeito |
|---|---|
| `!namorar` @ | Abre pedido. A outra pessoa aceita com `!namorar` sem marcar ninguém. Não dá para namorar duas pessoas no mesmo grupo. |
| `!casar` @ | Só se os dois já namoram. Aceite com `!casar` sem marcar ninguém. |
| `!separar` | Sem marca: pede o fim do relacionamento atual. O outro aceita com `!separar`. 24 h sem resposta cancela o pedido, não o relacionamento. |
| `!recusar` | Recusa o pedido aberto dirigido a quem mandou. |
| `!celibar` | Encerra todos os relacionamentos de quem mandou naquele grupo. |
| `!coisar` @ | Mensagem aleatória com a pessoa marcada, ou com um membro aleatório se não houver marca. Não muda estado. |
| `!trair` @ | Se quem manda está em relacionamento, registra a traição na ficha e avisa o par. Não encerra sozinho. |
| `!relacionamento` | Ficha de quem mandou. |
| `!relacionamentos` | Lista do grupo. |

Não usa a cota diária.

## Zoeira

Não usa a cota diária. Frases copiadas do Ravena para `data/phrases.json` (MIT, crédito no topo do arquivo): `biscoito-frases`, `cantadas-ruins`, `violencia`, `morreu`, `aniversario`, `pecados`, `presente`, `genshin`.

| Comando | Efeito |
|---|---|
| `!biscoito` | Frase aleatória. |
| `!cantada` | No grupo, cantada para alguém marcado ou aleatório. No privado, pede para usar no grupo. |
| `!violencia` | Frase aleatória. Sem alvo real. |
| `!morreu` | Frase curta aleatória. |
| `!boleto` | Sorteia um membro do grupo para “pagar”. Texto deixa claro que é fictício. |
| `!pagar` | Resposta ao boleto: diz que pagou, sem dinheiro. |
| `!presente` | Sorteia um item da lista. |
| `!pix` | Valor fictício para a pessoa marcada. A mensagem diz que não é um Pix de verdade. |
| `!aniversario` @ | Parabéns para quem foi marcado. |
| `!pecar` | Sorteia um pecado e soma 1 na ficha da pessoa. |
| `!meus-pecados` | Total de pecados. |
| `!genshin` | Sorteia personagem, elemento e arma das listas. |
| `!hora` | Data e hora de Brasília. |
| `!pinto` | Medição, só no grupo. Ver abaixo. |

### Pinto

Mesma regra do Ravena, texto no estilo do FigBot. Médico: “Dr. FigBot”.

- Só no grupo.
- `!pinto` mede quem mandou. `!pinto` com menção mede a pessoa marcada.
- Flácido 3,0–12,0 cm, ereto 5,0–25,0 cm, circunferência 8,0–18,0 cm, curvatura −30° a 30°, uma casa decimal.
- Nota 0–1000: flácido 20%, ereto 50%, circunferência 20%, curvatura 10% (0° vale o máximo).
- Comentário por faixa de nota, como no Ravena.
- Uma medição a cada 3 dias por pessoa, por grupo. Fora do prazo, mostra a data da próxima.
- O valor fica salvo e o ranking usa esse valor.
- `!pinto-ranking` top 10 do grupo.
- `!pinto-reset` só admin (`isAdmin`), apaga o ranking daquele grupo.

## Anúncio do admin

`!anunciar` seguido do texto. Só `isAdmin`. Manda a novidade no privado de quem já usou o bot, em lotes, para não parecer spam.

- O texto tem de 1 a 500 caracteres. Vazio explica o comando e não envia nada.
- Destino: o privado (`<número>@s.whatsapp.net`) de cada número já visto. Não manda em grupo.
- Quem entra na lista: qualquer pessoa que manda um comando, menos o próprio admin. O registro acontece no despacho, antes do handler.
- A lista persiste. A cota diária não serve, porque ela esquece quem não usou hoje.
- Lotes de 5 mensagens. 20 segundos entre uma mensagem e outra, 60 segundos entre lotes.
- Um anúncio por vez. O segundo recebe “já tem um anúncio em andamento” e não entra na fila.
- Retoma de onde parou se o processo cair: guarda o texto, os números e o índice do próximo.
- Números que falharem são pulados e contados. Não tenta de novo nesse anúncio.
- Ao terminar, o admin recebe o resumo: enviados, falhas e total.
- No início, o admin recebe “vou avisar N pessoas, em lotes de 5”.
- `!anunciar-parar` interrompe o anúncio atual. O que já saiu não volta.

## Persistência

`store.js` escolhe o backend:

- Com `DATABASE_URL`: tabelas MySQL criadas em `setupDatabase`.
- Sem banco: um JSON por domínio em `data/` (`fishing.json`, `slots.json`, `roleta.json`, `anagram.json`, `stop.json`, `social.json`, `jokes.json`, `pinto.json`, `known-users.json`, `announce.json`), escrita atômica no padrão de `limits.js`.
- `known_users` guarda o número na primeira vez que a pessoa manda um comando. `announce` guarda o anúncio em andamento (texto, lista e próximo índice) e é apagado ao terminar ou ao parar.

Chave de pessoa: número do telefone (`phoneOf`). Chave de grupo: o JID do grupo.

Partidas ativas de anagrama e stop não vão para o disco.

## Testes

`node --test` sem WhatsApp:

- nota do pinto nos extremos e no meio
- embaralhamento do anagrama não devolve a palavra original quando ela tem letras diferentes
- pontuação do stop: única 10, repetida 5, letra errada 0
- regeneração de isca e de moeda dado um relógio injetado
- `!menu` e `!menu jogos` contêm os comandos certos
- o anúncio recusa quem não é admin, recusa texto vazio e monta lotes de 5 sem chamar o WhatsApp

## Licença

Trechos de dados copiados do Ravena levam, em `data/NOTICE.md`, o aviso MIT e o copyright `(c) 2026 moothz`.
