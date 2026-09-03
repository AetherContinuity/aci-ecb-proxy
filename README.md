# aci-ecb-proxy

Cloudflare Worker proxy for the financial-environment layer: rates,
inflation, sovereign yields, Finnish state debt and budget accounting.

Nimi on historiallinen jäänne. Repo sisältää ECB:n lisäksi Eurostatin,
Suomen Pankin ja Valtiokonttorin. Politiikkapuoli (Hankeikkuna, Eduskunta,
Finlex) on erillisessä `aci-policy-proxy`-reposssa.

Olemassa siksi, että nämä hostit eivät ole hiekkalaatikon
domain-sallilistalla ja osa vaatii pyyntömuotoja (SDMX-avaimet, CSV,
kursorisivutus), jotka menevät helposti pieleen.

## Upstreams

| Lähde | Kanta | Luokka |
|---|---|---|
| ECB Data Portal | `data-api.ecb.europa.eu/service/data` | measured |
| Eurostat | `irt_lt_mcby_m` (10 v tuotot) | measured |
| Suomen Pankki | `api.boffsaopendata.fi/v4` | measured |
| Valtiokonttori | `api.tutkihallintoa.fi` | authoritative (kirjanpito) |
| Fingrid | yksi datasetti, ks. `aci-fingrid-proxy` | measured |

## Reitit

### ECB (SDMX 2.1)

    ?ecb=HICP.M.U2.N.000000.4D0.ANR&last=24     raaka passthrough
    ?ecb=ICP.M.DE+FR+U2.N.000000+XEF000.4.ANR&start=2025-01
    ?series=ECB-INFLATION&last=18               headline+core+energy+services
    ?series=ECB-RATES&last=400                  DFR+MRO+MLF
    ?struct=HICP                                dimensiokoodit

Aliakset: `ECB-DFR MRO MLF ESTR EURIBOR1M/3M/6M/12M HICP CORE ENERGY
SERVICES FOOD TRIM50`.

### Suomen Pankki

    ?bofdatasets=1                              8 aineistoa
    ?bofstruct=MFI_PUBL                         18 dimensiota
    ?bofseries=MFI_PUBL&pageSize=50&page=1      1 382 sarjaa
    ?bof=MFI_PUBL.<seriesName>&bofStart=2020-01-01&bofEnd=2026-12-31

### Tuotot ja spreadit

    ?series=FI10Y | DE10Y | SE10Y | DK10Y
    ?series=FI-DE | FI-SE | FI-DK | ALL
    &start=YYYY-MM&end=YYYY-MM

### Valtiokonttori — budjettitalous

    ?vk=1&paaluokka=27&yearFrom=2024&yearTo=2026
    ?vk=1&momentti=27.01.29.&yearFrom=2024&yearTo=2026
    ?vk=1&luku=2701&yearFrom=2024&yearTo=2026

Kaikki upstreamin parametrit välitetään: `momentti luku paaluokka takptili
tililaji tiliryhma ylatiliryhma tililuokka lkptili hallinnonala tilivirasto
monthFrom monthTo yearFrom yearTo`. Vähintään yksi rajaus on pakollinen.

### Valtiokonttori — velka

    ?series=VK-INTEREST | VK-DEBT-GDP | VK-SENSITIVITY | VK-STRUCTURE | ...
    ?vkdebt=<slug>&lang=FI                      raaka passthrough

### Valtiokonttori — kaikki API-perheet

    ?vkapi=central-government-debt/v1/emtn-bond-issues&lang=FI
    ?vkapi=<perhe>/<versio>/<operaatio>

Osaa sekä JSON:n että CSV:n. Perheet portaalista
<https://avoindata.tutkihallintoa.fi>: `central-government-debt/v1`,
`valtiontalous/v1`, Financing and loans (lainat, korkotuet,
**valtiontakaukset**), Tilikartta, Kuntatalous, Valtion henkilöstö.

## Ansat

Nämä ovat kaikki todettuja, eivät oletuksia. Jokainen maksoi selvitystyötä.

