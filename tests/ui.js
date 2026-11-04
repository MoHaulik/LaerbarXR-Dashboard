const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(__dirname, '../..');   // mappen med de tre repos
const DEMO = path.join(ROOT, 'LaerbarXR-Builder/demo-scenarios/one-day-six-directions.lxr');
const LAUNCH = { executablePath: process.env.CHROMIUM || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] };
let failed = 0;
const ok = (c, m) => { if (!c) failed++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
(async () => {
  const b = await chromium.launch(LAUNCH);
  const errs = [];
  // ---- Dashboard
  const d = await b.newPage({ viewport:{width:1400,height:900}});
  d.on('pageerror', e => errs.push('dash: '+e.message));
  await d.goto('http://localhost:8765/LaerbarXR-Dashboard/index.html');
  await d.evaluate(() => document.getElementById('live-control-body').style.display='block');
  ok(await d.locator('label[for=session-file-input]').innerText() === 'Vælg simulation', 'item1 label');
  const sa = d.locator('button', { hasText: 'Start All Headsets' });
  ok((await sa.innerText()) === 'Start All Headsets', 'item2 no ▶');
  ok(await sa.evaluate(e => getComputedStyle(e).backgroundColor) === await d.locator('button', {hasText:'End All Headsets'}).evaluate(e => getComputedStyle(e).backgroundColor), 'item2 same white as End All');

  // ---- Builder + Player
  const p = await b.newPage({ viewport:{width:1400,height:900}});
  p.on('pageerror', e => errs.push('builder: '+e.message));
  p.on('console', m => { if (m.type()==='error') errs.push('console: '+m.text()); });
  await p.goto('http://localhost:8765/LaerbarXR-Builder/index.html');
  await p.setInputFiles('#loader', DEMO);
  await p.waitForTimeout(3000);
  const A='node_1786373807797lzug', B='node_1786373807797fazw';

  // skriv 270 -> -90
  await p.evaluate(B => App.selectNode(App.project.nodes.find(n=>n.id===B)), B);
  const num = p.locator('#inspector input[type=number][title^="Skriv"]');
  await num.fill('270'); await num.dispatchEvent('change');
  ok(await p.evaluate(B => App.project.nodes.find(n=>n.id===B).videoYaw, B) === -90, 'item7 270 wraps to -90');
  ok(await p.evaluate(() => [...document.querySelectorAll('#inspector input[type=range]')].find(i=>i.min==='-180').value) === '-90', 'item7 slider synced');
  await num.fill('160'); await num.dispatchEvent('change');
  ok(await p.evaluate(B => App.project.nodes.find(n=>n.id===B).videoYaw, B) === 160, 'item7 160 stored');

  // mindste værdi på svar-slideren
  await p.evaluate(A => App.selectNode(App.project.nodes.find(n=>n.id===A)), A);
  ok(await p.evaluate(() => [...document.querySelectorAll('#inspector input[type=range]')].filter(i=>(i.getAttribute('onchange')||'').includes('updateChoice')).every(i=>i.min==='0.7')), 'item6 answer slider min 0.7');
  ok(await p.evaluate(() => [...document.querySelectorAll('#inspector .slider-row input[type=range]')].filter(i=>i.max==='3').every(i=>i.min==='1')), 'item6 question/overlay sliders unchanged (min 1)');

  // scene A: spørgsmål forrest og lavt, svar, tekst med linjeskift
  const before = await p.evaluate(A => { const n=App.project.nodes.find(n=>n.id===A); return {y:n.questionY, x:n.questionX, n:n.choices.length}; }, A);
  console.log('node A', JSON.stringify(before));
  await p.evaluate(A => { const n=App.project.nodes.find(n=>n.id===A); n.questionTime=0; n.questionX=50; n.questionY=55;
     n.choices.forEach((c,i)=>c.scale = i===0 ? 0.7 : 1); n.textOverlays=[{time:0,duration:99,text:'Linje et\nLinje to\n\nNyt afsnit',x:30,y:50,scale:1}]; App.saveState(); App.previewFromNode(n); }, A);
  await p.waitForTimeout(5000);
  const f = p.frame({ url: /LaerbarXR-Player/ });
  const lay = () => f.evaluate(() => {
    const out = {};
    overlaysGroup.traverse(o => { if (o.isMesh && o.userData && o.userData.choiceData && !o.userData.choiceData.__exit && !o.userData.choiceData.__retryPlay) {
      const v=o.getWorldPosition(new THREE.Vector3()); (out.ch=out.ch||[]).push({h:+o.userData.boxHeight.toFixed(3), pitch:+(Math.asin(v.y/v.length())*180/Math.PI).toFixed(2), yaw:+(Math.atan2(v.x,-v.z)*180/Math.PI).toFixed(1)}); }
      if (o.isMesh && o.userData && o.userData.choiceData && o.userData.choiceData.__exit) { const v=o.position; out.exitPitch=+(Math.asin(v.y/v.length())*180/Math.PI).toFixed(1); }
    });
    return out;
  });
  const L1 = await lay();
  console.log('layout center', JSON.stringify(L1));
  ok(Math.abs(L1.exitPitch + 32) < 0.1, 'item4 Afslut at -32°');
  ok(L1.ch[0].h < L1.ch[1].h * 0.75 && L1.ch[0].h > L1.ch[1].h * 0.65, 'item6 answer at 0.7 is ~30% smaller ('+L1.ch[0].h+' vs '+L1.ch[1].h+')');
  const qy = await p.evaluate(A => App.project.nodes.find(n=>n.id===A).questionY, A);
  console.log('questionY after preview', qy);
  ok(qy < 55, 'item3 Lodret raised to the lifted height');
  const topPitchCenter = Math.max(...L1.ch.map(c=>c.pitch));

  // tekst med linjeskift er højere end samme tekst uden
  const hh = await f.evaluate(() => [createTextPlane('Linje et\nLinje to\n\nNyt afsnit',{width:512}).userData.boxHeight, createTextPlane('Linje et Linje to Nyt afsnit',{width:512}).userData.boxHeight]);
  ok(hh[0] > hh[1] * 1.6, 'item5 line breaks render as lines ('+hh.map(x=>x.toFixed(2))+')');

  const rings = await f.evaluate(() => activeChoices.filter(c=>!c.userData.choiceData.__exit && !c.userData.choiceData.__retryPlay).map(c=>+c.getObjectByName('progressRing').scale.x.toFixed(2)));
  const exitRing = await f.evaluate(() => activeChoices.find(c=>c.userData.choiceData.__exit).getObjectByName('progressRing').scale.x);
  ok(rings[0] < 1 && rings[1] === 1 && exitRing === 1, 'ring scaled only on the small answer (' + rings + ', exit ' + exitRing + ')');

  // flyt vandret -> højden bevares (live sync)
  await p.evaluate(A => { App.project.nodes.find(n=>n.id===A).questionX = 25; }, A);
  await p.waitForTimeout(2500);
  const L2 = await lay();
  const topPitchSide = Math.max(...L2.ch.map(c=>c.pitch));
  console.log('top pitch center/side', topPitchCenter, topPitchSide, 'yaw side', L2.ch[0].yaw);
  ok(Math.abs(topPitchSide - topPitchCenter) < 2, 'item3 block keeps height when moved sideways');
  // sænk via Lodret i siden virker stadig
  await p.evaluate(A => { App.project.nodes.find(n=>n.id===A).questionY = 70; }, A);
  await p.waitForTimeout(2500);
  const L3 = await lay();
  ok(Math.max(...L3.ch.map(c=>c.pitch)) < topPitchSide - 5, 'item3 Lodret can still move it lower at the side');

  // træk i visningen, svar, ny scene skal vende mod startretningen
  const box = await p.locator('#previewPlayerFrame').boundingBox();
  await p.mouse.move(box.x+box.width/2, box.y+box.height/2); await p.mouse.down();
  await p.mouse.move(box.x+box.width/2+300, box.y+box.height/2+60, {steps:10}); await p.mouse.up();
  const dragged = await f.evaluate(() => camera.rotation.y*180/Math.PI);
  await f.evaluate(() => selectChoice(currentNode.choices[0]));
  await p.waitForTimeout(2000);
  const r = await f.evaluate(() => [currentNode.id, camera.rotation.y*180/Math.PI, camera.rotation.x, videoMesh.rotation.y*180/Math.PI]);
  console.log('dragged', dragged.toFixed(1), 'after', JSON.stringify(r));
  ok(Math.abs(dragged) > 20 && r[1] === 0 && r[2] === 0 && Math.round(r[3]) === 160, 'item8 new scene faces its start direction (160°)');
  // trækket virker stadig efter nulstilling
  await p.mouse.move(box.x+box.width/2, box.y+box.height/2); await p.mouse.down();
  await p.mouse.move(box.x+box.width/2+100, box.y+box.height/2, {steps:5}); await p.mouse.up();
  ok(Math.abs(await f.evaluate(() => camera.rotation.y*180/Math.PI)) > 10, 'item8 drag-to-look still works afterwards');

  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
  process.exit(failed ? 1 : 0);
})();
