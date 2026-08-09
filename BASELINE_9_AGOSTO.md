# Baseline — implementazione reale contro il modello target

*9 agosto 2026, prima di toccare una riga. Tutti i numeri sono misurati, nessuno stimato.*

Questa è la fotografia da cui parte il riordino. Ogni batch va confrontato con questa
pagina: se un numero peggiora, il batch ha rotto qualcosa.

---

## Come si rilegge

```bash
node attrezzi/matrice-capacita.js         # a schermo
node attrezzi/matrice-capacita.js --md    # riscrive MATRICE_CAPACITA.md
```

---

## 1. Capacità — `One capability = one canonical definition`

**Stato: 0% del modello.** Non esiste nessun registro canonico. Sei registri
indipendenti, aggiornati a mano.

| misura | oggi | target |
|---|---|---|
| Registri da aggiornare a mano per una capacità | **6** | 1 |
| Schemi dichiarati | 83 | = capacità complete |
| Handler registrati | 91 | = 83 |
| Comandi estensione | 115 | = quelli dichiarati |
| **Handler senza schema — esistono, il modello non li vede** | **8** | 0 |
| **Capacità fuori da ogni ambito — mai consegnate** | **4** | 0 |
| **Comandi estensione che nessun handler chiama** | **76 su 115** | 0 |
| Comandi chiesti al ponte e non esposti | 0 | 0 |

Gli 8 handler irraggiungibili: `A_SESSIONE` `web_search` `execute_js` `read_inbox`
`send_whatsapp` `send_linkedin` `linkedin_send_message` `whatsapp_send`.

Due di questi — `whatsapp_send` e `linkedin_send_message` — sono i gemelli senza regole
d'invio che il 7 agosto hanno fatto uscire sette messaggi scavalcando i limiti. Oggi
sono fuori dagli ambiti ma **vivi nel codice**: sono `DELETE`, non `LEGACY`.

Le 4 fuori ambito: `open_whatsapp` `prepare_whatsapp_message` `open_linkedin`
`prepare_linkedin_message`.

### Classificazione degli 83 strumenti

| classe | quanti | significato |
|---|---|---|
| **TIENI** | 25 | usati, funzionano |
| **DA-PROVARE** | 40 | mai chiamati in 132 turni: o inutili o irraggiungibili |
| **FIX** | 7 | usati e falliscono più della metà delle volte |
| **LEGACY** | 7 | gemelli perdenti, già fuori dagli ambiti normali |
| **ROTTO-MAI-USATO** | 4 | anello mancante e nessuno se n'era accorto |

I 7 da riparare, con i numeri veri:

| capacità | chiamate | fallite |
|---|---|---|
| `crea_report` | 16 | **12** |
| `linkedin_connect` | 9 | **6** |
| `request_human_takeover` | 4 | **3** |
| `guarda_pagina` | 2 | **2** |
| `agisci` | 1 | **1** |
| `read_table` | 1 | 1 |
| `wait_network_idle` | 1 | 1 |

---

## 2. Failure Journal — `mai più ricostruire un errore per indizi`

**Stato: 0% del modello.**

| misura | oggi | target |
|---|---|---|
| Ritorni `ok:false` negli handler | 56 | — |
| **Di questi, con un `code` strutturato** | **0** | 56 |
| Con almeno un motivo testuale | 34 | 56 |
| Registro append-only delle esecuzioni | **non esiste** | esiste |
| Chiamate registrate senza il perché | **880 su 880** | 0 |

Il log attuale (`response_log.jsonl`) salva `{name, args, ok}`. Il motivo del fallimento
non è scritto da nessuna parte, in nessun file.

**Costo misurato:** per capire perché `guarda_pagina` fallisse ho dovuto incrociare
quattro file e due endpoint, e alla fine la causa resta un sospetto non confermato.

---

## 3. Startup Integrity Gate

**Stato: 0% del modello.** Nessuna verifica esiste. COBRA parte sempre.

| controllo richiesto | oggi |
|---|---|
| schema ↔ handler | assente |
| capacità ↔ ambito | assente |
| capacità ↔ rischio | assente |
| handler ↔ comando estensione | assente |
| comando estensione ↔ file caricato nel worker | assente |
| duplicati | assente |
| orfani nelle due direzioni | assente |

