# CODEX COBRA — GUIDA DI ACCESSO RAPIDO
## Routing operativo per agenti AI

> **Scopo del documento.** Questo file è la mappa autostradale della Knowledge Base del Codex Cobra. Non contiene le regole: contiene **come arrivare alle regole nel minor numero di salti possibile**, dato un intento dell'utente.
>
> **Come si legge.** L'agente identifica l'intento dell'utente, trova la voce corrispondente in §2 (Routing per Intento), esegue la sequenza di consultazione lì indicata, applica i checkpoint di §4 nei momenti critici, e produce output nel formato di §5.
>
> **Notazione.** I nodi della KB sono identificati come `PILLAR.II.3`, `COMM.I.a`, `ANTI.7.5`, ecc. La freccia `→` indica una sequenza obbligatoria (in quest'ordine). La barra `|` indica alternative. Le parentesi quadre `[…]` indicano condizioni.

---

## §1 — INDICE DELLE SCORCIATOIE

| Scorciatoia | Significato | Quando usarla |
|---|---|---|
| `SC:CLASSIFY` | Classifica l'intervento (Trim/Standard/Critical) | Sempre, primo passo |
| `SC:VERB` | Esegui le 9 domande del Verbo Cobra | Prima di ogni consegna |
| `SC:DEFENSE` | Lista difensiva: validazione + sicurezza + log | Quando si scrive codice |
| `SC:ROLLBACK` | Piano di reversibilità | Prima di ogni modifica Standard/Critical |
| `SC:CHANGELOG` | Template del changelog di consegna | Alla chiusura |
| `SC:DOUBT` | Routing per gestione incertezza | Quando emerge dubbio |
| `SC:DATA` | Sequenza per modifiche a dati persistenti | Su DB/cache/storage |
| `SC:ANTI` | Scan rapido degli anti-pattern | Prima della consegna |
| `SC:DEPLOY` | Sequenza pre-deploy → post-deploy | Su rilasci |
| `SC:TEST` | Selezione tassonomia test in base alla classe | In fase di verifica |

Ciascuna scorciatoia è dettagliata in §3.

---

## §2 — ROUTING PER INTENTO DELL'UTENTE

L'agente fa pattern matching tra il messaggio dell'utente e i trigger qui sotto. Il primo match in lettura attiva la rotta corrispondente.

### 2.1 — "Fixa questo bug" / "C'è un errore" / "Non funziona X"

**Trigger:** `bug`, `errore`, `non funziona`, `crash`, `eccezione`, `comportamento sbagliato`

**Rotta obbligatoria:**
```
SC:CLASSIFY
→ PILLAR.III.1   (riproduzione prima della soluzione)
→ PILLAR.III.2   (sintomo vs causa: formula entrambi)
→ PILLAR.I.3     (mappa la catena dove si manifesta)
→ PILLAR.II.1    (traccia flusso end-to-end del dato)
→ PILLAR.II.2    (blast radius del fix proposto)
→ [se classe ≥ STANDARD] SC:DEFENSE
→ ANTI.7.5       (NON mescolare refactor al fix)
→ PILLAR.V.1 + V.2  (test e2e + regressione)
→ SC:CHANGELOG
```

**Domanda di blocco da porsi:** *"Ho riprodotto il bug o sto operando solo sulla descrizione dell'utente?"* Se la seconda → leggi codice causa prima di proporre fix.

---

### 2.2 — "Aggiungi feature X" / "Implementa Y"

**Trigger:** `aggiungi`, `implementa`, `crea`, `nuova feature`, `nuovo endpoint`

**Rotta obbligatoria:**
```
SC:CLASSIFY
→ PILLAR.I.1     (obiettivo in una frase)
→ PILLAR.I.2     (criterio di successo)
→ PILLAR.I.3     (dove si innesta nell'architettura)
→ PILLAR.I.4     (stile e convenzioni del modulo)
→ PILLAR.I.5     (punto corretto, non facile)
→ [se tocca dati] SC:DATA
→ [se tocca esterno/credenziali] PILLAR.II.4
→ SC:DEFENSE
→ PILLAR.II.5    (atomicità: solo questa feature)
→ SC:ROLLBACK
→ SC:TEST
→ SC:VERB        (autocontrollo finale)
→ SC:CHANGELOG
```

---

### 2.3 — "Refactora X" / "Pulisci questo codice"

**Trigger:** `refactor`, `pulisci`, `rinomina`, `riorganizza`, `sistema`

**Rotta obbligatoria:**
```
SC:CLASSIFY                         [tipicamente STANDARD]
→ PILLAR.I.4     (convenzioni esistenti — NON imporre stile personale)
→ PILLAR.II.1    (chi consuma il codice da rifattorizzare)
→ PILLAR.II.2    (blast radius)
→ PILLAR.II.5    (UN refactor per volta, niente fix a margine)
→ ANTI.7.5       (mai refactor + bug fix insieme)
→ PILLAR.V.2     (regressione = priorità #1 nel refactor)
→ SC:ROLLBACK
→ SC:CHANGELOG
```

**Vincolo specifico:** un refactor che cambia comportamento osservabile NON è un refactor. Se cambia il comportamento, riclassificare come feature o bug fix.

---

### 2.4 — "Modifica lo schema dati" / "Aggiungi campo a tabella" / "Cambia il database"

**Trigger:** `schema`, `migrazione`, `tabella`, `campo`, `colonna`, `alter`, `database`, `cache`, `storage`

**Rotta obbligatoria — CRITICAL per default:**
```
COMM.I.a         (incertezze CRITICHE → ferma e chiedi)
→ SC:CLASSIFY    [→ CRITICAL salvo prova contraria]
→ PILLAR.IV.2    (le tre domande dei dati persistenti)
→ PILLAR.II.1    (chi legge/scrive il campo)
→ PILLAR.II.2    (blast radius su consumer downstream)
→ SC:ROLLBACK    (piano OBBLIGATORIO, scritto)
→ APPENDIX.A.3   (approvazione esplicita richiesta)
→ APPENDIX.C.1   (pre-deploy: migrazione separata dal codice se possibile)
→ SC:TEST        [unit + integration + dati reali anonimizzati]
→ SC:CHANGELOG
```

**Domande non opzionali** (PILLAR.IV.2): *Cosa accade ai dati esistenti? Serve migrazione idempotente e reversibile? Cosa accade se il campo nuovo manca nei record vecchi?*

---

### 2.5 — "Integra API esterna" / "Connetti servizio Z"

**Trigger:** `integrazione`, `API esterna`, `webhook`, `connetti`, `chiama servizio`

**Rotta obbligatoria:**
```
SC:CLASSIFY                         [tipicamente CRITICAL]
→ PILLAR.II.4    (credenziali e secret)
→ PILLAR.II.3.b  (fail safely su servizio esterno giù)
→ PILLAR.II.6    (logging strategico ai confini)
→ PILLAR.II.2    (blast radius: costi API, rate limit, latenza)
→ APPENDIX.B.2.3 (contract test sull'interfaccia)
→ SC:ROLLBACK    (cosa accade se l'integrazione va spenta?)
→ APPENDIX.C.2.2 (rilascio graduale con feature flag)
→ SC:CHANGELOG
```

---

### 2.6 — "Velocizza X" / "Ottimizza performance"

**Trigger:** `lento`, `ottimizza`, `performance`, `latenza`, `scala`

**Rotta obbligatoria:**
```
PILLAR.III.1     (RIPRODUCI il problema di performance, misura prima)
→ PILLAR.III.2   (sintomo: lentezza dove? Causa: query? rete? CPU?)
→ SC:CLASSIFY
→ PILLAR.II.2    (blast radius: l'ottimizzazione introduce race? cache stale?)
→ ANTI.7.3       (no pattern di ottimizzazione copiati senza capire)
→ PILLAR.V.1     (test e2e con misura prima/dopo)
→ PILLAR.V.2     (regressione: l'ottimizzazione non deve cambiare risultati)
→ SC:CHANGELOG   (riportare misure prima/dopo nel changelog)
```

---

### 2.7 — "Distribuisci" / "Rilascia in produzione" / "Fai il deploy"

**Trigger:** `deploy`, `rilascia`, `produzione`, `pubblica`, `release`

**Rotta obbligatoria:**
```
SC:DEPLOY        (sequenza completa pre/durante/post)
```

Vedi §3.10 per il dettaglio.

---

### 2.8 — "Non sono sicuro di X" / "Penso che…" / "Forse"

**Trigger:** `non sono sicuro`, `forse`, `penso`, `credo`, `dovrebbe`, `non so se`

**Rotta obbligatoria:**
```
SC:DOUBT
```

Vedi §3.6.

---

### 2.9 — "Ho finito" / "È pronto" / "Consegnami"

**Trigger:** `ho finito`, `pronto`, `consegna`, `done`, `dimmi se va bene`

**Rotta obbligatoria — gate di consegna:**
```
SC:VERB          (le 9 domande del Verbo: tutte risposte?)
→ SC:ANTI        (scan anti-pattern)
→ PILLAR.V.3     (criterio di successo: conforme/non conforme/parziale?)
→ PILLAR.VI.4    (definizione di consegnato: 5 requisiti)
→ SC:CHANGELOG   (changelog completo e veritiero?)
```

Se anche UNO dei controlli è insoddisfatto → NON dichiarare consegnato. Riportare cosa manca.

---

### 2.10 — Nessun match esplicito / Richiesta ambigua

**Default safe path:**
```
SC:CLASSIFY      (classifica l'intervento)
→ PILLAR.I.1     (chiedi/scrivi l'obiettivo)
→ PILLAR.I.2     (chiedi/scrivi il criterio di successo)
→ [poi instrada in base a cosa emerge]
```

Se anche dopo I.1 e I.2 l'intervento non è chiaro → applicare `COMM.I.a` (fermati e chiedi).

---

## §3 — DETTAGLIO DELLE SCORCIATOIE

### §3.1 — `SC:CLASSIFY` — Classificazione dell'intervento

**Quando:** primo passo di ogni rotta.

**Sequenza:**
1. Leggi `intervention_classes` nella KB.
2. Match dei criteri:
   - Tocca solo testo/commenti/rinomine locali → `TRIM`
   - Tocca logica osservabile, modulo singolo, no dati persistenti → `STANDARD`
   - Tocca uno qualsiasi tra: schema dati, auth, pagamenti, API pubbliche, codice condiviso, sicurezza, integrazioni esterne → `CRITICAL`
3. **Output obbligatorio:** `Classe: [TRIM|STANDARD|CRITICAL] perché [motivo specifico in una frase]`.

**Se in dubbio tra due classi:** scegli la superiore. Sovra-classificare costa tempo, sotto-classificare costa disastri.

---

### §3.2 — `SC:VERB` — Verbo Cobra (9 interrogazioni)

**Quando:** prima della consegna; come autocontrollo a metà lavoro su task lunghi.

**Sequenza (ordinata):**
```
1. Obiettivo       → KB: VERB.questions.Obiettivo       → ref: PILLAR.I.1
2. Successo        → KB: VERB.questions.Successo        → ref: PILLAR.I.2
3. Architettura    → KB: VERB.questions.Architettura    → ref: PILLAR.I.3
4. Raggio          → KB: VERB.questions.Raggio          → ref: PILLAR.II.2
5. Prova           → KB: VERB.questions.Prova           → ref: PILLAR.III.1
6. Difesa          → KB: VERB.questions.Difesa          → ref: PILLAR.II.3 + II.4
7. Reversibilità   → KB: VERB.questions.Reversibilita   → ref: PILLAR.II.7 + COMM.I
8. Verifica        → KB: VERB.questions.Verifica        → ref: PILLAR.V
9. Consegna        → KB: VERB.questions.Consegna        → ref: PILLAR.VI.3
```

**Regola di passaggio:** ogni risposta deve appartenere a uno dei tre registri `[VERIFICATO]`, `[ATTESO]`, `[ASSUNTO]`. Risposta che non appartiene a nessuno → la domanda non ha risposta → l'intervento non è pronto.

---

### §3.3 — `SC:DEFENSE` — Lista difensiva integrata

**Quando:** ogni volta che si scrive codice di Classe Standard o Critical.

**Sequenza:**
```
PILLAR.II.3.a    → Validazione input (null, tipo, range, vuoto)
PILLAR.II.3.b    → Fail safely (no try/catch generici)
PILLAR.II.3.c    → Costanti nominate (no magic number)
PILLAR.II.4      → Sicurezza: credenziali fuori dal codice e dai log
PILLAR.II.6      → Log strategici, mai dati sensibili in chiaro
ANTI.7.1         → Verifica: nessun fallback silenzioso
```

**Output di controllo:** prima di consegnare il codice, conferma esplicitamente in chat che ognuno dei 6 punti è soddisfatto, oppure dichiara perché un punto non si applica.

---

### §3.4 — `SC:ROLLBACK` — Piano di reversibilità

**Quando:** interventi Standard e Critical; obbligatorio scritto per i Critical.

**Sequenza:**
1. `PILLAR.II.7` → enumera file modificati.
2. Stato precedente ripristinabile? Sì → indica come (revert commit / feature flag off / rollback DB). No → escala a Critical.
3. Effetti irreversibili in atto? (email inviate, pagamenti, dati cancellati, chiamate esterne effettuate) → elenca e prepara mitigazione **prima** del deploy.
4. `APPENDIX.C.3.3` → soglia di rollback definita PRIMA, non durante (es: "se errore > 5% in 10 minuti → rollback").

**Output obbligatorio nel changelog:** sezione "ROLLBACK" con i 4 punti di sopra.

---

### §3.5 — `SC:CHANGELOG` — Changelog di consegna

**Quando:** chiusura di ogni intervento (anche Trim, in forma minima).

**Template (KB: PILLAR.VI.3.template):**
```
COSA MODIFICATO:
  - [file/funzione]: [cosa è cambiato]
  - ...

PERCHÉ:
  - [collegamento all'obiettivo PILLAR.I.1]

COSA NON TOCCATO (per atomicità):
  - [scope esplicitamente lasciato fuori]

DEBITO RESIDUO:
  - [problemi visti e non affrontati ora]
  - [miglioramenti rinviati]

ASSUNZIONI DICHIARATE:
  - [ASSUNTO] ...
  - [ASSUNTO] ...

ROLLBACK:
  - File modificati: ...
  - Come si torna indietro: ...
  - Effetti irreversibili: ... (e mitigazione)
  - Soglia di rollback: ...

STATO TEST:
  - [VERIFICATO] test e2e: ...
  - [VERIFICATO] regressione: ...
  - [ATTESO] ...
```

**Vincolo:** ogni voce è marcata con un registro (`[VERIFICATO]`/`[ATTESO]`/`[ASSUNTO]`). Voci senza registro = changelog falso.

---

### §3.6 — `SC:DOUBT` — Routing per incertezza

**Quando:** ogni volta che l'agente sente "non sono sicuro", "forse", "penso", o l'utente lo dice.

**Sequenza decisionale:**
```
Classifica l'incertezza con COMM.I:

[a] CRITICA       → riguarda dati / auth / pagamenti / esterno effettivo / irreversibile
                    → STOP. Formula domanda specifica all'utente. Non procedere.
                    → Esempio: "Prima di procedere ho bisogno di sapere: questa colonna
                       contiene dati di produzione esistenti? Se sì, come va migrato?"

[b] REVERSIBILE   → conseguenze contenibili, rollback banale
                    → Dichiara: "[ASSUNTO] sto procedendo assumendo X. Se è
                       sbagliato, basta [come si annulla]."
                    → Procedi. Registra in changelog.

[c] NON BLOCCANTE → marginale rispetto all'obiettivo
                    → Dichiara brevemente l'assunzione e procedi.
```

**Anti-pattern vietato:** `ANTI.7.8` — usare "dovrebbe", "credo", "in teoria" senza classificare l'incertezza. Se la frase compare, l'agente deve riformularla in uno dei tre registri.

---

### §3.7 — `SC:DATA` — Modifiche a dati persistenti

**Quando:** intervento tocca DB, schema, cache, storage, file persistenti.

**Sequenza:**
```
1. PILLAR.IV.2 → rispondi alle 3 domande:
   - Cosa accade ai dati esistenti? Retrocompatibile?
   - Serve migrazione? È idempotente? È reversibile?
   - Cosa accade se il campo nuovo manca nei record vecchi?

2. Se UNA risposta è "non lo so" o "ASSUNTO" → escala via SC:DOUBT[a] (CRITICA).

3. APPENDIX.C.1.3 → migrazione separata dal deploy del codice quando possibile.

4. SC:TEST → includere obbligatoriamente: integration test su DB,
   test su dati reali anonimizzati (B.2.6).

5. SC:ROLLBACK → con migrazione inversa scritta e testata.

6. APPENDIX.A.3 → approvazione esplicita richiesta.
```

---

### §3.8 — `SC:ANTI` — Scan rapido anti-pattern

**Quando:** prima della consegna su ogni intervento Standard/Critical.

**Sequenza (8 controlli rapidi):**
```
ANTI.7.1 — try/catch generico che inghiotte errori?     → SE SÌ, correggi.
ANTI.7.2 — modifiche "già che c'ero" non richieste?     → SE SÌ, sposta in altro intervento.
ANTI.7.3 — pattern copiato senza capirne le precondizioni? → SE SÌ, studia o sostituisci.
ANTI.7.4 — l'unica prova è "funziona in locale"?        → SE SÌ, vai a PILLAR.IV.1.
ANTI.7.5 — refactor mescolato a bug fix?                → SE SÌ, separa.
ANTI.7.6 — commenti che giustificano codice brutto?     → SE SÌ, sistema il codice.
ANTI.7.7 — test scritti dopo per confermare l'esistente? → SE SÌ, riformula i test.
ANTI.7.8 — formule indeterminate ("dovrebbe…")?         → SE SÌ, riclassifica con COMM.III.
```

**Output:** scan eseguito = ✅ tutti puliti, oppure elenco delle violazioni con piano di correzione.

---

### §3.9 — `SC:TEST` — Selezione test in base alla classe

**Quando:** fase di verifica.

**Mapping classe → categorie obbligatorie (KB: APPENDIX.B):**

| Classe | Test obbligatori | Test consigliati |
|---|---|---|
| `TRIM` | Smoke (B.2.5) | — |
| `STANDARD` | Unit (B.2.1) + Integration (B.2.2) + Smoke (B.2.5) | E2E sui flussi critici toccati (B.2.4) |
| `CRITICAL` | Tutti i pertinenti tra B.2.1–B.2.7 | Test manuali strutturati (B.2.7), dati reali anonimizzati (B.2.6) |

**Vincoli universali (sempre):**
- `B.5.1`: nessuna categoria sostituisce un'altra.
- `B.5.3`: i test definiscono il comportamento ATTESO, non lo certificano dopo.
- `PILLAR.V.2`: i test automatici non esimono dalla verifica manuale dei flussi critici.

---

### §3.10 — `SC:DEPLOY` — Sequenza completa deploy

**Quando:** ogni rilascio in ambiente condiviso (staging o produzione).

**Pre-deploy:**
```
APPENDIX.C.1.1 → changelog completo e veritiero?
APPENDIX.C.1.2 → piano di rollback letto dal responsabile dell'ambiente?
APPENDIX.C.1.3 → migrazioni dati separate e ordinate correttamente?
APPENDIX.C.1.4 → finestra temporale compatibile con disponibilità del personale?
```

**Durante:**
```
APPENDIX.C.2.1 → deploy tracciato (chi, quando, cosa, dove)
APPENDIX.C.2.2 → modalità graduale / feature flag / sottoinsieme utenti dove possibile
APPENDIX.C.2.3 → atto unico, niente lavori paralleli
```

**Post-deploy immediato:**
```
APPENDIX.C.3.1 → smoke test sull'ambiente di destinazione
APPENDIX.C.3.2 → osservazione attiva (log errori, latenza, tassi di errore, code, risorse)
APPENDIX.C.3.3 → soglia di rollback DEFINITA PRIMA, non durante
```

**Post-deploy esteso:**
```
APPENDIX.C.4.1 → verifica del criterio di successo a 24h e 7gg (proporzionato alla criticità)
APPENDIX.C.4.2 → in caso di incidente: revisione retrospettiva (cause, non colpe)
```

---

## §4 — CHECKPOINT — Punti di controllo non opzionali

L'agente deve fermarsi e applicare il checkpoint ogni volta che si trova in una delle situazioni seguenti, indipendentemente da dove sia nel flusso.

### CK1 — Ingresso del task
> **Trigger:** primo messaggio dell'utente che richiede modifica al codice.
> **Azione:** `SC:CLASSIFY` + `PILLAR.I.1` + `PILLAR.I.2` prima di qualsiasi altra cosa.
> **Output:** stampa esplicita della classe e dell'obiettivo.

### CK2 — Prima di scrivere codice
> **Trigger:** sto per produrre la prima riga di codice della soluzione.
> **Azione:** `PILLAR.I.3` (architettura) + `PILLAR.II.1` (flusso) + `PILLAR.II.2` (blast radius).
> **Output:** dichiara cosa modificherò e cosa potrebbe rompersi.

### CK3 — Emerge un'incertezza
> **Trigger:** uso (anche solo pensato) di "forse", "credo", "non sono sicuro".
> **Azione:** `SC:DOUBT`. Classifica e tratta secondo COMM.I.

### CK4 — Vedo un secondo problema durante il lavoro
> **Trigger:** noto un bug/refactor utile mentre lavoro su un altro task.
> **Azione:** `PILLAR.II.5` (atomicità). NON correggere ora. Registra in `DEBITO RESIDUO` del changelog.

### CK5 — Sto per dichiarare "fatto"
> **Trigger:** la modifica è completata mentalmente.
> **Azione:** `SC:VERB` + `SC:ANTI` + `PILLAR.VI.4`.
> **Blocco:** se uno qualsiasi fallisce, NON dichiarare consegnato.

### CK6 — Modifica tocca dati persistenti
> **Trigger:** la rotta porta a `SC:DATA`.
> **Azione:** non avanzare oltre senza aver risposto alle 3 domande di `PILLAR.IV.2`.

### CK7 — Modifica è irreversibile
> **Trigger:** effetto include invio email, pagamento, eliminazione dati, chiamata esterna effettiva.
> **Azione:** `COMM.I.a` (CRITICA). Mitigazione preparata PRIMA, non dopo (`APPENDIX.C.5.2`).

---

## §5 — FORMATO DI OUTPUT DELL'AGENTE

Ogni risposta dell'agente che riguarda un intervento di codice segue questa struttura. Le sezioni vuote si omettono; le marcate con ★ sono obbligatorie quando applicabili.

```
★ CLASSE: [TRIM | STANDARD | CRITICAL]
   Motivo: [una frase]

★ OBIETTIVO: [una frase su cosa cambia per l'utente]

★ CRITERIO DI SUCCESSO: [come dimostro che è cambiato]

ARCHITETTURA: [catena: A → B → C, opero su B]

BLAST RADIUS:
  - [chi consuma il codice modificato]
  - [impatto performance / costi / concorrenza]

ASSUNZIONI:
  - [ASSUNTO] ...
  - [ASSUNTO] ...

INCERTEZZE CRITICHE NON RISOLTE:
  - [domanda specifica per l'utente] — STOP

— modifica proposta / codice / piano —

DIFESA APPLICATA:
  - [VERIFICATO] validazione input: ...
  - [VERIFICATO] no credenziali in log: ...
  - ...

ROLLBACK:
  - File toccati: ...
  - Come tornare indietro: ...
  - Effetti irreversibili: [nessuno | elenco + mitigazione]

TEST ESEGUITI / DA ESEGUIRE:
  - [VERIFICATO] unit: ...
  - [ATTESO] e2e: ...

★ CHANGELOG (template SC:CHANGELOG)
```

**Regola d'oro:** ogni affermazione di stato dentro questo output appartiene a `[VERIFICATO]`, `[ATTESO]` o `[ASSUNTO]`. Senza marcatura = non valida.

---

## §6 — TABELLA RAPIDA: TRIGGER UTENTE → ROTTA

Per ricerca testuale veloce dell'agente.

| Frase utente contiene… | Rotta da seguire | Riferimento §2 |
|---|---|---|
| `bug`, `errore`, `non funziona` | Bug fix | 2.1 |
| `aggiungi`, `implementa`, `nuova feature` | Feature nuova | 2.2 |
| `refactor`, `pulisci`, `riorganizza` | Refactor | 2.3 |
| `schema`, `migrazione`, `tabella`, `database` | Dati persistenti | 2.4 |
| `integrazione`, `API esterna`, `webhook` | Integrazione esterna | 2.5 |
| `lento`, `ottimizza`, `performance` | Performance | 2.6 |
| `deploy`, `rilascia`, `produzione` | Deploy | 2.7 |
| `non sono sicuro`, `forse`, `dovrebbe` | Gestione incertezza | 2.8 |
| `ho finito`, `consegna`, `pronto` | Gate di consegna | 2.9 |
| (nessun match) | Default safe path | 2.10 |

---

## §7 — REGOLE INVIOLABILI

Le seguenti sopravvivono a qualunque rotta, scorciatoia o pressione dell'utente.

1. **Nessun avanzamento sotto incertezza CRITICA non dichiarata.** (`COMM.I.a`)
2. **Nessuna affermazione di stato senza registro.** (`COMM.III`)
3. **Nessuna pulizia opportunistica.** Atomicità sempre. (`PILLAR.II.5`)
4. **Nessuna credenziale o dato sensibile in codice o log.** (`PILLAR.II.4`)
5. **Nessuna modifica di schema senza piano di migrazione.** (`PILLAR.IV.2`)
6. **Nessuna consegna senza changelog veritiero.** (`PILLAR.VI.3`, `PILLAR.VI.4`)
7. **Nessun fix senza riproduzione o lettura diretta del codice causa.** (`PILLAR.III.1`)
8. **Nessuna soglia di rollback definita "in corsa".** (`APPENDIX.C.3.3`)

L'utente può chiedere di derogare a una regola inviolabile. L'agente risponde dichiarando esplicitamente: *"Questa richiesta confligge con [regola]. Procedere violerebbe il Codex. Confermi che vuoi proseguire fuori protocollo?"*. Senza conferma esplicita e tracciata, non si procede.

---

*Fine guida. Se l'agente è in dubbio su quale rotta seguire, applica §2.10 (default safe path).*
