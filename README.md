# FigBot

Bot de WhatsApp que transforma foto em figurinha. Feito com Baileys e Sharp, sem navegador, para caber no free tier da Silly Development (256 MB de RAM).

## Como usar

Mande no privado:

- `!menu` mostra as opções
- foto com a legenda `!fig` vira figurinha
- responder uma foto com `!fig` também funciona
- `!fig fill` preenche o quadrado cortando as bordas
- `!fig stretch` estica a imagem
- `!resto` mostra quantas figurinhas ainda restam hoje
- `1`, `2` e `3` repetem as opções do menu

Em grupo o bot só responde quando é mencionado.

## Proteção contra ban

- 15 figurinhas por dia, por número
- 10 segundos entre uma figurinha e outra
- no máximo 16 MB por arquivo
- em grupo, só responde se for mencionado
- mensagem sem comando é ignorada
- espera 0,8 segundo antes de cada resposta

O uso fica em `data/usage.json` e continua valendo depois de reiniciar.

## Deploy

O `sillydev.conf` já aponta para Node.js 25 e `index.js`. O painel instala o `package.json` sozinho.

1. Envie este código para `main`.
2. No painel, em Startup, crie `PHONE_NUMBER` com o número em dígitos, por exemplo `5511999998888`.
3. Inicie o servidor e copie o código que aparece no console.
4. No WhatsApp: Aparelhos conectados, Conectar com número de telefone.

A pasta `session/` fica no disco do servidor e não entra no Git. Não apague ela, senão é preciso parear de novo.

## Ajustes

Estas variáveis são opcionais:

- `DAILY_LIMIT` padrão `15`
- `COOLDOWN_SECONDS` padrão `10`
- `MAX_MEDIA_MB` padrão `16`
- `PHONE_NUMBER` número usado no pareamento
