/**
 * Private-score sync — behavioral test of the exact wiring MyRoom uses:
 *
 *   - `score` is a `.view()` field on Player
 *   - each client's `StateView` holds ONLY their own Player
 *   - `x`/`y` are unfiltered and broadcast to everyone
 *
 * What is verified (mirrors the reported scenario, 800x600 map):
 *   1. Full sync: owner decodes own score; the OTHER client decodes the
 *      same player's x/y but never its score.
 *   2. Delta move: coordinates keep flowing to everyone; no score rides
 *      along for non-owners.
 *   3. Score change 7 → 9: owner's client updates; the other client never
 *      receives the 9 (nor the 7 before it).
 *   4. Two players on the SAME coordinate: dots overlap, scores stay
 *      per-owner.
 *   5. Disconnect + rejoin: the room's record (9) is restored for the
 *      owner; the other client saw the dot the whole time and still has
 *      no score.
 *
 * The room below is a minimal, DB-free mirror of `src/MyRoom.ts` — the
 * privacy behavior lives entirely in the schema tag + StateView wiring,
 * which is identical in both.
 */
import assert from 'node:assert';
import { describe, it, before, after } from 'node:test';

import { CloseCode, Room, Server, matchMaker, type Client } from '@colyseus/core';
import { schema, t, StateView, type SchemaType } from '@colyseus/schema';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client as SdkClient } from '@colyseus/sdk';

const PORT = 18_267;
const URL = `ws://localhost:${PORT}`;

// ── Room: same state shape + view wiring as MyRoom ──────────────────────

const Player = schema({
  x: t.number(),
  y: t.number(),
  score: t.number().view(),
});
type Player = SchemaType<typeof Player>;

const State = schema({
  mapWidth: t.number(),
  mapHeight: t.number(),
  players: t.map(Player),
});
type State = SchemaType<typeof State>;

class PrivateScoreRoom extends Room<{ state: State }> {
  state = new State();

  onCreate() {
    this.state.mapWidth = 800;
    this.state.mapHeight = 600;

    this.onMessage("move", (client, message: { x: number, y: number }) => {
      const player = this.state.players.get(client.sessionId)!;
      player.x = message.x;
      player.y = message.y;
    });

    this.onMessage("score", (client, message: { value: number }) => {
      this.state.players.get(client.sessionId)!.score = message.value;
    });
  }

  onJoin(client: Client, options: any) {
    const player = new Player();
    player.x = options?.x ?? 0;
    player.y = options?.y ?? 0;
    player.score = options?.score ?? 0;
    this.state.players.set(client.sessionId, player);

    // after players.set(): StateView refuses detached instances
    client.view = new StateView();
    client.view.add(player);
  }

