# Uitleg Webclient Architectuur & Functionaliteiten

Deze file is bedoeld als referentie en spiekbriefje voor je presentatie over de `webclient` van SimpleDBMS. Het geeft een overzichtelijk beeld van wat elke file doet, hoe de website in elkaar zit, en licht de belangrijkste features uit (foto's toevoegen, Wikipedia-style lay-out en semantic search).

---

## 📂 Overzicht van de bestanden

De webclient bestaat uit een backend gedeelte (draait in Node.js) en een frontend gedeelte (draait in de browser van de client). 

### Backend (Node.js)
* **`daemon.mts`**: Het hoofdingangspunt (entry-point) van de backend server. Start een HTTP server op poort 8000, serveert de statische bestanden (HTML, CSS, JS) naar de browser en verwijst `/api/` requests door naar de router.
* **`api.mts`**: De express-achtige HTTP router. Bepaalt welke functie er aangeroepen moet worden als de frontend een request doet naar een bepaalde URL (bijv. GET `/api/collections` of POST `/api/connect`).
* **`service.mts`**: De "Service Layer". Dit is het kloppend hart van de backend logica. Dit bestand maakt rechtstreeks verbinding met de core `SimpleDbms` database, beheert collecties en documenten, en zorgt ervoor dat machine-learning modellen geladen worden voor slimme zoekopdrachten (semantic search).

### Frontend (Browser)
* **`app.ts`**: Het kloppend hart van de frontend. Dit is het startpunt dat via event listeners alle knoppen, modal-vensters en zoekbalken op de pagina aan elkaar knoopt en integreert met de table en docView modules.
* **`api.ts`**: Een wrapper rondom de ingebouwde browser `fetch` API. Hierin staat de `apiCall` functie die alle communicatie (GET, POST, DELETE) naar onze eigen `daemon` afhandelt.
* **`state.ts`**: De plek waar we de frontend "status" opslaan: in welke collectie we zitten, welk document momenteel geopend is, of we in 'text' of 'image' zoekmodus zitten, etc.
* **`table.ts`**: Verantwoordelijk voor de visuele tabel/lijst met documenten op de homepagina. Zorgt er ook voor dat je documenten lokaal kunt filteren op naam.
* **`docView.ts`**: Bevat alle logica voor de speciale **Wikipedia-style document weergave**. Het afhandelen van het openen, de leermodus, de infobox, de automatische inhoudsopgave (TOC) en het toevoegen van secties/foto's gebeurt hier.
* **`utils.ts`**: Bevat kleine hulpfuncties. Bijvoorbeeld functies om bytes netjes weer te geven als grootte, HTML veilig te escapen, en slim te herkennen of een veldnaam een afbeelding is.
* **`frontend/index.html & style.css`**: De statische weergave (DOM en opmaak). Bouwt het donkere thema, de modale vensters, knoppen, sidebar en responsieve layout op.

---

## 🌐 Hoe werkt de website zelf (High-Level Architectuur)?

1. **Single Page Application (SPA):** De website wordt in principe één keer geladen in de browser (`index.html` en `style.css`). Hierna navigeer je niet meer naar nieuwe webadressen, maar wordt via JavaScript (`app.ts`) de inhoud dynamisch aangepast op het scherm (door delen in het DOM aan te passen, te verbergen en te tonen).
2. **Client-Server Flow:** 
   - Klik je in de browser op een document of collectie? Dan stuurt `api.ts` een asynchrone HTTP data-vraag naar de backend. 
   - De `daemon.mts` pikt deze API url op, de `api.mts` snapt wat de bedoeling is en delegeert dit aan de `service.mts`.
   - `service.mts` pakt of wijzigt de data via de eigenlijke DBMS.
   - De backend stuurt een antwoord terug (bijvoorbeeld in JSON format).
   - Ten slotte update de frontend (`app.ts` / `table.ts`) het beeldscherm op basis van dat antwoord.

---

## 🖼️ Foto's of Afbeeldingen toevoegen (werking)

1. Als je een document bekijkt en op **Bewerken** klikt, zie je een knop **"+ Afbeelding Toevoegen"**. Hiermee roep je de functie in `docView.ts` aan om een nieuw "afbeeldingenblok" (image-upload-area) toe te voegen aan de weergave.
2. We gebruiken een verborgen `<input type="file">`. Zodra een gebruiker een foto van de computer selecteert, gebruikt JavaScript via de HTML5 **FileReader API** de afbeelding lokaal om deze om te zetten naar een **Base64 string** (dit is in feite tekst die lokaal pixels voorstelt). 
3. De foto wordt daardoor onmiddellijk op het scherm getoond, zonder dat de database initieel is aangesproken (instant preview).
4. De gebruiker kan ook een positie aangeven (boven, onder, links, rechts). Dit wordt opgeslagen als een verborgen layout-veld in de JSON structuur (bijv. `_layout__img_1234.jpeg`).
5. Pas bij het klikken op **Opslaan** verstuurt de frontend de volledige Base64 data via een POST call naar de database en wordt het op de schijf opgeslagen.

---

## 📖 De "Wikipedia-style Page" Layout

Wat de webclient uniek maakt, is dat hij droge JSON-data pakt en deze probeert op te bouwen tot een dynamische, gestileerde wiki-pagina:
* **Dataparsing (`docView.ts`):** We loopen door alle keys van de JSON die dit document vormt. Er wordt bepaald wat een tekst/onderwerp is en wat een afbeelding is. De opgeslagen sleutels fungeren als tussenkoppen (`<h2>`). 
* **Volgorde (Drag-and-Drop):** Velden kunnen verplaatst worden via een drag-handle (mogelijk gemaakt door de externe SortableJS bibliotheek). De geselecteerde weergavevolgorde slaan we op in een verborgen veld `_order_`.
* **Inhoudsopgave - Table of Contents (TOC):** Via JavaScript zoekt het script alle nieuw-gegenereerde sectietitels (`<h2>, <h3>`) in het HTML DOM op na het renderen, en plakt hiervan automatische klikbare anker-links (`<a href="#section-X">`) in het menuutje in de rechter sidebar.
* **Infobox (rechter sidebar):** Net zoals op Wikipedia staat er rechtsboven een blokje abstracte data. Alle korte tekstjes (< 30 characters), nummers en booleans uit het JSON-recept worden door het systeem weggefilterd in een aparte `<table>` aan de zijkant, omdat dit vaak structurerende metadata is en geen zware leesbare paragrafen zijn. 

---

## 🧠 Semantic Search (Slim AI Zoeken)

In de interface kun je bovenaan zoeken in een "betekenis" of "afbeelding" zoekmodus in plaats van simpele string matching (zoals CTRL+F). Wat maakt Semantic Search hier bijzonder?
1. **Transformer Modellen (`service.mts`):** De backend deelt het Hugging Face Transformers model genaamd **CLIP** in (`Xenova/clip-vit-base-patch32`). CLIP is getraind door OpenAI op honderden miljoenen combinaties van plaatjes en hun omschrijvingen (tekst).
2. **Embeddings:** Zodra je zoekt op bijvoorbeeld _"een knappe hond in het gras"_, zet het CLIP tekstmodel dit om naar een array van 512 kommagetallen. Dit heet een numerieke **"vector embedding"** van de betekenis van de zin.
3. **Database en HNSW (`SimpleDbms` core):** Omdat onze database ook foto's omzet naar diezelfde vectorruimte, kun je opeens teksten vergelijken met visuele plaatjes wiskundig (of tekst met synonieme tekst). De database gebruikt een **HNSW-index** (Hierarchical Navigable Small World) dit is een geavanceerde graaf of boomstructuur waarmee het supersnel de kortste wiskundige afstand in 512 dimensies vindt zonder door 10,000 documenten apart te hoeven gaan itereren.
4. **Het resultaat:** Zoekt iemand op _"snel rood voertuig"_, snapt het model ook synoniemen zoals afbeeldingen van _"Ferrari"_. Dit is pure "vector search / AI search".
