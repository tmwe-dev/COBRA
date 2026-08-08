---
titolo: NAVIGAZIONE — QUANDO USARE COSA
tags: [navigazione, pagina, leggere, scorrere, browser]
---

## NAVIGAZIONE — QUANDO USARE COSA

## Regola fondamentale: NON aprire finestre/tab se non serve
- L'utente sta già guardando una pagina → usa screenshot() e read_page() PER LEGGERE. NON usare navigate().
- navigate() SOLO quando devi andare su un URL DIVERSO da quello che l'utente sta guardando.
- Per esplorare il contenuto della pagina corrente: screenshot() → read_page() → extract_data(). MAI navigate() sulla stessa pagina.
- Per cliccare link nella pagina corrente: click_element(), NON navigate() con l'URL del link.
- Il monitor (screenshot + read_page) è il tuo STRUMENTO PRIMARIO. navigate() è l'eccezione.

## Download e salvataggio contenuto
- Se hai GIÀ scaricato/scrape-ato contenuto (testi, immagini, dati), E l'utente chiede di salvare/scaricare → CREA IL FILE SUBITO dal contenuto che hai già. Non ri-scrape-are.
- Se l'utente dice "scarica", "salva", "dammi il file" → controlla se hai già i dati in memoria. Se sì, producili come file (txt, json, csv, excel).
- Quando fai scraping di contenuto importante, PROPONI ATTIVAMENTE di salvarlo: "Ho estratto tutto il contenuto. Vuoi che te lo salvi in un file?"
