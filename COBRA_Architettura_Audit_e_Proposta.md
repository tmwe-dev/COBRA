# COBRA — Audit dell'albero e proposta di riordino

*9 agosto 2026 · basato sui dati vivi, non sul codice letto a occhio*

---

## PARTE 1 — Cosa dicono i dati

Tutti i numeri qui sotto vengono da `data/response_log.jsonl` (131 turni veri, dall'11
maggio al 9 agosto), dai file in `data/`, dal database Supabase e dal conteggio diretto
dei moduli. Nessuno è stimato.

### 1.1 La dimensione

| | |
|---|---|
| Moduli server | 103 file, 20.026 righe |
| Strumenti dichiarati al modello | 83 |
| Handler registrati | 91 |
| Comandi nell'estensione | 96 |
| Turni registrati | 131 |
| Chiamate a strumenti | 880 |

### 1.2 Cosa succede quando lo accendi

| | |
|---|---|
| Chiamate fallite, storico | 67 su 880 = **7,6%** |
| Chiamate fallite, ieri | 8 su 42 = **19,0%** |
| Passi di piano falliti | 46 su 113 = **40,7%** |
| Strumenti mai usati in 131 turni | **49 su 83** |
| Comandi dell'estensione che nessun handler chiama mai | **58 su 96** |
| Handler senza schema, irraggiungibili dal modello | **8** |
| Strumenti fuori da ogni ambito, mai consegnati | **4** |

### 1.3 Le funzioni orfane

| Cosa | Stato |
|---|---|
| `cantiere_aperto.json` | **0 voci** — `annota` chiamato 5 volte su 880 |
| `memoria_siti.json` | **mai creato** |
| `procedure.json` | **mai creato** |
| `tasks.json` | **0 voci** |
| `guarda_pagina`, `agisci` | invocati per la prima volta il 9 agosto: **falliti 3 volte su 3** |
| `fill_form`, `select_option`, `press_key`, `set_datepicker` | **mai chiamati**, in 31 richieste di viaggio |

### 1.4 Il caso che spiega tutto: 31 ricerche voli

Cinque giorni, 31 turni, fino a **618 secondi** per il più lungo. Esito costante:
*"la pagina non ha caricato i prezzi"*.

In **23 di quei 31 turni** l'ambito `interact` era attivo: il modello aveva in mano
`fill_form`, `guarda_pagina`, `agisci`, `leggi_modulo`, `set_datepicker`. Il prompt
`navigator` gli dice testualmente *"Su form di RICERCA (voli, hotel, cataloghi):
COMPILA"*.

Non ne ha chiamato **nessuno**, mai, per cinque giorni.

Il 9 agosto, con l'ordine esplicito *"vai su skyscanner e compila il modulo"*, ci ha
provato al primo colpo:

```
✓ navigate skyscanner.it
✓ leggi_modulo                                    ← prima volta in assoluto nel log
✗ agisci      {id:"Milano (Qualsiasi)", cosa:"clicca"}
✗ guarda_pagina
✗ guarda_pagina
✓ navigate google flights (con la query già nell'URL)
```

Luca guardava lo schermo: **la pagina di Google Voli era lì, compilata, con i prezzi
visibili.** COBRA ha risposto che non riusciva a ottenere i prezzi.

Tre difetti distinti in dieci chiamate:

1. **`agisci` chiamato prima di `guarda_pagina`, con un'etichetta al posto di un id.**
   `leggi_modulo` restituisce i campi per NOME ("Milano (Qualsiasi)"); `agisci`
   pretende gli id di `guarda_pagina` ("E7"). Due strumenti per lo stesso lavoro, con
   due vocabolari incompatibili. Il modello ha mescolato, ed era prevedibile.
2. **`guarda_pagina` fallisce.** Scritto l'8 agosto, consegnato senza una sola prova
   viva, rotto al primo contatto reale.
3. **Il motivo del fallimento non è scritto da nessuna parte.** Nel log resta `ok:false`
   e basta. Per capire cosa fosse successo ho dovuto incrociare quattro file.

