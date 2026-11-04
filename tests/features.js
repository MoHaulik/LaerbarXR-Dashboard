// Funktionerne fra oktober 2026, testet hele vejen gennem en lokal relay (se run.sh):
//   flervalg ("vælg alle rigtige") med facit i VR, "Se igen", valgfri Afslut,
//   udelukkelse ved inaktivitet, scenefarver, live-tal pr. spørgsmål og de
//   tilhørende CSV-kolonner.
const path = require('path');
const fs = require('fs');
const os = require('os');
const JSZip = require('../vendor/jszip.min.js');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(__dirname, '../..');
const DEMO = path.join(ROOT, 'LaerbarXR-Builder/demo-scenarios/one-day-six-directions.lxr');
const LAUNCH = { executablePath: process.env.CHROMIUM || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] };
const RELAY = 'https://laerbarxr-relay.haulik-mhk.workers.dev';
const LOCAL = 'http://127.0.0.1:8787';
const KEY = 'k-test-1';
const TITLE = 'Feature Test ' + Date.now();
const A = 'node_1786373807797lzug', B = 'node_1786373807797fazw';
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 250)); } return false; };

(async () => {
  // Demoen med scene A lavet om til flervalg med 4 svar (2 rigtige) og "Se igen",
  // scene B markeret grøn, Afslut fjernet, inaktivitetsgrænse 30 s.
  const zip = await JSZip.loadAsync(fs.readFileSync(DEMO));
  const p = JSON.parse(await zip.file('project.json').async('string'));
  p.title = TITLE; p.hideExit = true; p.idleTimeoutSec = 30;
  p.nodes.forEach(n => {
    if (n.id === A) Object.assign(n, { questionMode: 'multi', questionTime: 0, replayEnabled: true, replayTime: 0, question: 'Hvilke to er rigtige?', defaultNext: B,
      choices: [['Rigtig A', true], ['Forkert B', false], ['Rigtig C', true], ['Forkert D', false]].map(([label, correct], i) => ({ id: 'c' + i, label, correct, target: null })) });
    if (n.id === B) n.sceneColor = 'green';
  });
  zip.file('project.json', JSON.stringify(p));
  const ZIP = path.join(os.tmpdir(), 'lxr-feature-test.zip');
  fs.writeFileSync(ZIP, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));

  const b = await chromium.launch(LAUNCH);
  const errs = [];
  const newCtx = async (withKey) => {
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    if (withKey) await ctx.addInitScript(k => { try { localStorage.setItem('lxr_teacher_key', k); } catch (e) {} }, KEY);
    await ctx.route(RELAY + '/**', async route => {
      const req = route.request();
      const r = await fetch(req.url().replace(RELAY, LOCAL), { method: req.method(), headers: { 'Content-Type': 'application/json' }, body: req.postData() || undefined });
      route.fulfill({ status: r.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: await r.text() });
    });
    return ctx;
  };
  const openPlayer = async (ctx, name) => {
    const pl = await ctx.newPage();
    pl.on('pageerror', e => errs.push('player ' + e.message));
    await pl.goto('http://localhost:8765/LaerbarXR-Player/index.html');
    await pl.evaluate(n => { localStorage.setItem('lxr_headset_id', n); localStorage.setItem('lxr_headset_group', 'Hold 1'); }, name);
    await pl.reload();
    await pl.setInputFiles('#file-input', ZIP);
    await until(() => pl.evaluate(() => !!sessionData && !previewButton.disabled));
    await pl.waitForTimeout(500);
    await pl.evaluate(() => attemptStart(startFlatPreview));
    await until(() => pl.evaluate(() => currentRunStatus === 'waiting'));
    return pl;
  };

  // ---- Dashboard
  const dctx = await newCtx(true);
  const d = await dctx.newPage();
  d.on('pageerror', e => errs.push('dash ' + e.message));
  await d.goto('http://localhost:8765/LaerbarXR-Dashboard/index.html');
  await d.setInputFiles('#session-file-input', ZIP);
  await until(() => d.evaluate(t => AppState.liveSessions.some(s => s.title === t), TITLE));

  // ---- Player 1: flervalg, se igen, fortsæt
  const pctx = await newCtx(false);
  const pl = await openPlayer(pctx, 'Headset 01');
  await d.evaluate(() => App.sendCommand('all', 'start'));
  ok(await until(() => pl.evaluate(() => currentRunStatus === 'running')), 'Start releases the headset');
  ok(await until(() => pl.evaluate(() => !!multiState && multiState.confirm.parent.visible)), 'multi-select question is up');

  const chrome = await pl.evaluate(() => activeChoices.filter(c => c.userData.choiceData.__exit || c.userData.choiceData.__replay)
    .map(c => ({ k: c.userData.choiceData.__exit ? 'exit' : 'replay', yaw: Math.round(Math.atan2(c.position.x, -c.position.z) * 180 / Math.PI) })));
  ok(chrome.length === 1 && chrome[0].k === 'replay' && chrome[0].yaw === 0, 'Afslut removed; "Se igen" takes its place straight ahead ' + JSON.stringify(chrome));
  ok(await pl.evaluate(() => multiState.confirm.userData.disabled && getVisibleChoices().indexOf(multiState.confirm) === -1), 'Bekræft is not gazeable before anything is ticked');

  ok(await pl.evaluate(() => multiState.confirm.userData.textLabel) === 'Vælg alle rigtige svar', 'by default the learner is not told how many answers are right');
  ok(await pl.evaluate(() => { currentNode.multiShowCount = true; const t = multiConfirmLabel(currentNode, 1); currentNode.multiShowCount = false; return t.text + '|' + t.ready; }) === 'Vælg 2 svar (1/2)|false',
     'opt-in multiShowCount: "Vælg N svar", N = answers marked right');
  const toggle = i => pl.evaluate(i => { const m = multiState.meshes[i]; selectChoice(m.userData.choiceData, false, m); }, i);
  const badge = i => pl.evaluate(i => { const b = multiState.meshes[i].getObjectByName('choiceBadge'); return b ? b.userData.textLabel : null; }, i);
  await toggle(0); await toggle(1);
  ok(await pl.evaluate(() => multiState.meshes.map(m => !!m.userData.selected).join()) === 'true,true,false,false', 'gazing an answer ticks it (no navigation)');
  ok(await badge(0) === '✓' && await pl.evaluate(() => currentNode.id) === A, 'ticked answer shows a ✓ and the scene stays');
  ok(await pl.evaluate(() => preArmedChoice === multiState.meshes[1]), 'gaze must leave a just-ticked answer before it can untick it');
  await toggle(1);
  ok(await badge(1) === null && await pl.evaluate(() => !multiState.meshes[1].userData.selected), 'gazing again unticks it');
  await toggle(1);
  ok(await pl.evaluate(() => !multiState.confirm.userData.disabled && multiState.confirm.userData.textLabel === 'Bekræft svar ✓ (2 valgt)'), 'Bekræft enabled once something is ticked, without revealing the count');

  await pl.evaluate(() => selectChoice(multiState.confirm.userData.choiceData, false, multiState.confirm));
  const fb = await pl.evaluate(() => multiState.meshes.map(m => {
    const c = m.material.map.image, px = c.getContext('2d').getImageData(Math.round(c.width * 0.08), Math.round(c.height / 2), 1, 1).data;
    const b = m.getObjectByName('choiceBadge');
    return { fb: m.userData.feedback, rgb: [px[0], px[1], px[2]], badge: b ? b.userData.textLabel : null, active: activeChoices.indexOf(m) !== -1 };
  }));
  console.log('answer key', JSON.stringify(fb));
  ok(fb.map(x => x.fb).join() === 'right,wrong,right,wrong', 'right answers marked right, wrong ones wrong');
  ok(fb.every(x => x.fb === 'right' ? (x.rgb[1] > x.rgb[0] + 40) : (x.rgb[0] > x.rgb[1] + 40)), 'answer key renders green for right, red for wrong');
  ok(fb.map(x => x.badge).join() === '✓,✗,,', 'learner\'s picks get ✓ (right) / ✗ (wrong), unpicked none');
  ok(fb.every(x => !x.active), 'answers are no longer selectable after Bekræft');
  const cont = await pl.evaluate(() => multiState.confirm.userData.textLabel);
  ok(/1 af 2 rigtige · 1 forkert — Fortsæt/.test(cont), 'Bekræft becomes Fortsæt with the score: ' + cont);
  const ans = await pl.evaluate(() => sessionLog.filter(e => e.action === 'choice_made').pop());
  ok(ans.multi && ans.correct === false && ans.choice === 'Rigtig A | Forkert B' && ans.hits === 1 && ans.wrong_picks === 1 && ans.total_correct === 2, 'logged as one choice_made with the whole set');
  ok(await pl.evaluate(() => JSON.stringify(liveAnswers)) === JSON.stringify([{ n: A, c: 0, a: [0, 1] }]), 'live answer (right/wrong + which options) recorded for the heartbeat');
  ok(ans.selected_index.join() === '0,1', 'chosen options logged by index too');

  // Dashboard: live-tal mens headsettet stadig spiller
  ok(await until(() => d.evaluate(() => (document.getElementById('mapStatsRows') || {}).textContent || '').then(t => /Spørgsmål 1[\s\S]*Hvilke to er rigtige[\s\S]*0\/1 svarede rigtigt/.test(t))), 'Dashboard shows "0/1 svarede rigtigt" live, before the run finishes');
  ok(await d.evaluate(() => [...document.querySelectorAll('.map-node')].some(n => /Hvilke to er rigtige/.test(n.textContent) && /0\/1 svarede rigtigt/.test(n.textContent))), 'question and count shown on its map node');
  ok(await d.evaluate(() => [...document.querySelectorAll('.map-node.scene-green')].length === 1), 'green-marked scene is green on the map');
  const chips = await d.evaluate(() => [...document.querySelectorAll('#mapStatsRows .qrow:first-child .qopt')].map(e => e.className.replace('qopt ', '') + ':' + e.textContent.trim()));
  console.log('options', JSON.stringify(chips));
  ok(chips.join('|') === 'right:✓ Rigtig A 1|wrong:✗ Forkert B 1|right none:✓ Rigtig C 0|wrong none:✗ Forkert D 0', 'Dashboard shows which answers were chosen, live (green right / red wrong, with counts)');

  const liveRow = await d.evaluate(() => { const r = [...document.querySelectorAll('#mapPerHeadsetBody tr')].find(t => /Headset 01/.test(t.textContent)); return r ? r.textContent.replace(/\s+/g, ' ') : ''; });
  ok(/I gang/.test(liveRow) && /✓ Rigtig A/.test(liveRow) && /✗ Forkert B/.test(liveRow), 'map overview lists what each headset answered, live: ' + liveRow.trim());
  ok(await d.evaluate(() => /Spm\. 1: ✓ Rigtig A, ✗ Forkert B/.test([...document.querySelectorAll('.map-dot')].map(e => e.title).join('\n'))), 'headset dot tooltip on the map shows its answers');

  // Se igen starter scenen forfra; et nyt, rigtigt svar logges, men statistikken bruger første forsøg
  await pl.evaluate(() => selectChoice({ __replay: true }));
  ok(await until(() => pl.evaluate(() => !!multiState && !multiState.done && multiState.meshes.every(m => !m.userData.selected))), '"Se igen" restarts the scene with a fresh question');
  ok(await pl.evaluate(() => sessionLog.filter(e => e.action === 'replay').length === 1 && sessionLog.filter(e => e.action === 'node_start').length === 2), 'replay logged, scene restarted');
  await toggle(0); await toggle(2);
  await pl.evaluate(() => selectChoice(multiState.confirm.userData.choiceData, false, multiState.confirm));
  ok(/Alle rigtige/.test(await pl.evaluate(() => multiState.confirm.userData.textLabel)), 'all right → "Alle rigtige — Fortsæt"');
  ok(await pl.evaluate(() => liveAnswers.length === 1 && liveAnswers[0].c === 0), 'live stat keeps the first attempt');
  await pl.evaluate(() => selectChoice(multiState.confirm.userData.choiceData, false, multiState.confirm));
  ok(await until(() => pl.evaluate(n => currentNode && currentNode.id === n, B)), 'Fortsæt goes to the next scene (Default Next)');

  // ---- Player 2: ingen hovedbevægelse → afsluttet og udelukket
  const p2ctx = await newCtx(false);
  const pl2 = await openPlayer(p2ctx, 'Headset 02');
  await d.evaluate(() => App.sendCommand('all', 'start'));
  ok(await until(() => pl2.evaluate(() => currentRunStatus === 'running' && runActive)), 'second headset running');
  ok(await pl2.evaluate(() => { checkIdle(); return !sessionEnding; }), 'idle rule never fires in a flat preview');
  // Efterligner en VR-session, hvor headsettet ligger stille.
  await pl2.evaluate(() => { flatPreview = false; xrSession = { end() { xrSession = null; onSessionEnd(); } }; lastMoveAt = Date.now() - 31000; checkIdle(); });
  ok(await pl2.evaluate(() => currentRunStatus === 'done'), 'no movement for idleTimeoutSec ends the run');

  // Player 1 afslutter (læreren stopper timen)
  await d.evaluate(() => App.sendCommand('all', 'stop'));
  ok(await until(() => pl.evaluate(() => currentRunStatus === 'done')), 'teacher Afslut ends headset 01');
  ok(await until(() => d.evaluate(t => (AppState.liveSessions.find(s => s.title === t) || { participants: [] }).participants.length === 2, TITLE), 20000), 'both results reached the Dashboard');
  const parts = await d.evaluate(t => AppState.liveSessions.find(s => s.title === t).participants.map(p => ({ n: p.name, s: p.status, a: p.answers })), TITLE);
  console.log('participants', JSON.stringify(parts));
  const h1 = parts.find(x => x.n === 'Headset 01'), h2 = parts.find(x => x.n === 'Headset 02');
  ok(h1 && h1.a[A] === 0, 'headset 01 counted on its first attempt');
  ok(await d.evaluate(t => AppState.liveSessions.find(s => s.title === t).participants.find(p => p.name === 'Headset 01').picks[Object.keys(App.questionNodes(AppState.liveSessions.find(s => s.title === t)).reduce((o, n) => (o[n.id] = 1, o), {}))[0]].join(), TITLE) === '0,1', 'finished run keeps which options it chose');
  await d.evaluate(() => App.renderMapView());
  const exRow = await d.evaluate(() => { const r = [...document.querySelectorAll('#mapPerHeadsetBody tr')].find(t => /Headset 02/.test(t.textContent)); return r ? r.textContent.replace(/\s+/g, ' ') : ''; });
  ok(/Udeladt \(inaktiv\)/.test(exRow) && /Ikke med i data/.test(exRow), 'map overview shows the inactive headset as left out of the data');
  await d.evaluate(() => App.switchToGrid());
  ok(await d.evaluate(() => /Spm\. 1:\s*✓ Rigtig A, ✗ Forkert B/.test([...document.querySelectorAll('.participant-card')].find(c => /Headset 01/.test(c.textContent)).textContent)), 'Grid card lists what the headset answered');
  ok(await d.evaluate(() => /Rigtig A\s*1/.test(document.querySelector('#canvas .qstats .qrow').textContent)), 'Grid view shows the answer split too');
  await d.evaluate(t => App.switchToMap(AppState.liveSessions.find(s => s.title === t).id), TITLE);
  ok(h2 && h2.s === 'Excluded' && Object.keys(h2.a).length === 0, 'inactive headset 02 is Excluded, with no answers counted');
  ok(await until(() => d.evaluate(() => /0\/1 svarede rigtigt/.test(document.getElementById('mapStatsRows').textContent))), 'stats after the class: 0/1 (excluded run not counted)');

  // CSV
  const [dl] = await Promise.all([d.waitForEvent('download'), d.evaluate(t => App.downloadSessionData(AppState.liveSessions.find(s => s.title === t)), TITLE)]);
  const csv = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '');
  const rows = csv.trim().split(/\r\n/).map(r => r.slice(1, -1).split('","'));
  const H = rows[0];
  ok(H.slice(0, 12).join() === 'MetaID,Dato,Tid,Simulation,Hold,Headset,Svar,Hændelse,Scene,Spørgsmål,Korrekt,Sekunder' && H.slice(12).join() === 'Scenefarve,Delvis score', 'CSV keeps its columns and appends Scenefarve, Delvis score');
  const col = n => H.indexOf(n);
  const answers = rows.filter(r => r[col('Hændelse')] === 'ANSWER');
  ok(answers.length === 2 && answers[0][col('Svar')] === 'Rigtig A | Forkert B' && answers[0][col('Korrekt')] === 'false' && answers[0][col('Delvis score')] === '1/2 rigtige, 1 forkert', 'multi answer row: whole set, Korrekt=false, partial score');
  ok(answers[1][col('Korrekt')] === 'true' && answers[1][col('Delvis score')] === '2/2 rigtige', 'replayed answer row also exported');
  ok(rows.some(r => r[col('Hændelse')] === 'VIEW' && r[col('Scenefarve')] === 'grøn'), 'visit to the green scene carries Scenefarve=grøn');
  ok(rows.some(r => r[col('Hændelse')] === 'REPLAY' && r[col('Headset')] === 'Headset 01'), 'replay exported');
  const ex = rows.filter(r => r[col('Headset')] === 'Headset 02');
  ok(ex.length === 1 && ex[0][col('Hændelse')] === 'EXCLUDED' && /ikke med i data/.test(ex[0][col('Svar')]), 'inactive run exported as a single EXCLUDED row');

  // ---- Builder: de nye indstillinger
  const bp = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  bp.on('pageerror', e => errs.push('builder ' + e.message));
  await bp.goto('http://localhost:8765/LaerbarXR-Builder/index.html');
  ok(await bp.evaluate(() => App.project.hideExit === false && App.project.idleTimeoutSec === 60), 'new project: Afslut on, 60s idle rule');
  await bp.setInputFiles('#loader', DEMO);
  await until(() => bp.evaluate(a => App.project.nodes.some(n => n.id === a), A));
  ok(await bp.evaluate(() => !App.project.hideExit && !App.project.idleTimeoutSec && /Vis "✕ Afslut"/.test(document.getElementById('projectSettings').textContent)), 'existing project: unchanged (Afslut on, idle rule off)');
  await bp.evaluate(() => { const cb = document.querySelector('#projectSettings input[type=checkbox]'); cb.checked = false; cb.dispatchEvent(new Event('change')); });
  ok(await bp.evaluate(() => App.project.hideExit === true), 'unticking "Vis Afslut" sets hideExit');
  await bp.evaluate(a => App.selectNode(App.project.nodes.find(n => n.id === a)), A);
  const sel = q => bp.locator('#inspector select').filter({ has: bp.locator('option[value="' + q + '"]') });
  await sel('multi').selectOption('multi');
  ok(await bp.evaluate(a => App.project.nodes.find(n => n.id === a).questionMode === 'multi', A), 'Svartype → multi');
  ok(await bp.locator('#inspector select[title="Navigate to"]').count() === 0, 'per-answer navigation hidden for multi');
  await sel('green').selectOption('green');
  ok(await bp.evaluate(a => document.getElementById(a).classList.contains('scene-green'), A), 'scene marking colours the canvas node');
  await bp.locator('#inspector input[type=checkbox][onchange*=replayEnabled]').check();
  ok(await bp.evaluate(a => App.project.nodes.find(n => n.id === a).replayEnabled === true, A) && await bp.locator('#inspector input[onchange*=replayTime]').count() === 1, 'replay checkbox + time field');
  ok(await bp.evaluate(a => /↻/.test(document.getElementById(a).textContent), A), 'replay icon on the canvas node');

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
