"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DockerLogDemuxer, splitTimestamp } = require("../../lib/services/docker/log-demux");

/** Construit une frame Docker multiplexée : [type(1)|réservé(3)|taille BE(4)] + payload. */
function frame(streamType, text) {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test("DockerLogDemuxer — décode une frame stdout unique", () => {
  const d = new DockerLogDemuxer(false);
  const out = d.push(frame(1, "hello world\n"));
  assert.deepEqual(out, [{ type: "out", text: "hello world" }]);
});

test("DockerLogDemuxer — distingue stdout (1) et stderr (2)", () => {
  const d = new DockerLogDemuxer(false);
  const chunk = Buffer.concat([frame(1, "ok\n"), frame(2, "boom\n")]);
  const out = d.push(chunk);
  assert.deepEqual(out, [
    { type: "out", text: "ok" },
    { type: "err", text: "boom" },
  ]);
});

test("DockerLogDemuxer — une frame coupée en plein milieu par un chunk réseau reste en attente", () => {
  const d = new DockerLogDemuxer(false);
  const full = frame(1, "ligne complète\n");
  const firstHalf = full.slice(0, 5); // coupe en plein milieu de l'en-tête
  const secondHalf = full.slice(5);

  assert.deepEqual(d.push(firstHalf), []); // rien de décodable encore
  assert.deepEqual(d.push(secondHalf), [{ type: "out", text: "ligne complète" }]);
});

test("DockerLogDemuxer — une frame contenant plusieurs lignes est redécoupée après démultiplexage", () => {
  const d = new DockerLogDemuxer(false);
  const out = d.push(frame(1, "ligne1\nligne2\nligne3\n"));
  assert.deepEqual(out, [
    { type: "out", text: "ligne1" },
    { type: "out", text: "ligne2" },
    { type: "out", text: "ligne3" },
  ]);
});

test('DockerLogDemuxer — mode TTY : pas d\'en-tête, tout est "out", découpe sur \\n', () => {
  const d = new DockerLogDemuxer(true);
  const out = d.push(Buffer.from("a\nb\n"));
  assert.deepEqual(out, [
    { type: "out", text: "a" },
    { type: "out", text: "b" },
  ]);
});

test("DockerLogDemuxer — mode TTY : ligne incomplète attend le prochain chunk", () => {
  const d = new DockerLogDemuxer(true);
  assert.deepEqual(d.push(Buffer.from("debut de ligne")), []);
  assert.deepEqual(d.push(Buffer.from(" fin\n")), [{ type: "out", text: "debut de ligne fin" }]);
});

test("splitTimestamp() — extrait un préfixe RFC3339Nano (timestamps=1)", () => {
  const { at, text } = splitTimestamp("2026-01-02T15:04:05.123456789Z database is ready");
  assert.equal(text, "database is ready");
  assert.equal(at, Date.parse("2026-01-02T15:04:05.123456789Z"));
});

test("splitTimestamp() — ligne sans timestamp renvoyée telle quelle", () => {
  const { at, text } = splitTimestamp("juste une ligne de log");
  assert.equal(at, null);
  assert.equal(text, "juste une ligne de log");
});
