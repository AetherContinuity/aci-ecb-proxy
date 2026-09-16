# ACI-proxyjen käyttöohje

**Kirjattu 11.9.2026 istunnon 9.–11.9. kokemuksista.**
**Päivitetty 15.9.2026: kolme kohtaa mitattu, yksi kumosi oman hypoteesin.**

Kaksitoista proxya, kolme päivää, ja noin viisitoista virhettä joista
suurin osa oli samaa kolmea lajia. Tämä on niiden lajien luettelo, ei
rajapintadokumentaatio — reitit ovat proxyjen omissa README:issä ja
indeksivastauksissa.

---

## 1 · Neljä virhelajia, jotka toistuivat

### A · Polkuarvaus

Arvasin reittipolun neljä kertaa peräkkäin väärin Eduskunnan
äänestysrajapinnassa, ja kerran avoimuusrekisterissä.

**Sääntö: jos reitti antaa 404, ÄLÄ arvaa toista.** Hae määrittely.

    ?spec=1                    OpenAPI-polkuluettelo (avoimuusrekisteri)
    ?spec=/polku               yhden polun parametrit
    ?edkpath=...               passthrough polkujen koestamiseen
    indeksireitti "/"          listaa reitit ja ansat, MISSÄ SE ON — ei kaikissa, ks. 3

Jos määrittelyä ei ole, **pyydä osoite ihmiseltä.** Selaimen
kehitystyökalut näyttävät AJAX-päätepisteen sekunnissa; minä en näe
sitä ollenkaan.

Avoimuusrekisterin polut olivat `open-data-` **väliviivalla**, arvasin
`open-data/` kauttaviivalla. Yksi merkki, viisi turhaa kutsua.

### A2 · Rajoitus pääteltiin omasta parametrivalinnasta, ei rajapinnasta

**Uusi 15.9., ei ollut listalla ennen mittausta.** Epäilin Fingridin
`size`-katoksi 400:aa, koska kalibrointihaku käytti sitä sivukokona ja
se "toimi". Todellinen katto on 20 000 (ks. 2, Fingrid) — 400 ei ollut
rajapinnan raja vaan **oman kalibrointityökalun valinta**, joka
sattui olemaan pienempi kuin todellinen katto ja näytti siksi rajalta.

Ero A:han: A on väärä arvaus joka *epäonnistuu näkyvästi* (404).
Tässä arvaus ei epäonnistunut — se vain jäi mittaamatta, koska pienempi
luku ei koskaan törmännyt oikeaan rajaan, ja epäonnistumisen puute
tulkittiin todisteeksi katosta. **Puuttuva virhe ei ole vahvistus.**
Sama tarkistus kuin C:ssä, käänteisesti: siinä tyhjä tulkitaan
havainnoksi, tässä toimiva pieni luku tulkitaan rajaksi.

### B · Koodausvirhe joka näyttää polkuvirheeltä

Eduskunnan `{eduskuntatunnus+}` on greedy-polkuparametri:

    HE 101/2024      -> "No matches for given id HE"   katkeaa välilyöntiin
    HE%20101/2024    -> tyhjä 404                      kauttaviiva raakana
    HE%20101%2F2024  -> TOIMII                          koko tunnus koodattuna

**Ja pahin oli omassa koodissani:** `URLSearchParams.get()` **purkaa**
prosenttikoodauksen. Passthrough-parametri luettiin purettuna ja
rakennettiin URL:iin sellaisenaan — proxy lähetti literaaleja
välilyöntejä.

**Sääntö: kun koestat koodausta, lue parametri RAAKANA
kyselymerkkijonosta.** `u.search.match(/[?&]param=([^&]*)/)`.

**Ja katso `upstream`-kenttä ennen kuin epäilet otsikoita.** Kokeilin
neljä `Accept`/`User-Agent`-varianttia turhaan; vika näkyi
vastauksessa koko ajan.

### C · Hiljainen nolla

Kuusi kertaa: tyhjä vastaus tulkittiin havainnoksi.

| tilanne | väärä tulkinta | oikea |
|---|---|---|
| tyhjä 404 Eduskunnasta | "ei äänestetty" | polku ei resolvoidu |
| `l_best = 0.0` alkuarvo | aito nolla | ei havaintoa |
| DS 105 vakionolla 180 vrk | halpa sähkö | rikkinäinen syöte |
| yksikielinen jäsennin | "tyhjä lausunto" | ruotsinkielinen lomake |
| `(a.patch \|\| [])` | nollavaikutus | kalibroimaton |
| `Counter(actor)` | 29 pudonnutta | hiljainen suodatus |

