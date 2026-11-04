const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(__dirname, '../..');   // mappen med de tre repos
const DEMO = path.join(ROOT, 'LaerbarXR-Builder/demo-scenarios/one-day-six-directions.lxr');
const LAUNCH = { executablePath: process.env.CHROMIUM || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] };
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const RELAY = 'https://laerbarxr-relay.haulik-mhk.workers.dev';
const LOCAL = 'http://127.0.0.1:8787';
const KEY = 'k-test-1';
const TITLE = 'One Day, Six Directions - Demo';
const post = (path, body) => fetch(LOCAL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

(async () => {
  // fyld relayet: et gammelt og et nyt gennemløb af samme simulation
  const old = new Date(Date.now() - 10 * 864e5).toISOString(), now = new Date().toISOString();
  for (const [h, f] of [['Headset 09', old], ['Headset 02', now]]) {
    await post('/api/results', { headsetId: h, deviceId: 'd' + h, hold: 'Hold 1', simulation: TITLE, scenario: TITLE, finished_at: f,
      events: [{ action: 'session_start', started_at: f, session_time_sec: 0 }, { action: 'session_end', duration_sec: 30, session_time_sec: 30 }] });
  }
  const b = await chromium.launch(LAUNCH);
  let pingSkewSec = 0;
  // Hver context er sin egen browserprofil (egen localStorage), altså en
  // computer eller et headset. withKey gemmer lærernøglen på forhånd.
  const newCtx = async (withKey) => {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  if (withKey) await ctx.addInitScript(k => { try { localStorage.setItem('lxr_teacher_key', k); } catch (e) {} }, KEY);
  await ctx.route(RELAY + '/**', async route => {
    const req = route.request();
    const url = req.url().replace(RELAY, LOCAL);
    if (url.includes('/api/ping') && pingSkewSec) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true, time: Date.now() / 1000 + pingSkewSec }) });
    }
    const r = await fetch(url, { method: req.method(), headers: { 'Content-Type': 'application/json' }, body: req.postData() || undefined });
    route.fulfill({ status: r.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: await r.text() });
  });
  return ctx;
  };
  const ctx = await newCtx(false);
  const errs = [];
  const openPlayer = async (c, name) => {
    const p = await c.newPage();
    p.on('pageerror', e => errs.push('player ' + e.message));
    await p.goto('http://localhost:8765/LaerbarXR-Player/index.html');
    await p.evaluate(n => { localStorage.setItem('lxr_headset_id', n); localStorage.setItem('lxr_headset_group', 'Hold 1'); }, name);
    await p.reload();
    await p.setInputFiles('#file-input', DEMO).catch(() => {});
    await p.waitForTimeout(3000);
    await p.evaluate(() => attemptStart(startFlatPreview));
    await p.waitForTimeout(1500);
    return p;
  };
  const state = p => p.evaluate(() => currentRunStatus);

  // ---- Dashboard
  const d = await ctx.newPage();
  d.on('pageerror', e => errs.push('dash ' + e.message));
  await d.goto('http://localhost:8765/LaerbarXR-Dashboard/index.html');
  await d.setInputFiles('#session-file-input', DEMO);
  await d.waitForTimeout(3000);
  ok(await d.locator('#teacher-key-box').isVisible(), 'dashboard asks for teacher key when relay is locked');
  ok(!(await d.locator('#live-control-body').isVisible()), 'start/stop buttons hidden while locked');
  await d.fill('#teacher-key-input', 'wrong'); await d.click('#teacher-key-box button');
  await d.waitForTimeout(1500);
  ok((await d.locator('#relay-status-text').innerText()).includes('Forkert'), 'wrong key is reported');
  await d.fill('#teacher-key-input', KEY); await d.click('#teacher-key-box button');
  await d.waitForTimeout(6000);
  ok(!(await d.locator('#teacher-key-box').isVisible()) && await d.locator('#live-control-body').isVisible(), 'correct key unlocks live controls');
  const parts = await d.evaluate(() => AppState.liveSessions[0].participants.map(p => p.name));
  ok(parts.length === 1 && parts[0] === 'Headset 02', 'only the recent relay result was imported, 10-day-old one skipped (' + parts + ')');
  const ids = await d.evaluate(() => AppState.liveSessions[0].participants.map(p => p.id));
  ok(ids.every(i => /^p-live-\d+-[a-z0-9]+$/.test(i)), 'participant id is unique-format (' + ids + ')');
  // nøglen huskes efter genindlæsning
  await d.reload(); await d.waitForTimeout(5000);
  ok(!(await d.locator('#teacher-key-box').isVisible()), 'key remembered after reload');
  ok(await d.evaluate(() => AppState.liveSessions[0].participants.length) === 1, 'no duplicate import after reload');
  // Start All (kræver nøgle) -> når frem til relayet
  await d.evaluate(() => App.sendCommand('all', 'start'));
  await d.waitForTimeout(1000);
  const cmd = await (await fetch(LOCAL + '/api/command?since=0&headsetId=x&group=y')).json();
  ok(cmd.command && cmd.command.action === 'start' && cmd.command.scenario === TITLE, 'Start All reached the relay with the key');

  // ---- Player: et Start sendt før headsettet ventede, frigiver det aldrig
  const run = async (skew, label) => {
    pingSkewSec = skew;
    const p = await openPlayer(ctx, 'Headset 05');
    await p.waitForTimeout(4000);
    const st = await p.evaluate(() => [waitingForStart, currentRunStatus, relayAvailable]);
    ok(st[0] === true && st[1] === 'waiting' && st[2] === true, label + ' ' + JSON.stringify(st));
    await p.close();
  };
  await run(3600, 'Start All from "1h ago" (relay clock ahead) is ignored — headset keeps waiting');
  await run(0, 'Start All from before this headset was waiting is ignored (late joiner waits for the next Start)');
  pingSkewSec = 0;

  // ---- To lokaler, samme simulation, samme headsetnummer, overlappende
  const ctxDA = await newCtx(true), ctxDB = await newCtx(true);
  const dA = await ctxDA.newPage(), dB = await ctxDB.newPage();
  for (const dd of [dA, dB]) {
    dd.on('pageerror', e => errs.push('dash ' + e.message));
    await dd.goto('http://localhost:8765/LaerbarXR-Dashboard/index.html');
    await dd.setInputFiles('#session-file-input', DEMO);
  }
  await dA.waitForTimeout(3000);
  const baseA = await dA.evaluate(() => AppState.liveSessions[0].participants.length);
  const baseB = await dB.evaluate(() => AppState.liveSessions[0].participants.length);
  const pA = await openPlayer(await newCtx(false), 'Headset 03');           // lokale A, 10:00
  ok(await state(pA) === 'waiting', 'room A headset waits for its teacher');
  await dA.evaluate(() => App.sendCommand('all', 'start'));
  await pA.waitForTimeout(3500);
  ok(await state(pA) === 'running', 'room A teacher Start releases room A headset');
  const pB = await openPlayer(await newCtx(false), 'Headset 03');           // lokale B, 10:01
  await pB.waitForTimeout(4000);
  ok(await state(pB) === 'waiting', 'room B headset is NOT started by room A\'s Start a moment earlier');
  await dB.evaluate(() => App.sendCommand('all', 'start'));
  await pB.waitForTimeout(3500);
  ok(await state(pB) === 'running', 'room B teacher Start releases room B headset');
  const relayState = await (await fetch(LOCAL + '/api/state?key=' + KEY)).json();
  ok(relayState.headsets.filter(h => h.headsetId === 'Headset 03').length === 2, 'both rooms\' "Headset 03" are separate on the relay');
  await dA.waitForTimeout(2500);
  const liveA = await dA.evaluate(() => AppState.liveHeadsets.filter(h => h.headsetId === 'Headset 03').map(h => h.origin === App.dashboardId()));
  ok(liveA.length === 1 && liveA[0] === true, 'room A Dashboard only sees its own Headset 03 (' + liveA + ')');
  await dA.evaluate(() => App.sendCommand('all', 'stop'));
  await pA.waitForTimeout(4500);
  ok(await state(pA) !== 'running', 'room A End All ends room A headset');
  ok(await state(pB) === 'running', 'room A End All does NOT end room B headset');
  await dA.waitForTimeout(5000);
  ok(await dA.evaluate(() => AppState.liveSessions[0].participants.length) === baseA + 1, 'room A result arrives on room A Dashboard');
  ok(await dB.evaluate(() => AppState.liveSessions[0].participants.length) === baseB, 'room A result does NOT arrive on room B Dashboard');
  await dB.evaluate(() => App.sendCommand('all', 'stop'));
  await pB.waitForTimeout(4500);
  ok(await state(pB) !== 'running', 'room B End All ends room B headset');
  await dB.waitForTimeout(5000);
  ok(await dB.evaluate(() => AppState.liveSessions[0].participants.length) === baseB + 1, 'room B result arrives on room B Dashboard');
  ok(await dA.evaluate(() => AppState.liveSessions[0].participants.length) === baseA + 1, 'room B result does NOT arrive on room A Dashboard');

  // ---- Player ignorerer preview-beskeder, der ikke kommer fra et indlejrende vindue
  const p2 = await ctx.newPage();
  await p2.goto('http://localhost:8765/LaerbarXR-Player/index.html');
  await p2.evaluate(() => window.postMessage({ type: 'lxrPreviewLoad', scenario: { nodes: [], title: 'x' }, assets: [] }, '*'));
  await p2.waitForTimeout(500);
  ok(await p2.evaluate(() => previewEmbedMode === false && !sessionData), 'top-level Player ignores forged preview message');

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  process.exit(failed ? 1 : 0);
})();
