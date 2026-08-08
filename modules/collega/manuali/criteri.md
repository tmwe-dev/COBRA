---
titolo: I criteri verificabili
tags: [criteri, incarico, verificabile, soggetti, campi]
---

## I CRITERI: LA PARTE CHE CONTA

Quando prepari un incarico, devi dire in anticipo quando sarà completo. Non a
parole vaghe: con criteri che il codice possa controllare da solo. Hai questi
tipi, e nessun altro:

- { "tipo": "soggetti_coperti", "soggetti": ["Milano","Madrid","Barcellona"] }
  Ogni soggetto va trattato per conto suo. Usalo SEMPRE quando la richiesta
  contiene più entità: è ciò che impedisce di ricopiare i risultati di una
  sotto il nome di un'altra.

- { "tipo": "elementi_minimi", "quanti": 3 }
  Quanti risultati distinti servono.

- { "tipo": "campi_obbligatori", "campi": ["prezzo","orario","compagnia"] }
  Cosa deve esserci per ogni elemento.

- { "tipo": "origine_verificabile" }
  Ogni numero deve comparire in una pagina davvero aperta.
  OBBLIGATORIO se il risultato conterrà prezzi, importi, tariffe, quantità,
  date di partenza o disponibilità. Su una richiesta di viaggio, di fornitori
  o di listini va messo SEMPRE: è l'unica cosa che impedisce di consegnare
  cifre plausibili e false.

- { "tipo": "file_atteso", "estensione": "html" }
  Per le consegne di ricerche e confronti l'estensione giusta è "html": è il
  report impaginato con la raccomandazione, che si salva in PDF. Chiedi "xlsx"
  SOLO se Luca ha nominato esplicitamente Excel o un foglio di calcolo.

- { "tipo": "nessun_duplicato" }
  Da mettere insieme a soggetti_coperti, per gli elenchi e le tabelle.

- { "tipo": "formato_consegna" }
  Il documento deve essere presentabile: intestazione, contenuto, e le fonti
  in calce. Mettilo SEMPRE insieme a file_atteso: un file che qualcuno dovra'
  leggere o girare al proprio capo non puo' essere una tabella nuda.

Non inventare tipi nuovi: quelli non riconosciuti vengono scartati e il
controllo che credevi di aver messo non esiste.

Metti solo criteri che servono davvero. Tre criteri giusti valgono più di sei
messi per scrupolo: ogni criterio inutile è un lavoro in più che chiedi.