**Sääntö: erota AINA kolme tilaa.** Ei mitattu · mitattu nollaksi ·
haku epäonnistui. Jos koodissa on vain kaksi haaraa, yksi tila on
piilossa.

---

## 2 · Rajoitukset per proxy

### Fingrid — katto on 20 000, ei 400, ja se on äänekäs

**Korjaa 11.9.:n merkintä "size 400 (kova katto)" — se oli väärä.**
Mitattu 15.9., DS 124, 1.–13.9. (1 152 pistettä):

| size | HTTP | rivejä | perPage |
|---|---|---|---|
| 400 | 200 | 400 | 400 (3 sivua) |
| 1000 | 200 | 1000 | 1000 (2 sivua) |
| 10000 | 200 | — | — |
| 20000 | 200 | **1152** | 20000, lastPage 1 |
| 20001 | **422** | 0 | `{"error":"Fingrid returned 422"}` |

Todellinen katto on **20 000**, ja se on **äänekäs**: yhden yli menevä
kutsu palauttaa 422 ylävirrasta, ei hiljene. 400 oli kalibrointihaun
oma sivukoko, ei rajapinnan raja — ks. 1, A2.

Tämä myös selittää **43/61-kaatumisen** uudella tavalla: 400-kokoisilla
sivuilla sama aikaväli vaati kolme kertaa enemmän kutsuja kuin
20 000-kokoisilla sivuilla vaatisi. Suurempi kutsumäärä osui 429-rajaan
useammin — kyse ei ollut (pelkästään) taukojen pituudesta.

    ikkuna        3 vrk
    tauko         1,8–2,2 s haun välissä
    backoff       6–8 s × yrityskerta, enintään 3 yritystä
    size          20 000 (kova katto, äänekäs: 422 ylävirrasta yli menevästä)

**Rinnakkaisuus on kielletty.** `Promise.all` kolmella sarjalla
laukaisi 429:n suoraan selaimessa. Peräkkäin 900 ms välein toimii.

Sivutus palauttaa **uusimmat ensin**; koko jakso vaatii useita
ikkunoita.

**Indeksireitti puuttuu.** `curl "$PROXY/"` ilman `ds`-parametria antaa
`400 Missing parameter: ds`, ei reittiluetteloa. Työjärjestyksen kohta 1
(3 §) ei päde tähän proxyyn — ks. 3.

**DS 192 ja DS 242 EIVÄT ole sama sarja.** Molemmat on koodissa
merkitty "EPP" (Ennakoitu poikkeuspoisto): `aci-fingrid-proxy`:n
kanari `fingrid-ds192` (`monitor.py`) käyttää 192:ta, `aci-ecb-proxy`:n
`FINGRID-EPP`-reitti (`worker.js`) käyttää 242:ta. Mitattu 12.9. klo
02–03:

    192   3 min resoluutio    5422,45 → 5434,12 MW
    242   15 min resoluutio   5230,2  → 5234,9  MW

Ero ~3,7 %, sama suuruusluokka, **eri raster** — kaksi eri asiaa
samalla nimellä, ei duplikaatti. Muoto viittaa siihen että 192 on
toteutunut ja 242 ennuste, **mutta se on VAHVISTAMATON**: proxy ei
tarjoa metadatareittiä oikeille nimille (ks. yllä, indeksireitti
puuttuu), joten nimet on haettava Fingridin omasta
datasettiluettelosta. **Kunnes se on tehty, EI korjata numeroa
arvaamalla** — vika on "EPP"-selite kahdessa paikassa eri sarjalle,
ei 192 tai 242 sinänsä. Avoin kohta, ks. 4.

### Avoimuusrekisteri (VTV) — käyttöehdot rajoittavat

> *"Rajapinta on tarkoitettu kevyisiin käyttötapauksiin... kapasiteetin
> riittävyyttä ei taata. Tietoaineiston tuottaja voi rajoittaa
> yksittäisen käyttäjän pääsyä."*

**Cloudflaren workerissa kaikki kutsut tulevat samasta IP:stä.** Jos
tämä käyttäytyy huonosti, pääsy sulkeutuu kaikelta.

    välimuisti    30 vrk, OLETUS eikä optimointi
    sivukatto     100, ei ohitettavissa
    massahaku     POISTETTU — rajaton päätepiste ei ota parametreja
                  ja antaa 500. Kausikohtainen ?term_route= on ainoa tapa.