  async onLeave(client: Client, code: number) {
    try {
      if (code === CloseCode.CONSENTED) { throw new Error("consented leave"); }
      await this.allowReconnection(client, 10);
    } catch (e) {
      this.state.players.delete(client.sessionId);
      client.view?.dispose();
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

async function until(fn: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) { throw new Error(`timeout waiting for: ${what}`); }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Give the server a few patch windows (patchRate defaults to 50ms). */
const aFewPatchWindows = () => new Promise((r) => setTimeout(r, 250));

// ── test ─────────────────────────────────────────────────────────────────

describe('private score (view-filtered sync)', () => {
  let server: Server;

  before(async () => {
    server = new Server({ transport: new WebSocketTransport({}) });
    server.define('test', PrivateScoreRoom);
    await server.listen(PORT);
  });

  after(async () => {
    await server?.gracefullyShutdown(false);
  });

  it('keeps scores owner-only while positions stay public', async () => {
    const sdkA = new SdkClient(URL);
    const sdkB = new SdkClient(URL);

    // 甲 joins at (120, 80) with score 7
    const roomA: any = await sdkA.joinOrCreate('test', { x: 120, y: 80, score: 7 });
    roomA.reconnection.minUptime = 0; // allow immediate reconnection (default is 5s)

    // 乙 joins elsewhere with score 4
    const roomB: any = await sdkB.joinOrCreate('test', { x: 500, y: 400, score: 4 });

    await until(() => roomA.state.players.size === 2, 'A sees both players');
    await until(() => roomB.state.players.size === 2, 'B sees both players');

    const aSelf = () => roomA.state.players.get(roomA.sessionId);
    const bSelf = () => roomB.state.players.get(roomB.sessionId);
    const aSeenByB = () => roomB.state.players.get(roomA.sessionId);
    const bSeenByA = () => roomA.state.players.get(roomB.sessionId);

    // ── 1. full sync ──
    // Note: for non-owners the score is not 0 — it is `undefined`. The
    // field never travels on the wire for them, so it never materializes
    // on their decoded Player at all ("the column is empty").
    assert.strictEqual(aSelf().score, 7, 'A sees own score 7');
    assert.strictEqual(bSelf().score, 4, 'B sees own score 4');
    assert.strictEqual(aSeenByB().x, 120, 'B sees A.x');
    assert.strictEqual(aSeenByB().y, 80, 'B sees A.y');
    assert.strictEqual(aSeenByB().score, undefined, "B never received A's 7");
    assert.strictEqual(bSeenByA().score, undefined, "A never received B's 4");

    // ── 2. delta move to (340, 220) ──
    roomA.send("move", { x: 340, y: 220 });
    await until(() => aSeenByB().x === 340 && aSeenByB().y === 220, 'B sees A move to 340,220');
    assert.strictEqual(aSelf().x, 340, 'A sees own move');
    assert.strictEqual(aSeenByB().score, undefined, 'move delta carried no score to B');
    assert.strictEqual(aSelf().score, 7, 'A keeps own 7');

    // ── 3. score change 7 → 9, coordinates untouched ──
    roomA.send("score", { value: 9 });
    await until(() => aSelf().score === 9, 'A sees own score become 9');
    await aFewPatchWindows();
    assert.strictEqual(aSeenByB().score, undefined, 'B never received the 9');
    assert.strictEqual(aSeenByB().x, 340, 'B still sees A at 340,220');
    assert.strictEqual(bSelf().score, 4, 'B keeps own 4');

    // ── 4. overlap: B walks to the same (340, 220) ──
    roomB.send("move", { x: 340, y: 220 });
    await until(() => bSeenByA().x === 340 && bSeenByA().y === 220, 'A sees B at 340,220');
    await until(() => bSelf().x === 340 && bSelf().y === 220, 'B sees itself at 340,220');
    assert.strictEqual(aSelf().score, 9, 'overlapping dots: A still sees own 9');
    assert.strictEqual(bSelf().score, 4, 'overlapping dots: B still sees own 4');
    assert.strictEqual(aSeenByB().score, undefined, 'B has no score for A');
    assert.strictEqual(bSeenByA().score, undefined, 'A has no score for B');

    // ── 5. A drops abnormally; B keeps seeing A's dot; A rejoins with 9 ──
    const serverRoom = matchMaker.getLocalRoomById(roomA.roomId)!;
    const serverClientA = serverRoom.clients.find((c) => c.sessionId === roomA.sessionId)!;
    (serverClientA as any).ref.terminate(); // abnormal drop, no LEAVE handshake

    await until(() => roomA.reconnection.isReconnecting, 'A notices the drop');
    // during the reconnection window the room keeps A's player for everyone else
    assert.strictEqual(aSeenByB().x, 340, "B still sees A's dot while A is gone");
    assert.strictEqual(aSeenByB().score, undefined, '…and still no score');

    await until(() => !roomA.reconnection.isReconnecting, 'A reconnects');
    await until(() => aSelf()?.score === 9, 'A gets the room-recorded 9 back');
    assert.strictEqual(aSelf().x, 340, 'A back at 340,220');
    await aFewPatchWindows();
    assert.strictEqual(aSeenByB().score, undefined, 'B still has no score after A rejoins');
    assert.strictEqual(bSelf().score, 4, 'B unaffected');

    await roomA.leave();
    await roomB.leave();
  });
});
