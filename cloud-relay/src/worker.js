/**
 * LærbarXR cloud-relay: samme opgave som relay.py (heartbeats ind,
 * start/stop-kommandoer ud, resultater ind), men via internettet.
 *
 * Skolers og hospitalers Wi-Fi har ofte klientisolation og blokerede porte,
 * så enhederne ikke kan nå hinanden lokalt. Her taler alle enheder kun med
 * denne Worker over HTTPS. Kan et headset slet ikke komme på nettet, spiller
 * det alene og gemmer resultatet lokalt til import i Dashboardet.
 *
 * DATA
 * ----
 * Én global Durable Object (SQLite, så det kører på Workers Free).
 *
 *   headsets      seneste heartbeat pr. headset; glemmes efter 6 timers stilhed
 *   commands      kun tilføjelser, de seneste 500
 *   r:<seq>       én nøgle pr. resultat, slettes efter 7 dage
 *   rindex        [[seq, savedAtSec], …] til oprydning og paging
 *
 * Resultaterne lå før i ét array under én nøgle. Det ramte værdiens
 * størrelsesgrænse og blev aldrig ryddet. `seq` fortsætter den gamle
 * nummerering, så et Dashboard med en gammel `since` stadig virker.
 *
 * LOKALER
 * -------
 * Flere lokaler kan køre samme simulation samtidig. Koblingen sker ved Start:
 * hver kommando har afsenderens `origin`, headsettet husker origin fra den
 * Start der frigav det og sender den med i heartbeats og resultater. Et Stop
 * fra et andet Dashboard ignoreres, og hvert Dashboard viser kun sin egen
 * origin (eller ingen, for ældre klienter). Headsets har nøgle pr. enhed og
 * navn, så to lokalers "Headset 03" er to poster.
 *
 * ADGANG
 * ------
 * Headsets skal ikke logge ind: de skriver heartbeats/resultater og læser
 * kommandoer. Læsning af resultater og headsets samt afsendelse af kommandoer
 * hører til læreren. Er TEACHER_KEY sat (Settings → Variables and Secrets),
 * kræver de tre ?key=<nøgle>; Dashboardet spørger én gang pr. computer. Uden
 * nøgle er relayet åbent.
 */

const ONLINE_TIMEOUT_SEC = 12;
const FORGET_TIMEOUT_SEC = 6 * 3600;       // som relay.py
const RESULT_RETENTION_SEC = 7 * 24 * 3600; // klassedata gemmes 7 dage
const MAX_COMMANDS = 500;                   // som relay.py
const MAX_RESULT_BYTES = 512 * 1024;        // et gennemløb fylder få KB

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

const RELAY_VERSION = "2026-10-live-answers";
const RECENT_COMMANDS_SEC = 15 * 60;       // historik headsettet skal bruge til Start/Stop
const nowSec = () => Date.now() / 1000;
const headsetKey = (b) => String(b.deviceId || "") + "|" + String(b.headsetId || "Unnamed headset");
const resultKey = (seq) => "r:" + String(seq).padStart(12, "0");
const cleanAnswers = (a) =>
  Array.isArray(a)
    ? a.slice(0, 100)
        .filter((x) => x && typeof x.n === "string")
        .map((x) => ({
          n: x.n.slice(0, 80),
          c: x.c ? 1 : 0,
          // valgte svar som indeks i scenens choices
          a: Array.isArray(x.a) ? x.a.filter((i) => Number.isInteger(i) && i >= 0 && i < 100).slice(0, 20) : [],
        }))
    : [];