### 1.5 La stessa ferita, otto volte

Nei commenti del codice — scritti da me, nei giorni scorsi — ci sono **sette** incidenti
già documentati con la stessa forma:

> *"Lo strumento c'era, in schemas.js, dal primo giorno: non era mai stato messo in mano
> a chi doveva usarlo. È la sesta volta che succede."* — `supermario.js`

> *"whatsapp_scrivi e linkedin_scrivi sono QUI, e non altrove... e mi sono dimenticato
> questa riga. Risultato: COBRA rispondeva 'non posso mandare messaggi WhatsApp', con lo
> strumento a due centimetri."* — `supermario.js`

> *"Uno strumento non elencato qui non esiste, per quanto sia ben fatto."*

Il 9 agosto è l'ottava. E ce ne sono altre due della stessa famiglia:

- `loadAPIKeys()` e `loadOperatorConfig()` chiamate **scartando il risultato**: le chiavi
  arrivavano da Supabase, entravano in un oggetto che nessuno leggeva, e restavano lì.
  Cinque chiavi API esposte in cambio di zero.
- `bridgeCommand` esisteva in due copie; ho corretto per giorni quella che non veniva
  usata.

---

## PARTE 2 — La diagnosi

### 2.1 Non mancano i layer

L'istinto dice: aggiungiamo moduli, aggiungiamo strati. Guardiamo cosa c'è già:

```
Collega · SuperMario · Esecutore · Supervisore · Cantiere · Completamento
Ripresa · Requisiti · Recupero · Fonti · Rubrica · Regole d'invio · Sguardo
Procedure · Memoria siti · Memoria sessione · Fatti appresi · Lezioni
Conversazioni · Missioni · Registro invii · Paywall · Rischio · Whitelist
```

Ventiquattro responsabilità distinte, 103 file, 20.000 righe. **Non è un sistema povero
di strati. È un sistema ricco di strati e povero di contratti fra gli strati.**

### 2.2 Dove si rompe davvero

Nessuno dei guasti dell'ultima settimana è dentro un modulo. Sono **tutti** nelle
giunzioni. Uno strumento, oggi, per funzionare deve essere registrato a mano in sei
posti diversi:

```
1. schemas.js          lo schema che il modello vede
2. TOOL_SCOPES         l'ambito, cioè quando gli viene consegnato
3. taxonomy.js         il rischio, cioè se serve conferma
4. handlers/index.js   la funzione che lo esegue
5. estensione          il comando che tocca la pagina
6. importScripts       il file caricato nel service worker
```

Sei posti, sei file, sei occasioni di dimenticare. **Nessuno dei sei controlla gli altri
cinque.** Se ne salti uno il sistema non protesta: parte, i test passano, e lo strumento
semplicemente non esiste — o esiste e non arriva, o arriva e non esegue.

I numeri lo dicono senza ambiguità: 8 handler senza schema, 4 schemi fuori da ogni
ambito, 58 comandi dell'estensione che nessuno chiama, 49 strumenti mai usati.
**È la stessa crepa, misurata da quattro angoli.**

### 2.3 Il secondo difetto: nessuno registra il perché

880 chiamate, 67 fallite, **zero motivi conservati**. Il log salva `ok:false`.

Questo è il moltiplicatore di tutto il resto: ogni guasto va ricostruito per indizi,
ogni ricostruzione costa una sessione, e nel frattempo si costruisce sopra. È il motivo
per cui giriamo in tondo — non l'incapacità di aggiustare, ma l'incapacità di **vedere**.

### 2.4 Il terzo difetto: il modello sceglie sempre la strada che non fallisce

`google_search` produce sempre del testo. Compilare un modulo può fallire. Fra le due,
il modello prende la prima, ogni volta, per cinque giorni — anche quando il prompt gli
dice il contrario, perché un prompt è un consiglio e la ricompensa immediata è un'altra.

