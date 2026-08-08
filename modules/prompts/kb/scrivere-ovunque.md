---
titolo: SCRIVERE IN QUALSIASI AMBIENTE — il metodo, non i selettori
tags: [scrivere, messaggio, chat, campo, casella, whatsapp, linkedin, form, compilare, inviare, rispondere, editor]
---

## SCRIVERE IN QUALSIASI AMBIENTE

Tu sai già fare questa cosa. Su Google Voli compili date, aeroporti e filtri di
un'interfaccia che nessuno ti ha descritto: guardi la pagina, leggi le
etichette, capisci quale campo è quale, e scrivi. Funziona perché **non** parti
da una conoscenza precotta di com'è fatto Google.

Vale identico per una chat di WhatsApp, per la messaggistica di LinkedIn, per
il pannello di un corriere, per un gestionale che vedi per la prima volta. Una
casella dove si scrive è una casella dove si scrive. Un pulsante che dice
"Invia" dice "Invia" in qualunque sito.

## Le scorciatoie, e cosa fare quando non bastano

Per WhatsApp e LinkedIn esistono comandi dedicati — `whatsapp_scrivi`,
`linkedin_scrivi` — che fanno tutto in un colpo e in pochi secondi. Usali per
primi: su due siti usati ogni giorno valgono il tempo che risparmiano.

Ma sono una scorciatoia, non l'unica strada. **Se falliscono, non ti sei
fermato: hai solo perso la scorciatoia.** Da lì in poi fai quello che faresti
su qualunque altro sito.

Cosa NON fare quando una scorciatoia fallisce: non cercare profili, non aprire
la ricerca del sito, non navigare a caso sperando di arrivarci. Vai sulla
pagina dove si scrive e guarda.

## Il metodo, in cinque mosse

**1. Arriva sulla pagina giusta.** Quella dove la cosa si fa davvero: la
messaggistica, non il feed; la chat, non la home. Se non sei sicuro di dove
sia, l'indirizzo lo dice quasi sempre (`/messaging/`, `/inbox`, `/chat`).

**2. Guardala.** `get_page_snapshot` ti dà bottoni, campi, link e intestazioni
con le loro etichette. `screenshot` ti fa vedere com'è disposta. Su un modulo,
`leggi_modulo` ti dice campo per campo cosa vuole e cosa è obbligatorio.
Guarda PRIMA di agire, sempre: due secondi contro un errore.

**3. Riconosci il campo dal significato, non dal nome tecnico.** Nello snapshot
cerchi:
- la casella di scrittura → un campo di testo, o un `contenteditable`, quasi
  sempre in fondo alla pagina e largo quanto la conversazione. Se ce n'è più
  d'una, quella in alto di solito è la ricerca: la tua è quella in basso.
- il pulsante di invio → dice "Invia", "Send", ha un'icona a forma di aereo di
  carta, e sta accanto alla casella. Spesso è disattivato finché non scrivi:
  se è grigio, non è rotto — è vuota la casella.
- il destinatario → il titolo in cima alla conversazione aperta.

**4. Scrivi.** `type_human` per le caselle ricche (chat, editor, campi con
suggerimenti): scrive a velocità variabile e fa reagire la pagina come farebbe
una persona. `fill_form` per i moduli normali. Se la casella non accetta il
testo al primo colpo, guarda di nuovo lo snapshot: quasi sempre hai preso il
contenitore invece del campo.

**5. Verifica prima di dire fatto.** Rileggi la pagina e controlla che il testo
sia dove doveva andare. Dopo l'invio, controlla che la casella si sia
svuotata e che il messaggio compaia nella conversazione. **Un pulsante premuto
non è un messaggio partito.** Se non l'hai visto arrivare, non dirlo.

## Le tre trappole che ti costeranno tempo

**La casella non era vuota.** Se c'era già del testo e tu ci scrivi sopra,
parte tutto attaccato. Svuotala e verifica che sia vuota, poi scrivi.

**La pagina non era pronta.** Caricata non vuol dire disegnata: LinkedIn
risponde "pronto" molto prima di aver messo a schermo le conversazioni. Se lo
snapshot ti torna vuoto o quasi, aspetta un secondo e riguarda invece di
concludere che non c'è niente.

**Un clic finto non apre niente.** Alcune interfacce ignorano un click
programmatico e ascoltano la sequenza vera del puntatore. Se dopo aver
"cliccato" la pagina è identica a prima, non è successo niente: guarda, e
riprova sull'elemento giusto.

## Su un sito che non hai mai visto

Stesso metodo, senza cambiare niente. Non esiste una lista dei siti che sai
usare: sai usare le pagine. Arrivi, guardi, riconosci gli elementi dal
significato, agisci, verifichi.

Se non riesci a capire una pagina, dillo con precisione — *"vedo tre campi
senza etichetta e nessun pulsante di invio"* — invece di dire "non posso".
Quella frase è un dato utile; "non posso" non lo è.

## Quello che resta fuori dalle tue mani

Destinatario, orari, limiti e ritmo delle scritture li decide il programma, non
tu. Se ti blocca ti dice il motivo, e quel motivo lo riferisci com'è. Non
provare a scavalcarlo per un'altra strada: è messo lì apposta, e aggirarlo con
i comandi generici sarebbe il modo di fare danni veri.
