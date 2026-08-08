---
titolo: COME SI CERCA
tags: [ricerca, fonti, url, motore, google, dove cercare]
---

## COME SI CERCA

0. RICOGNIZIONE — dominio nuovo (legale, medico, doganale...)?
   Prima mossa: google_search("migliori fonti per X"). Scegli le 2-3 migliori,
   POI lavora. Quello che scopri resta scritto nel registro.
   Fonte vuota su un dato CENTRALE → cerca un'altra fonte.
   Fonte vuota su un dato accessorio → puoi accontentarti e proseguire,
   dichiarandolo nel report. Mai riprovare all'infinito la stessa fonte vuota.

1. La fonte si giudica da ciò che risponde, non dalla fama.
2. Tre esiti, mai confusi:
   - Risponde coi dati → prendili.
   - Risponde "0 risultati" → la fonte HA risposto: cambia fonte o parametri.
     Non è un tuo errore di lettura e NON autorizza a stimare.
   - Non rende i dati (vuota/anti-bot) → screenshot + read_page, poi altra fonte.
3. Più entità richieste = una ricerca CIASCUNA. Mai attribuire i risultati di
   una a un'altra: il codice rifiuta i blocchi duplicati.
4. Letture indipendenti (più tratte, più aziende) → batch_scrape con tutti gli
   URL in una chiamata. navigate() quando serve la sessione del browser o una
   lettura decide la successiva.
5. Copia i valori come stanno sulla pagina. Campo mancante = dichiarato.
6. Ogni blocco di dati porta la sua fonte. google_search TROVA la pagina,
   navigate/read_page PRENDE il dato.
7. I FORM sui siti esterni sono BLOCCATI: non provare a compilarli.
   La ricerca si fa costruendo l'URL DEI RISULTATI con i parametri dentro
   (date, tratta, città) e aprendolo con navigate().
8. MAI la homepage di un sito: porta risultati a caso (Trivago aperto sulla
   homepage ha risposto Palermo a una ricerca su Tokyo). Sempre l'URL dei
   risultati già costruito; se non conosci il formato, resta su Google.

## Punti di partenza collaudati
Il registro FONTI in fondo al prompt (quando c'è) è misurato: prevale su tutto.
- Voli: google.com/travel/flights?q=Flights to DEST from ORIG on AAAA-MM-GG through AAAA-MM-GG&curr=EUR&hl=it — codici AEROPORTO (MXP, non MIL)
- Hotel: booking.com · google.com/travel/search
- Aziende: sito ufficiale → registri di settore → LinkedIn
Se dopo navigate+read_page il dato non c'è: di' cosa hai aperto e proponi
un'alternativa. Vale uguale per hotel, treni, listini, tracking.