**Un consiglio nel prompt non è un vincolo.** Le uniche cose che hanno retto, questa
settimana, sono quelle scritte in codice: il cancello di `completamento.js`, le regole
d'invio, il registro delle fonti che rifiuta un prezzo inventato.

---

## PARTE 3 — La proposta

Tre principi, poi la struttura.

> **1. Una cosa si dichiara UNA volta.** Se va scritta in sei posti, prima o poi ne salti uno.
> **2. Quello che non si può misurare non si può aggiustare.** Ogni fallimento lascia un perché.
> **3. Le regole che contano stanno nel codice, non nel prompt.** Il prompt persuade, il codice vincola.

### 3.1 La Capacità: un solo posto per dichiarare uno strumento

Oggi sei file. Domani uno:

```js
// modules/capacita/guarda-pagina.js
module.exports = {
  nome: 'guarda_pagina',
  descrizione: 'GUARDA la pagina e restituisce tutto ciò su cui si può agire...',
  argomenti: { quanti: { tipo: 'numero', predefinito: 120 } },
  ambiti: ['browse', 'interact', 'communicate'],
  rischio: 'read',
  comandoEstensione: 'guarda',        // dichiarato, quindi verificabile
  esegui: async (args, ctx) => { ... },
  prova: async (ctx) => { ... },      // la prova viva, obbligatoria
};
```

Schema, ambito, rischio, handler, comando dell'estensione: **una riga ciascuno, nello
stesso file, accanto al codice che li usa.** Gli elenchi `TOOL_SCOPES`, `TOOL_RISK`,
`handlers/index.js` non si scrivono più a mano: si **generano** leggendo le capacità.

### 3.2 Il controllo all'avvio che rifiuta di partire

```
[Capacità] 83 dichiarate, 83 complete.
[Capacità] ✗ guarda_pagina dichiara comandoEstensione 'guarda' — l'estensione non lo espone
           COBRA non parte. Ricarica l'estensione o correggi la capacità.
```

Le stesse otto ferite di cui sopra, tutte, sarebbero morte all'avvio invece che in
produzione dopo cinque giorni. Non serve altro che confrontare quattro elenchi che oggi
nessuno confronta.

Ai comandi dell'estensione si chiede la stessa cosa: all'aggancio del bridge manda
l'elenco di cosa sa fare — **lo manda già**, `_bridgeCapabilities`, e nessuno lo guarda.
Basta guardarlo.

### 3.3 Il diario: un perché per ogni fallimento

Un solo file, una riga per chiamata:

```jsonl
{"quando":"...","strumento":"guarda_pagina","ok":false,
 "perche":"globalThis.Sguardo non definito nel service worker",
 "dove":"estensione","tentativo":1,"lavoro":"lav_8871"}
```

Da qui vengono, gratis: il tasso di fallimento per strumento, quale sito blocca cosa,
quale passo si incaglia sempre, se un fix ha funzionato davvero. Oggi tutte queste
domande richiedono una sessione di archeologia.

### 3.4 Le quattro memorie, con confini netti

Oggi ci sono otto file di memoria e non è chiaro chi scrive cosa. Quattro, con una
regola sola ciascuna:

| Memoria | Vive | Chi scrive | Cosa contiene |
|---|---|---|---|
| **Il tavolo** (temporanea) | il lavoro | **il codice** | quello che sto raccogliendo adesso |
| **Il mestiere** | per sempre | il codice, dagli esiti | come si fa una cosa su un sito |
| **I fatti** | per sempre | Luca, o il modello con conferma | il codice cliente di Rossi è 4471 |
| **Le persone** | per sempre | il codice, dalle letture | chi ha scritto, con che numero |

La riga che conta è la seconda colonna: **il tavolo lo scrive il codice, non il modello.**

Il Cantiere è a 0 voci perché aspetta che il modello chiami `annota`, e il modello lo
chiama 5 volte su 880. Un dato raccolto da `scrape_url`, una fonte registrata, un passo
completato: sono cose che **il sistema sa già**, e che deve scrivere da sé. Chiedere al
modello di annotare quello che il codice ha appena visto è chiedergli un favore che non
farà.

