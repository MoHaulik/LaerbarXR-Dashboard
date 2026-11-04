# LærbarXR — Dashboard

Lærerens overblik over en klasse: hvilke headsets der er på hvilket hold, hvor langt hver er nået, hvad eleverne svarer, og CSV-eksport til analyse. Kører i en almindelig browser på computer, tablet eller telefon og kræver kun statisk hosting.

LærbarXR består af tre repos:

- [LaerbarXR-Builder](https://github.com/MoHaulik/LaerbarXR-Builder): byg en simulation og eksportér den som `.zip`
- [LaerbarXR-Player](https://github.com/MoHaulik/LaerbarXR-Player): afspil den på Quest 3 eller i en browser
- **LaerbarXR-Dashboard** (dette repo): start og følg klassen live, saml resultater

Udgivet på https://mohaulik.github.io/LaerbarXR-Dashboard/ (GitHub Pages fra `main`).

## Kom i gang

1. Klon de tre repos side om side i samme mappe.
2. Åbn `index.html` i en browser, eller server mappen statisk (`python3 -m http.server`).
3. Byg en simulation i Builder og eksportér `.zip`.
4. Åbn Player på et headset eller i en anden fane, indlæs samme `.zip` og vælg headset og hold.
5. Her i Dashboardet: **Vælg simulation** med samme fil, og tryk **Start mit hold** eller **Start All Headsets**.
6. Følg klassen på kortet. Resultaterne kommer ind af sig selv, når et headset er færdigt.

## Funktioner

- **Livekort** med scenerne placeret som i Builder og en prik pr. headset (op til 4 simulationer ad gangen).
- **Svar pr. spørgsmål**: fx "8/12 svarede rigtigt", fordelingen på svarmuligheder (grøn = rigtig, rød = forkert) og filter pr. hold. Kun elevens første svar på et spørgsmål tæller.
- **Svar pr. headset** på kortoversigten og i Grid.
- **Flervalg** tæller kun som rigtigt ved præcis det rigtige sæt; den delvise score står i CSV'en.
- **Inaktive gennemløb** (Player har afsluttet dem, fordi headsettet lå stille) vises som *Udeladt (inaktiv)* og tæller ikke med.
- **Import af resultatfiler** (`*_eval.json`) fra headsets, der var offline. Dubletter springes over.
- **CSV-eksport**: MetaID, Dato, Tid, Simulation, Hold, Headset, Svar, Hændelse, Scene, Spørgsmål, Korrekt, Sekunder, Scenefarve, Delvis score. UTF-8 med BOM, så Excel viser æ/ø/å korrekt. Eksporten er beregnet til én gang om ugen; før tid kræver den en bekræftelse.
- **Data gemmes i 7 dage** i browseren og i relayet og slettes derefter.
- Op til 99 headsets.

## Cloud-relay

Dashboard og Player taler sammen gennem et lille relay på Cloudflare Workers, `https://laerbarxr-relay.haulik-mhk.workers.dev` (kildekode i `cloud-relay/`). Headsets og lærerens computer skal kun have almindelig internetadgang, så skolens Wi-Fi med klientisolation er ikke et problem.

- Headsets sender heartbeats (scene, status, tid, svar) hvert par sekunder.
- Et **Start** frigiver kun headsets, der allerede venter. Kommer man for sent, venter man på næste Start.
- **Flere lokaler** kan køre samme simulation samtidig: et headset hører til det Dashboard, hvis Start frigav det. Kun det Dashboard kan stoppe det og modtage resultatet. Starter to lokaler på præcis samme tidspunkt, så brug forskellige hold og **Start mit hold**.
- **Lærernøgle (anbefales):** Sæt en `TEACHER_KEY` som secret på Workeren (Cloudflare → Workers → laerbarxr-relay → Settings → Variables and Secrets). Så kræver læsning af resultater og afsendelse af Start/Stop nøglen. Hver computer spørger én gang og husker den. Headsets skal ikke bruge den.

**Udrulning:** `src/worker.js` er kilden; ret ikke koden direkte i Cloudflare.

```bash
cd cloud-relay && npm install && npx wrangler deploy
```

Kræver login til Cloudflare-kontoen.

### Uden internet: `relay.py`

Har lokalet slet ikke internet, kan `relay.py` køre som relay på det lokale netværk. Dobbeltklik på **Start LærbarXR Class.command** (macOS); det starter relayet, åbner Dashboardet og viser den adresse, headsets skal åbne. Player skal ligge i mappen ved siden af. Her skal alle enheder være på samme netværk; et rejserouter eller et telefon-hotspot omgår skolens klientisolation. Peg `RELAY_BASE` øverst i `index.html` (og i Player) på `''` for at bruge den lokale relay.

## Tests

```bash
tests/run.sh
```

Kræver de tre repos side om side, Node 18+ og Playwright med Chromium. Kører UI-tests for Builder, Player og Dashboard, en end-to-end-test mod en lokal kopi af relayet og `features.js` (flervalg, Se igen, Afslut, inaktivitet, live-tal, CSV).

`tests/live.js` tester de udgivne sider og det rigtige relay med et testhold ("Hold 9"), uden at røre rigtige klasser.

## Status

Hele kæden Builder → Player → relay → Dashboard er testet i desktop-browser. **Ikke testet på et rigtigt Quest 3** endnu; se Players README.

## Afhængigheder

Ligger i `vendor/`; siden henter intet fra et CDN.

| Fil | Version | Licens |
| --- | --- | --- |
| `vendor/jszip.min.js` | JSZip 3.10.1 | MIT / GPLv3 |
