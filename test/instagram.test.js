import test from "node:test";
import assert from "node:assert/strict";
import { igLinkOf, pickIgItems, pickIgPhoto, pickIgVideo, shortcodeOf } from "../instagram.js";
import { socialLinkOf, xLinkOf } from "../link.js";

test("reconhece post, reel, reels e tv do Instagram", () => {
  assert.equal(igLinkOf("olha https://www.instagram.com/p/BQ0eAlwhDrw/?img_index=2").shortcode, "BQ0eAlwhDrw");
  assert.equal(igLinkOf("https://instagram.com/reel/CDUMkliABpa/").shortcode, "CDUMkliABpa");
  assert.equal(igLinkOf("https://www.instagram.com/reels/Cop84x6u7CP/").shortcode, "Cop84x6u7CP");
  assert.equal(igLinkOf("https://www.instagram.com/tv/BkfuX9UB-eK/").shortcode, "BkfuX9UB-eK");
  assert.equal(
    igLinkOf("https://www.instagram.com/marvelskies.fc/reel/CWqAgUZgCku/").shortcode,
    "CWqAgUZgCku"
  );
  assert.equal(igLinkOf("https://m.instagram.com/p/BQ0eAlwhDrw.").shortcode, "BQ0eAlwhDrw");
});

test("link de compartilhamento não usa o token como shortcode", () => {
  const link = igLinkOf("https://www.instagram.com/share/reel/BAGmno123xyz/");
  assert.equal(link.source, "ig");
  assert.equal(link.shortcode, null);
  assert.equal(shortcodeOf("/share/reel/BAGmno123xyz"), null);
});

test("perfil e link do X não viram post do Instagram", () => {
  assert.equal(igLinkOf("https://www.instagram.com/instagram/"), null);
  assert.equal(igLinkOf("https://x.com/user/status/1"), null);
  assert.equal(xLinkOf("https://www.instagram.com/p/BQ0eAlwhDrw/"), null);
});

test("o primeiro link do texto ganha", () => {
  const igFirst = socialLinkOf("https://www.instagram.com/p/BQ0eAlwhDrw/ e https://x.com/a/status/9");
  assert.equal(igFirst.source, "ig");
  const xFirst = socialLinkOf("https://x.com/a/status/9 https://www.instagram.com/reel/CDUMkliABpa/");
  assert.equal(xFirst.source, "x");
  assert.equal(xFirst.id, "9");
});

test("vídeo do Instagram guarda as versões maiores para o caso da leve vir muda", () => {
  const media = pickIgVideo([
    { url: "https://scontent.cdninstagram.com/alta.mp4", width: 1080 },
    { url: "https://scontent.cdninstagram.com/media.mp4", width: 720 },
    { url: "https://scontent.cdninstagram.com/leve.mp4", width: 480 },
  ]);
  assert.equal(media.url, "https://scontent.cdninstagram.com/leve.mp4");
  assert.deepEqual(media.alternates, [
    "https://scontent.cdninstagram.com/alta.mp4",
    "https://scontent.cdninstagram.com/media.mp4",
  ]);
});

test("foto fica na menor versão que ainda passa de 640px", () => {
  assert.equal(pickIgPhoto([
    { url: "https://scontent.cdninstagram.com/grande.jpg", width: 1440 },
    { url: "https://scontent.cdninstagram.com/media.jpg", width: 640 },
    { url: "https://scontent.cdninstagram.com/mini.jpg", width: 320 },
  ]), "https://scontent.cdninstagram.com/media.jpg");
});

test("carrossel vira foto e vídeo, e capa de vídeo não vira foto", () => {
  const items = pickIgItems({
    media_type: 8,
    video_duration: 99,
    image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/capa.jpg", width: 1080 }] },
    carousel_media: [
      {
        media_type: 1,
        image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/foto.jpg", width: 1080 }] },
      },
      {
        media_type: 2,
        video_duration: 8,
        video_versions: [{ url: "https://scontent.cdninstagram.com/clip.mp4", width: 720 }],
        image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/thumb.jpg", width: 720 }] },
      },
    ],
  });
  assert.deepEqual(items, [
    { kind: "photo", url: "https://scontent.cdninstagram.com/foto.jpg" },
    {
      kind: "video",
      url: "https://scontent.cdninstagram.com/clip.mp4",
      alternates: [],
      seconds: 8,
    },
  ]);
});

test("vídeo sem largura usa a primeira versão que o Instagram mandou", () => {
  const media = pickIgVideo([
    { url: "https://scontent.cdninstagram.com/a.mp4" },
    { url: "https://scontent.cdninstagram.com/b.mp4" },
  ]);
  assert.equal(media.url, "https://scontent.cdninstagram.com/a.mp4");
  assert.deepEqual(media.alternates, ["https://scontent.cdninstagram.com/b.mp4"]);
});