L'estensione **manda già** l'elenco di cosa sa fare al momento dell'aggancio
(`_bridgeCapabilities`, `ws/server.js:72`). Nessuno lo confronta con niente.

---

## 4. Job State — Source of Truth unica

**Stato: ~15% del modello.** I pezzi esistono, sparsi in **undici** depositi distinti.

| campo del modello | dove sta oggi |
|---|---|
| `objective`, `criteria` | Collega → `missioni.json` |
| `plan`, `steps`, `current_step` | `_planTemplates` in memoria + `processo_*` |
| `collected_data` | `cantiere_aperto.json` — **0 voci** |
| `evidence` | `registro_fonti.json` — 22 voci |
| `failures` | **da nessuna parte** |
| `outputs` | file su disco, non collegati al job |
| `status` | tre posti diversi |

Undici depositi: processo, cantiere, tasks, missioni, memoria sessione, conversazioni,
lezioni, fatti appresi, registro fonti, rubrica, stato apprendimento.

---

## 5. Working memory automatica

**Stato: 0% del modello.**

| misura | oggi |
|---|---|
| `annota` chiamato | **5 volte su 880** |
| Voci nel cantiere | **0** |
| Capacità che scrivono da sole nel job | **0** |
| `memoria_siti.json` | mai creato |
| `procedure.json` | mai creato |

Tutta la memoria di lavoro dipende oggi da una chiamata volontaria che il modello fa
nello 0,6% dei casi.

---

## 6. Completion Controller — un solo cancello

**Stato: ~60% del modello.** `completamento.js` esiste, è deterministico e funziona —
ha già smentito il modello più volte. Ma **non è l'unico cancello**.

Seconda porta trovata, `supermario.js:585`:

```js
const completedRe = new RegExp(`\\[STEP\\s*${step.step}\\s*COMPLETATO\\]`, 'i');
if (completedRe.test(responseText)) step.status = 'completed';
```

Un passo diventa completo perché il modello ha **scritto una frase**. Nessuna evidence,
nessun criterio. È la stessa classe del `task.status='completed'` incondizionato che
abbiamo già tolto una volta.

Terza porta: `supervisor/cobra.js:20`, `completeRequest()`.

---

## 7. Supervisore

**Stato: ~50%.** Esiste, è deterministico, non sceglie strumenti — corretto. Ma non
emette gli stati del modello (`CONTINUE / STALLED / REPLAN / WAIT / STOP`): usa un
vocabolario suo, e può scrivere `completed`.

---

## 8. Le memorie

**Stato: ~30%.** Le quattro esistono ma i confini non tengono.

| memoria del modello | file di oggi | problema |
|---|---|---|
| Working | `cantiere_aperto` | vuota, dipende dal modello |
| Conversation | `conversations`, `memoria_sessione` | due file per la stessa cosa |
| Long-term | `learned_facts`, `memories`, `lezioni` | **tre** file, confini non definiti |
| Site/Procedure | `memoria_siti`, `procedure` | **mai creati** |

Il percorso `failure → working → recovery → lesson candidate → long-term` non esiste:
`lezioni.json` ha già 6 voci scritte direttamente, senza passare da nessuna verifica.

---

## 9. SuperMario

**Stato: da ridurre.** Oggi fa **sette** lavori: routing intento, scelta ambiti,
selezione strumenti, scelta modello, costruzione prompt, riassunto conversazione,
**e aggiornamento dello stato del piano** (il punto 6).

Il target è uno solo: Execution Context Builder. Il settimo lavoro è quello da togliere
per primo, perché è anche una violazione del Cancello.

---

## Quadro d'insieme

| area | conformità al modello |
|---|---|
| Capability Registry | 0% |
| Failure Journal | 0% |
| Integrity Gate | 0% |
| Job State unico | 15% |
| Working memory automatica | 0% |
| Memorie separate | 30% |
| Supervisore | 50% |
| Completion Controller | 60% |
| Gerarchia a 4 livelli | 40% |

**Le tre aree a zero sono anche le tre più economiche**, e sono quelle che rendono
misurabile tutto il resto. L'ordine indicato nelle istruzioni è quello giusto.