**403 ja 429 eivät ole tavallisia virheitä.** Ne tarkoittavat
volyymirajaa: lopeta hakeminen.

Ja **käytä valmiita raportteja ennen massahakua** — VTV laskee
koosteet (`?report=top_topics_latest`) juuri siksi.

Kevein kanari (`?r=terms_all`) valvottu `monitor.py`:ssä
(`avoimuus-terms`); se on juuri se kevyt reitti jota tämä kohta
suosittelee, ei sattumaa.

### Eduskunta — kolme vahvistettua reittiä, ei kaksi

**Korjaa 11.9.:n listan puutteellisuus** — sama kappale viittasi jo
äänestysreittiin joka vaatii `%2F`:n, mutta reittiluettelo yllä sitä
listasi vain kahtena:

    /search?q=<json>                                  toimii
    /kansanedustajat                                   toimii
    /taysistunnot/asian-aanestykset/{tunnus+}          toimii, todennettu 7.9. VNT 1/2026 vp:llä
    /tables/...                                        EI ole tässä hostissa (404)

Kolmas vaatii `%2F`-koodauksen ja `vp`-päätteen kokeilemisen — ks.
kohta 1, B.

### ENTSO-E — hidas ja ajoittain rikki

    aikakatkaisu   90 s, ei 30 s
    tyypillinen    5–26 s
    9.9.2026       HTTP 527 ja 599 gateway-virheitä toistuvasti

**Erota kolme tilaa:** hidas (onnistuu pidemmällä ajalla), rikki
(nopea 5xx), ja väärä reitti (4xx). Uusinta auttaa vain ensimmäisessä.

### ymparisto.fi — HTML, ei rajapintaa

Drupal 11, `/jsonapi` **ei vastaa** (kokeiltu 9.9.2026). Sisäinen haku
on Elastic App Search muttei julkaistu.

Hakemisto on kahdella lyhytosoitesivulla, **787 hanketta**, ja se on
enumeroitavissa.

**Turvakynnys on pakollinen:** jäsennin hajoaa hiljaa jos teema
muuttuu. Alle sadan hankkeen tulos **nostaa virheen**, ei palauta
tulosta.

### budjetti.vm.fi — robots.txt kieltää

Avoin data on olemassa (`/indox/opendata/`), mutta `robots.txt` estää
automaattisen haun. **Proxya ei rakennettu.**

Este on palvelun oma kielto, ei hiekkalaatikon sallilista — ja se on
eri asia. Lataa käsin ja liitä.

---

## 3 · Työjärjestys joka toimi

1. **Indeksireitti ensin — MISSÄ SE ON OLEMASSA.** `curl "$PROXY/"`
   kertoo reitit ja ansat useimmissa proxyissa. **Ei kaikissa:**
   `aci-fingrid-proxy`:llä ei ole indeksireittiä, `/` ilman `ds`:ää
   antaa `400 Missing parameter: ds`. Sääntö oli kirjoitettu
   yleiseksi vaikka pätee vain osaan — jos reittiä ei ole, hae se
   proxyn README:stä tai kysy ihmiseltä (ks. 1, A), älä oleta ettei
   sitä tarvita.
2. **Kevein reitti ennen raskainta.** Avoimuusrekisterissä `?r=terms_all`
   (pieni taulukko) ennen `?term_route=activities_term` (1 184 riviä).
   Se kertoo kolme asiaa kerralla: vastaako palvelu, ovatko polut
   oikein, missä muodossa tulos on kääritty.
3. **Yksi kutsu, katso rakenne, sitten vasta silmukka.**
4. **Tallenna heti.** Tämä istunto haki saman datan useaan kertaan
   koska tulokset olivat vain `/tmp`:ssä. Kalibrointiaineistot
   tallennettiin repoon `_locked_at` + `_revision` + `_content_hash`
   -kaavalla; muut koottiin vasta lopuksi.
5. **Kun luku näyttää oikealta, vertaa sitä toiseen lukuun ennen kuin
   luotat siihen** (ks. 6). 15.9. mittaus kumosi 11.9. hypoteesin
   juuri koska kaksi eri size-arvoa ajettiin samaa dataa vasten
   eikä yksi arvo tutkittu erikseen.

---

## 4 · Mitä EI saa tehdä

**Älä lisää läpivientireittiä toisen proxyn ylävirtaan.** `?ds=`
Fingridille kuuluu `aci-fingrid-proxy`:hyn, ei ECB-proxyyn. Kaksi
paikkaa samalle lähteelle on huonompi kuin kanari joka osoittaa
oikeaan.

