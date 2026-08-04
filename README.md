# COBRA v11

Segretaria virtuale AI per TMWE. Riceve una richiesta in linguaggio naturale,
decide se serve solo rispondere o agire, e nel secondo caso guida un browser
Chrome reale per cercare, leggere pagine e compilare moduli — con controlli di
sicurezza che intercettano le azioni irreversibili prima che avvengano.

## Avvio rapido

```bash
npm install          # unica dipendenza obbligatoria: ws
npm start            # http://127.0.0.1:3000
```

Serve un file `.env` nella radice:

```
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...        # opzionale, usato come riserva
GEMINI_API_KEY=...           # opzionale, usato come riserva
SUPABASE_URL=...             # opzionale, per la knowledge base
SUPABASE_ANON_KEY=...
```

Su macOS c'è anche `COBRA.app` sulla Scrivania: termina l'istanza precedente,
riavvia il server con il codice aggiornato e apre il browser.

## Estensione Chrome

Senza estensione COBRA può cercare e leggere, ma non pilotare il browser.
Per installarla: `chrome://extensions` → attiva "Modalità sviluppatore" →
"Carica estensione non pacchettizzata" → seleziona `cobra-extension/`.

L'indicatore in alto nell'interfaccia mostra `Extension: linked` quando il
collegamento è attivo.

## Come è fatto

```
richiesta utente
  └─ SuperMario            classifica l'intento, sceglie gli strumenti e il modello
      └─ prompt assemblato  personalità + regole KB + memoria + fatti appresi
          └─ provider AI    OpenAI, con Anthropic/Gemini/Groq come riserva
              └─ tool       62 strumenti, eseguiti tramite l'estensione Chrome
                  └─ guardie  rischio, whitelist domini, conferme, anti-loop
```

| Cartella | Contenuto |
|---|---|
| `modules/ai/` | Provider e router con cascata di riserve |
| `modules/tools/` | Definizioni dei 62 strumenti e loro esecutori |
| `modules/risk/` | Tassonomia del rischio, classificazione URL, conferme |
| `modules/security/` | SSRF, autenticazione, sanitizzazione, registro di audit |
| `modules/memory/` | Conversazioni, finestra scorrevole, fatti appresi |
| `modules/browser/` | Scraping, gestione pagine, cookie banner |
| `modules/ws/` | WebSocket e protocollo con l'estensione |
| `cobra-extension/` | Estensione Chrome (Manifest V3) |
| `public/` | Interfaccia web |

## Sicurezza

Le azioni non sono tutte uguali: leggere una pagina è diverso dal premere
"Paga ora". Ogni chiamata a uno strumento passa da un calcolo del rischio che
tiene conto dello strumento, dell'URL e dell'intento del click. Se il rischio
sale sopra la soglia, l'azione viene sospesa e mostrata all'utente per la
conferma, con un token valido una sola volta e per quegli esatti argomenti.

Altre difese attive:

- **SSRF**: risoluzione DNS prima della richiesta, così un dominio pubblico che
  punta alla rete interna viene bloccato. Redirect verificati singolarmente.
- **Whitelist domini**: gli strumenti che interagiscono con la pagina sono
  bloccati fuori dai domini autorizzati.
- **Prompt injection**: il contenuto scaricato dal web viene analizzato e
  delimitato prima di entrare nel contesto del modello.
- **Registro di audit**: ogni chiamata è registrata con una catena di hash;
  alterazioni e rimozioni sono rilevabili da `/api/monitoring/audit-integrity`.
- **Supervisore**: interrompe i cicli di scroll, i click alla cieca e le
  sequenze ripetute prima che diventino loop infiniti.

## Memoria

Tre livelli distinti:

- **Finestra scorrevole** — gli ultimi messaggi, per intero.
- **Riassunto** — i turni più vecchi, condensati.
- **Fatti appresi** — ciò che resta vero fra una sessione e l'altra: ruolo,
  azienda, clienti ricorrenti, preferenze. Vengono estratti da soli dalle
  conversazioni e richiamati quando pertinenti.

L'apprendimento avviene **solo dai messaggi dell'utente**, mai dal contenuto
delle pagine web: altrimenti una pagina malevola potrebbe iscrivere istruzioni
permanenti nella memoria. Le credenziali vengono riconosciute e scartate.

Per ispezionare o correggere: `GET /api/learning/facts`, `POST /api/learning/forget`.

## Test

```bash
./run-tests.sh
```

706 asserzioni in 10 suite. Oltre alla regressione classica, tre suite coprono
le classi di difetto che in passato sono sfuggite alla lettura del codice:

| Suite | Cosa protegge |
|---|---|
| `check-ctx-methods.js` | Che ogni `ctx.X.metodo()` usato nel codice esista davvero |
| `check-bridge-protocol.js` | Il contratto fra server ed estensione, nomi dei campi inclusi |
| `test-ssrf.js` | I vettori di bypass noti, DNS rebinding compreso |

## Posta elettronica

La lettura funziona senza installare nulla: il client IMAP è scritto sul modulo
`tls` incluso in Node. Va configurata la casella una volta:

```bash
curl -X POST http://127.0.0.1:3000/api/config/email \
  -H 'Content-Type: application/json' \
  -d '{"imapHost":"imap.tuoprovider.it","imapUser":"tu@tuodominio.it","imapPass":"..."}'
```

Poi basta chiedere a COBRA "controlla la posta" o "leggi le ultime 5 email".
Restituisce mittente, oggetto, data e un'anteprima del testo, gestendo gli
oggetti codificati (`=?UTF-8?B?...?=`) e i corpi in HTML o base64.

Se sono già configurati i dati SMTP, l'host IMAP viene dedotto sostituendo
`smtp.` con `imap.`; se il provider usa un indirizzo diverso, va indicato
esplicitamente con `imapHost`.

Per **inviare** serve invece una dipendenza: `npm install nodemailer` e la
configurazione SMTP (`host`, `user`, `pass`) sullo stesso endpoint.

## Note operative

- **Puppeteer non è richiesto**: l'automazione passa dall'estensione Chrome.
  Se installato viene usato come alternativa.
- I file in `data/` contengono conversazioni e dati reali e sono esclusi dal
  repository.