export class RelayState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.headsets = (await ctx.storage.get("headsets")) || {};
      this.commands = (await ctx.storage.get("commands")) || [];
      this.nextCommandId = (await ctx.storage.get("nextCommandId")) || 1;
      this.rindex = (await ctx.storage.get("rindex")) || [];
      this.lastSeq = (await ctx.storage.get("lastSeq")) || 0;
      await this.migrateLegacyResults();
      await this.pruneResults();
    });
  }

  // Engangsflytning fra det gamle "results"-array til én nøgle pr. resultat.
  // Plads i i arrayet → seq i+1, så `since` stadig passer. Det der allerede
  // er for gammelt, kommer ikke med.
  async migrateLegacyResults() {
    const legacy = await this.ctx.storage.get("results");
    if (!Array.isArray(legacy)) return;
    const cutoff = nowSec() - RESULT_RETENTION_SEC;
    for (let i = 0; i < legacy.length; i++) {
      const seq = i + 1;
      const t = Date.parse(legacy[i] && legacy[i].finished_at) / 1000;
      if (isFinite(t) && t >= cutoff) {
        await this.ctx.storage.put(resultKey(seq), legacy[i]);
        this.rindex.push([seq, t]);
      }
    }
    this.lastSeq = Math.max(this.lastSeq, legacy.length);
    await this.ctx.storage.put({ rindex: this.rindex, lastSeq: this.lastSeq });
    await this.ctx.storage.delete("results");
  }

  async pruneResults() {
    const cutoff = nowSec() - RESULT_RETENTION_SEC;
    const old = this.rindex.filter(([, t]) => t < cutoff);
    if (!old.length) return;
    // delete() tager højst 128 nøgler pr. kald.
    for (let i = 0; i < old.length; i += 128) {
      await this.ctx.storage.delete(old.slice(i, i + 128).map(([seq]) => resultKey(seq)));
    }
    this.rindex = this.rindex.filter(([, t]) => t >= cutoff);
    await this.ctx.storage.put("rindex", this.rindex);
  }

  async pruneHeadsets() {
    const now = nowSec();
    let changed = false;
    for (const id of Object.keys(this.headsets)) {
      if (now - (this.headsets[id].lastSeen || 0) > FORGET_TIMEOUT_SEC) {
        delete this.headsets[id];
        changed = true;
      }
    }
    if (changed) await this.ctx.storage.put("headsets", this.headsets);
  }

  teacherOk(url) {
    const key = this.env && this.env.TEACHER_KEY;
    return !key || url.searchParams.get("key") === key;
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const path = url.pathname;
    const teacherOnly =
      (request.method === "GET" && (path === "/api/state" || path === "/api/results")) ||
      (request.method === "POST" && path === "/api/command");
    if (teacherOnly && !this.teacherOk(url)) {
      return json({ error: "teacher key required" }, 401);
    }

    if (request.method === "GET" && path === "/api/ping") {
      // `version` gør det muligt at tjekke i browseren, hvilket build der kører.
      return json({ ok: true, time: nowSec(), version: RELAY_VERSION });
    }

    if (request.method === "GET" && path === "/api/state") {
      await this.pruneHeadsets();
      const now = nowSec();
      const headsets = Object.values(this.headsets).map((h) => ({
        ...h,
        online: now - (h.lastSeen || 0) <= ONLINE_TIMEOUT_SEC,
      }));
      return json({ headsets });
    }

    if (request.method === "GET" && path === "/api/command") {
      const headsetId = url.searchParams.get("headsetId") || "";
      const group = url.searchParams.get("group") || "";
      const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const applicable = this.commands.filter(
        (c) =>
          c.id > since &&
          (c.scope === "all" ||
            (c.scope === "group" && c.target === group) ||
            (c.scope === "headset" && c.target === headsetId))
      );
      const latest = applicable.length ? applicable[applicable.length - 1] : null;
      // Ældre Players læser `command` (kun den seneste). Nyere læser `commands`:
      // alle relevante kommandoer fra de sidste 15 min, så et Stop ikke skjules
      // af et senere Start fra et andet lokale.
      const recentFrom = nowSec() - RECENT_COMMANDS_SEC;
      const commands = applicable.filter((c) => c.ts >= recentFrom).slice(-50);
      return json({ command: latest, commands });
    }

    if (request.method === "GET" && path === "/api/results") {
      await this.pruneResults();
      const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const seqs = this.rindex.filter(([seq]) => seq > since).map(([seq]) => seq);
      const results = [];
      // get() tager højst 128 nøgler pr. kald.
      for (let i = 0; i < seqs.length; i += 128) {
        const got = await this.ctx.storage.get(seqs.slice(i, i + 128).map(resultKey));
        seqs.slice(i, i + 128).forEach((seq) => {
          const r = got.get(resultKey(seq));
          if (r) results.push(r);
        });
      }
      // `total` er den cursor, der sendes tilbage som `since` (seneste seq).
      return json({ results, total: this.lastSeq });
    }

    if (request.method === "POST" && path === "/api/heartbeat") {
      const body = await readJson(request);
      const headsetId = String(body.headsetId || "Unnamed headset");
      this.headsets[headsetKey(body)] = {
        headsetId,
        deviceId: body.deviceId || "",
        origin: body.origin || "", // Dashboardet hvis Start frigav headsettet ("" = ingen endnu)
        group: body.group || "Hold 1",
        scenario: body.scenario || "",
        nodeId: body.nodeId || "",
        nodeTitle: body.nodeTitle || "",
        status: body.status || "idle", // idle|waiting|running|done
        sessionTimeSec: body.sessionTimeSec || 0,
        // Første svar pr. spørgsmål, [{n: nodeId, c: 1|0, a: [svarindeks]}], til
        // Dashboardets "8/12 svarede rigtigt". Et gennemløb har højst nogle
        // dusin spørgsmål, og værdien overskrives ved hvert heartbeat.
        answers: cleanAnswers(body.answers),
        lastSeen: nowSec(),
      };
      await this.ctx.storage.put("headsets", this.headsets);
      return json({ ok: true });
    }

    if (request.method === "POST" && path === "/api/command") {
      const body = await readJson(request);
      const cmd = {
        id: this.nextCommandId,
        scope: body.scope || "all",
        target: body.target ?? null,
        action: body.action || "start",
        scenario: body.scenario || "",
        origin: body.origin || "",
        ts: nowSec(),
      };
      this.nextCommandId += 1;
      this.commands.push(cmd);
      if (this.commands.length > MAX_COMMANDS) {
        this.commands = this.commands.slice(-MAX_COMMANDS);
      }
      await this.ctx.storage.put({ commands: this.commands, nextCommandId: this.nextCommandId });
      return json({ ok: true, command: cmd });
    }

    if (request.method === "POST" && path === "/api/results") {
      const raw = await request.text();
      if (raw.length > MAX_RESULT_BYTES) return json({ error: "result too large" }, 413);
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || typeof body !== "object" || !Array.isArray(body.events)) {
        return json({ error: "not a result" }, 400);
      }
      this.lastSeq += 1;
      const seq = this.lastSeq;
      this.rindex.push([seq, nowSec()]);
      await this.ctx.storage.put({ [resultKey(seq)]: body, rindex: this.rindex, lastSeq: this.lastSeq });

      const hid = headsetKey(body);
      if (this.headsets[hid]) {
        this.headsets[hid].status = "done";
        this.headsets[hid].lastSeen = nowSec();
        await this.ctx.storage.put("headsets", this.headsets);
      }
      await this.pruneResults();
      return json({ ok: true, index: seq });
    }

    return json({ error: "Not found" }, 404);
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "LærbarXR cloud relay is running. Point the Dashboard and Player at this URL.\n",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    if (url.pathname.startsWith("/api/")) {
      // Én instans er nok, ligesom relay.py's globale STATE.
      const id = env.RELAY.idFromName("singleton");
      const stub = env.RELAY.get(id);
      return stub.fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
};