### 3.5 Le operazioni: una sola strada per lavoro

Il caso di ieri è esemplare: due modi di guardare una pagina (`leggi_modulo` per nome,
`guarda_pagina` per id) e il modello li ha mescolati.

**Uno solo vince, l'altro sparisce dagli ambiti.** La regola esiste già in
`supermario.js` (`unoPerLavoro`) e ha già salvato gli invii: va estesa a guardare,
cliccare, scrivere, leggere. Se due strumenti fanno la stessa cosa, il modello prima o
poi userà quello sbagliato — non per stupidità, perché gliene abbiamo dati due.

### 3.6 Le decisioni: chi dice "fatto" è uno solo

Questo pezzo **c'è già ed è quello che funziona meglio**: `completamento.js` è l'unico
cancello, è deterministico, e ha smentito il modello più volte. Va lasciato dov'è ed
esteso di un passo:

> Nessun passo può essere dichiarato completo se non ha prodotto **un fatto verificabile**
> — una riga sul tavolo, un file, una fonte registrata. "Ho cercato" non è un risultato.

I 46 passi falliti su 113 diventano misurabili, e soprattutto diventano **onesti**: oggi
un passo può risultare completo senza aver prodotto niente.

### 3.7 La gerarchia, in una riga

```
Luca
 └─ COLLEGA        capisce cosa serve, scrive i criteri, giudica alla fine
     └─ PIANO      i passi, sul disco, uno alla volta          [il Cantiere]
         └─ ESECUTORE   fa un passo con gli strumenti dell'ambito
             └─ CAPACITÀ    una cosa sola, dichiarata una volta sola
     ├─ SUPERVISORE   guarda da fuori: si ripete? è fermo? riprende?
     └─ CANCELLO      l'unico che dice "fatto", e chiede la prova
```

Quattro livelli, non ventiquattro. Tutto il resto — rubrica, fonti, rischio, memoria —
non è un livello: è un **servizio** che i livelli chiamano.

---

## PARTE 4 — L'ordine dei lavori

| | Cosa | Perché prima | Costo |
|---|---|---|---|
| **1** | Il diario dei fallimenti | senza, ogni fix è a indovinare | mezza giornata |
| **2** | Il controllo all'avvio sui quattro elenchi | uccide otto ferite di colpo, senza toccare niente | mezza giornata |
| **3** | Riparare `guarda_pagina` e unificare il vocabolario | è il blocco vivo di oggi | un giorno |
| **4** | Il tavolo scritto dal codice | sblocca Cantiere, procedure, memoria siti | un giorno |
| **5** | Le Capacità, una per file | il riordino vero, con 1 e 2 già in guardia | tre giorni, graduale |

**Il 5 va fatto per ultimo e a piccoli passi**, una capacità alla volta, con il controllo
all'avvio già acceso. Riscrivere 83 strumenti in un colpo, in un sistema che oggi
sbaglia il 19% delle chiamate, è il modo più affidabile per rompere quello che funziona.

---

## PARTE 5 — Quello che NON farei

**Non aggiungerei moduli paralleli.** Ventiquattro responsabilità e sei registri manuali
sono già più di quanto una persona sola possa tenere allineato. Ogni modulo nuovo
aggiunge giunzioni, e le giunzioni sono esattamente dove si rompe. La strada è
**meno pezzi con contratti verificati**, non più pezzi.

**Non alzerei il modello adesso.** Lo avevo proposto stamattina e i dati mi hanno
smentito: le ricerche voli giravano già su `gpt-4o` e fallivano identiche. Con
`guarda_pagina` rotto, un modello migliore fallisce più in fretta e costa di più. Si
rimisura dopo il punto 3.

**Non aggiungerei istruzioni al prompt.** Il prompt `navigator` diceva già "COMPILA" e
per cinque giorni non è servito a niente. Quello che deve valere va nel codice.