**1. Momentin muoto on `27.01.29.`** — pisteillä ja päättyvällä pisteellä.
Portaalin dokumentaatio antaa esimerkiksi `254074`. Se ei toimi. Eivät myöskään
`270129` eikä `270129.`. Väärä muoto palauttaa **nolla riviä ilman
virheilmoitusta**. Oikea muoto on sama kuin aineiston oma
`Momentti_TunnusP`-kenttä.

**2. Aikaikkuna on kolme vuotta.** `yearFrom=2020&yearTo=2026` → 0 riviä.
`yearFrom=2024&yearTo=2026` → 194 riviä. Ei virhettä, tyhjä vastaus.
Pidemmät sarjat haetaan kolmen vuoden ikkunoissa ja yhdistetään.

**3. Valtiokonttorin CSV on pilkkueroteltu**, ei puolipiste-eroteltu.
Ennen 3.9.2026 korjausta jokainen rivi jäsentyi yhteen kenttään, jonka
avain oli koko otsikkorivi — dataa tuli 224 riviä ja se näytti toimivan.
Jäsennin tunnistaa erottimen nyt otsikosta ja kunnioittaa lainausmerkkejä
(kenttien nimissä on pilkkuja).

**4. Suomen Pankin kanta on `/v4`, ei `/v3/api`.** v3 on deprekoitu ja
koko polku poistettu — myös hostin juuri palauttaa 404. v4:ssä ei ole
`/api`-segmenttiä ja polut ovat pienellä: `datasets`, `structures/{ds}`,
`series/{ds}`, `observations/{ds}`. Ei vaadi API-avainta.

**5. ECB:n `ICP`-dataflow poistui 4.2.2026**, korvaajana `HICP`.
Palveluntarjoajakoodi on kolmimerkkinen: `4D0` Eurostat, `4F0` ECB.
Vanha `4` ei toimi. Hyödykekoodit `NRGY00 SERV00 FOOD00 XEF000` säilyivät.

**6. Eurostatin tuottosarjan desimaalitarkkuus vaihtuu 2025-01** kahdesta
kolmeen (2,65 → 2,945). Lähdemuutos, ei virhe. Kuukausimuutoksia
laskettaessa rajakohta tuottaa keinotekoista tarkkuutta.

**7. Velkarajapinnassa on 17 operaatiota**, koodissa 12. `VK-EFFECTIVE-COST`
ja `VK-REDEMPTIONS` palauttavat 404 — operaatiot ovat olemassa mutta slug
on muuttunut. Slugia ei voi päätellä nimestä ("Bond issues under the EMTN
programme" → `emtn-bond-issues`). Oikeat nimet portaalin
"Download definition" -tiedostosta; sen jälkeen `?vkdebt=` toimii ilman
koodimuutosta.

**8. Puuttuvat operaatiot** (löytyvät portaalista, eivät koodissa):
Long- and short-term debt · Market and nominal value · Redemptions of
central government debt · Secondary market · Treasury bill issues.

## Suunnitteluperiaate

Jokaisessa perheessä on raaka passthrough nimettyjen aliasten rinnalla.
Syy on ansa 1, 4, 5 ja 7: **ylävirran nimet muuttuvat, ja muutos on
hiljainen.** Passthrough tarkoittaa, että uusi sarja tai uudelleennimetty
päätepiste on käytettävissä heti kun sen nimi on tiedossa, ilman deployta.

Haetut arvot eivät kuulu muistiin; tämä rajapinta kuuluu.

## Data-luokat

Vastaukset sisältävät `data_class`-kentän. Erottelu on tarkoituksellinen:

- **measured** — mitattua (Fingrid, Eurostat, ECB, BoF)
- **authoritative** — kirjanpitoa tai lakia (Valtiokonttori, Finlex)
- **self-reported process data** — hallinnon oma kertomus itsestään
  (Hankeikkuna, `aci-policy-proxy`)

Näitä ei saa sekoittaa koosteissa.
