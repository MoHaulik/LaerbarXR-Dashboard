// Tjekker det UDRULLEDE system: de rigtige Dashboard- og Player-sider og det
// rigtige cloud-relay. Simulerer to lokaler, der kører samme simulation med
// kort mellemrum. Bruger sit eget hold ("Hold 9") og Start/End for kun det
// hold, så en rigtig klasse aldrig startes eller stoppes. De to testresultater
// ligger på relayet i 7 dage, men har testens eget Dashboard-id, så intet
// rigtigt Dashboard viser dem.
//
//   node tests/live.js                       (kræver Playwright + Chromium)
//   BASE=https://mohaulik.github.io node tests/live.js
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(__dirname, '../..');
const DEMO = path.join(ROOT, 'LaerbarXR-Builder/demo-scenarios/one-day-six-directions.lxr');
const BASE = (process.env.BASE || 'https://mohaulik.github.io').replace(/\/$/, '');
const RELAY = 'https://laerbarxr-relay.haulik-mhk.workers.dev';
// Kun til at teste selve scriptet mod en lokal relay.
const ROUTE_RELAY_TO = process.env.ROUTE_RELAY_TO || '';
const LAUNCH = { executablePath: process.env.CHROMIUM || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] };
const HOLD = 'Hold 9', NAME = 'Headset 99';
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const relay = p => fetch((ROUTE_RELAY_TO || RELAY) + p).then(r => r.json().then(j => ({ status: r.status, j })));

(async () => {
  // ---- selve relayet
  const ping = await relay('/api/ping');
  ok(ping.status === 200 && ping.j.ok, 'relay is up');
  const st = await relay('/api/state');
  ok(st.status === 200, 'relay is open (no teacher key) — /api/state ' + st.status);
  const cmd = await relay('/api/command?since=0&headsetId=x&group=y');
  ok(Array.isArray(cmd.j.commands), 'relay runs the new code (returns recent "commands")');

  const b = await chromium.launch(LAUNCH);
  const errs = [];
  const newCtx = async () => {
    const c = await b.newContext({ viewport: { width: 1400, height: 900 } });
    if (ROUTE_RELAY_TO) await c.route(RELAY + '/**', async route => {
      const req = route.request();
      const r = await fetch(req.url().replace(RELAY, ROUTE_RELAY_TO), { method: req.method(), headers: { 'Content-Type': 'application/json' }, body: req.postData() || undefined });
      route.fulfill({ status: r.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: await r.text() });
    });
    return c;
  };
  const openDashboard = async () => {
    const d = await (await newCtx()).newPage();
    d.on('pageerror', e => errs.push('dashboard: ' + e.message));
    await d.goto(BASE + '/LaerbarXR-Dashboard/index.html');
    await d.setInputFiles('#session-file-input', DEMO);
    await d.waitForTimeout(4000);
    return d;
  };
  const openPlayer = async () => {
    const p = await (await newCtx()).newPage();
    p.on('pageerror', e => errs.push('player: ' + e.message));
    await p.goto(BASE + '/LaerbarXR-Player/index.html');
    await p.evaluate(([n, h]) => { localStorage.setItem('lxr_headset_id', n); localStorage.setItem('lxr_headset_group', h); }, [NAME, HOLD]);
    await p.reload();
    await p.setInputFiles('#file-input', DEMO);
    await p.waitForTimeout(3000);
    await p.evaluate(() => attemptStart(startFlatPreview));
    await p.waitForTimeout(3000);
    return p;
  };
  const state = p => p.evaluate(() => currentRunStatus);
  // Start/End kun for testholdet, præcis som "Start mit hold" sender det.
  const send = (d, action) => d.evaluate(([h, a]) => {
    const sel = document.getElementById('start-group-select');
    if (![...sel.options].some(o => o.value === h)) sel.add(new Option(h, h));
    sel.value = h;
    return App.sendCommand('group', a);
  }, [HOLD, action]);
  const parts = d => d.evaluate(n => AppState.liveSessions[0].participants.filter(p => p.name === n).length, NAME);

  // ---- de udrullede sider har den nyeste kode
  const dA = await openDashboard(), dB = await openDashboard();
  ok(await dA.evaluate(() => typeof App.dashboardId === 'function' && typeof App.isTooOld === 'function'), 'deployed Dashboard has the new code');
  ok(await dA.locator('label[for=session-file-input]').innerText() === 'Vælg simulation', 'Dashboard button reads "Vælg simulation"');
  ok(await dA.locator('#live-control-body').isVisible(), 'Dashboard is connected to the relay (live controls shown)');
  ok(!(await dA.locator('#teacher-key-box').isVisible()), 'Dashboard does not ask for a key');

  // ---- to lokaler, samme simulation, samme headsetnummer, et minut imellem
  const pA = await openPlayer();
  ok(await pA.evaluate(() => typeof relayCommands === 'function'), 'deployed Player has the new code');
  ok(await state(pA) === 'waiting', 'room A headset waits for its teacher');
  await send(dA, 'start');
  await pA.waitForTimeout(5000);
  ok(await state(pA) === 'running', 'room A Start releases room A headset');
  const pB = await openPlayer();
  await pB.waitForTimeout(5000);
  ok(await state(pB) === 'waiting', 'room B headset is NOT started by room A\'s Start');
  await send(dB, 'start');
  await pB.waitForTimeout(5000);
  ok(await state(pB) === 'running', 'room B Start releases room B headset');
  await dA.waitForTimeout(3000);
  const seenA = await dA.evaluate(n => AppState.liveHeadsets.filter(h => h.headsetId === n).length, NAME);
  ok(seenA === 1, 'room A Dashboard sees only its own ' + NAME + ' (' + seenA + ')');
  await send(dA, 'stop');
  await pA.waitForTimeout(6000);
  ok(await state(pA) !== 'running', 'room A End ends room A headset');
  ok(await state(pB) === 'running', 'room A End does NOT end room B headset');
  await dA.waitForTimeout(7000);
  ok(await parts(dA) === 1, 'room A result arrives on room A Dashboard');
  ok(await parts(dB) === 0, 'room A result does NOT arrive on room B Dashboard');
  await send(dB, 'stop');
  await pB.waitForTimeout(6000);
  ok(await state(pB) !== 'running', 'room B End ends room B headset');
  await dB.waitForTimeout(7000);
  ok(await parts(dB) === 1, 'room B result arrives on room B Dashboard');
  ok(await parts(dA) === 1, 'room B result does NOT arrive on room A Dashboard');

  console.log('page errors:', errs.length ? errs : 'none');
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL LIVE CHECKS PASSED');
  await b.close();
  process.exit(failed ? 1 : 0);
})();
