// Uno strumento e' andato bene, o no.
//
// C'era una riga sola, ripetuta uguale in tutti e tre i provider:
//
//     const ok = !rawResult.includes('"error"');
//
// L'8 agosto, auguri ad Andrea Anastasi: `linkedin_scrivi` ha rifiutato di
// scrivere — giustamente, non era sicuro del destinatario — e ha risposto
// {"ok":false,"serveConferma":true,...}. Dentro non c'e' la parola "error",
// quindi il monitor ha stampato "✅ linkedin_scrivi OK" su un messaggio mai
// partito. Nessun messaggio e' finito alla persona sbagliata; ma sullo schermo
// c'era scritto il contrario di quello che era successo.
//
// E non era solo un'etichetta: quello stesso `ok` azzera
// CobraSupervisor._failedToolCount. Uno strumento che falliva in questo modo
// non contava come fallimento, quindi il freno che ferma i giri a vuoto non
// scattava mai.
//
// Regola: si dichiara riuscito solo cio' che non si e' dichiarato fallito.
// In dubbio — testo libero, formati che non conosciamo — si resta su "si',
// riuscito", perche' la maggior parte degli strumenti risponde senza `ok` e
// non vogliamo trasformare il silenzio in un errore.

/**
 * @param {string} grezzo la risposta dello strumento, come stringa
 * @returns {boolean} falso solo se lo strumento ha dichiarato di non farcela
 */
function esitoRiuscito(grezzo) {
  const testo = typeof grezzo === 'string' ? grezzo : JSON.stringify(grezzo ?? '');
  if (!testo) return true;

  // La strada buona: e' JSON e lo dice da solo.
  try {
    const d = JSON.parse(testo);
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      if (d.ok === false) return false;
      if (d.ok === true) return true;
      if (d.error || d.errore) return false;
      if (d.bloccato === true || d.serveConferma === true) return false;
      // Intercettato in attesa del via libera: non e' ancora successo niente.
      // Contava come riuscito, e cosi' un invio BLOCCATO zittiva il Collega
      // come se il messaggio fosse partito.
      if (d.status === 'pending_confirmation') return false;
      return true;
    }
  } catch (_) { /* non e' JSON: si guarda il testo, come prima */ }

  return !testo.includes('"error"') && !testo.includes('"errore"');
}

module.exports = { esitoRiuscito };
