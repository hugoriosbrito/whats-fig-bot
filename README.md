# FigBot

Bot de WhatsApp que transforma foto em figurinha. Feito com Baileys e Sharp, sem navegador, para caber no free tier da Silly Development (256 MB de RAM).

## Como usar

Mande no privado:

- `!menu` mostra as opções
- foto com a legenda `!fig` vira figurinha
- vídeo de até 10 segundos com `!fig` vira figurinha animada
- responder uma foto ou vídeo com `!fig` também funciona
- `!fig fill` preenche o quadrado cortando as bordas
- `!fig stretch` estica a imagem
- `!resto` mostra quantas figurinhas ainda restam hoje
- `1`, `2` e `3` repetem as opções do menu

No grupo, basta usar o comando. Não precisa mencionar o bot.

## Proteção contra ban

- 15 figurinhas por dia, por número
- 10 segundos entre uma figurinha e outra
- no máximo 16 MB por arquivo
- vídeos entram numa fila e só um é convertido por vez
- figurinha animada fica limitada a 500 KB
- mensagem sem comando é ignorada
- espera 0,8 segundo antes de cada resposta

O uso fica em `data/usage.json` e continua valendo depois de reiniciar.

## Deploy

O `sillydev.conf` já aponta para Node.js 25 e `index.js`. Se a instalação cair por instabilidade da rede, o `index.js` tenta novamente até quatro vezes antes de abrir o bot.

1. Faça o deploy da branch `main`.
2. Abra o console do painel.
3. Escaneie o QR code com WhatsApp, em Aparelhos conectados.

A pasta `session/` fica no disco do servidor e não entra no Git. Não apague ela, senão é preciso escanear o QR novamente.

## Ajustes

Estas variáveis são opcionais:

- `DAILY_LIMIT` padrão `15`
- `COOLDOWN_SECONDS` padrão `10`
- `MAX_MEDIA_MB` padrão `16`
- `MAX_VIDEO_SECONDS` padrão `10`