**Tämä sääntö on jo rikki, ei vain teoreettinen vaara.**
`aci-ecb-proxy`/`worker.js` kantaa yhä `FINGRID-EPP`:tä (DS 242) ja
`EDK-VNS82025`:tä suoraan passthrough-reitteinä siitä huolimatta että
kumpikin kuuluisi omaan proxyynsa (`aci-fingrid-proxy`,
`aci-policy-proxy`). **Ei korjattu tässä.** Poisto vaatisi
vahvistuksen että korvaavat reitit ovat elossa kummassakin
kohdeproxyssa ennen tuotantoreitin poistoa täältä — se on oma,
erillinen tehtävänsä, ei tämän dokumentin korjaus. Jos tätä ei
kirjata, se rakennetaan uudestaan ensi kuussa samana virheenä.

**Älä nimeä sarjaa arvaamalla kun kaksi eri numeroa väittävät samaa
asiaa.** DS 192 vs. DS 242 (ks. 2, Fingrid) on tuore esimerkki:
oikea korjaus ei ole valita jompikumpi vaan hakea oikeat nimet
Fingridin datasettiluettelosta. Sama periaate kuin muualla: puuttuva
tieto ei ole nolla eikä arvaus.

**Älä rakenna jaettua kirjastoa.** Kaksitoista proxya erillisinä
tarkoittaa että yksi kaatuu yksin. Kun Lausuntopalvelu antoi 522:n,
muut jatkoivat. Toisto maksaa vähemmän kuin jaettu vikapiste.

**Älä kirjoita kynnysarvoja joita ei ole mitattu.** `unchanged_runs`
kasvaa ilman hälytyskynnystä, koska kukaan ei tiedä mikä on
legitiimisti vakaa sarja.

**Älä oleta että sarja on olemassa taaksepäin.** `DS 373` alkaa
3/2025, `DS 371` 12/2024, `DS 183` 2014. Resoluutio vaihtui
13.6.2023 tunnista 15 minuuttiin — vanhempi historia **ei ole
vertailukelpoista piikkitiheydessä**.

**Älä tulkitse pientä toimivaa lukua rajaksi** (ks. 1, A2). Se että
`size=400` ei koskaan antanut virhettä ei todista että 400 on katto —
se todistaa vain ettei 400 koskaan ylittänyt sitä.

---

## 5 · Valvonta

`monitor.py` ajaa kolmetoista kanaria yhdeksän proxyn yli ja erottaa
neljä virhetilaa:

    proxy_down        tavoitettavuusproobi ei vastaa
    upstream_error    nopea 5xx ylävirrasta
    upstream_slow     katkeaa lyhyellä, onnistuu pitkällä
    canary_route      4xx, reitti tai parametri väärin

Ja kaksi tiivistettä yhden sijaan: `schema_hash` (avainjoukko) ja
`value_hash`. Neljä tilaa kahden sijaan — **skeeman muutos erottuu
datan muutoksesta.**

**Kanarien reitit on todennettava**, ei pääteltävä. Kaksi ensimmäistä
kanaria osoittivat reitteihin joita ei ole olemassa.

`fingrid-ds192`-kanarin oma kommentti kutsuu DS 192:ta "EPP:ksi" —
sama epätarkka nimi kuin `worker.js`:n DS 242:lla (ks. 2, Fingrid).
Ei korjattu koodissa vielä, koska oikeat nimet ovat vahvistamatta.

Kolme proxya on yhä valvomatta (`aci-lausunto-proxy` ja
`aci-finto-proxy` tarkoituksella, ks. `monitor.py`:n oma kommentti).

---

## 6 · Yksi asia joka on tärkeämpi kuin muut

Lähes jokainen tämän istunnon virhe löytyi siksi, että **kaksi lukua
verrattiin toisiinsa** — ei siksi että yksi luku olisi näyttänyt
väärältä.

DS 105:n vakionolla löytyi kun spot-hinta ja S_ENERGY eivät täsmänneet.
Aliaksen ylikirjoitus löytyi lukemalla vastauksen rakenne. CHP:n väärä
rooli löytyi kun kesä ja talvi vertailtiin. Ulottuvuuskortin väärä
mittari löytyi tulosteesta, ei testeistä. Fingridin 400-katto-uskomus
löytyi kun 400:aa verrattiin 20000:een. DS 192 ja 242 erosivat kun
niitä verrattiin samalta tunnilta.

**Yksi luku ei paljasta mitään. Kaksi lukua paljastaa ristiriidan.**
