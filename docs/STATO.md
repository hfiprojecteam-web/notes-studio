# Notes Studio: stato del progetto

Aggiornato l'11 novembre 2026. Serve a chi riprende il lavoro in una sessione nuova.

## Cos'è

Strumento personale di Cipriano per Substack Notes, nato studiando WriteStack. Un solo utente, nessun account, nessun pagamento. Gira su Cloudflare Workers con database D1, all'indirizzo https://notes-studio.hfiprojecteam.workers.dev. Codice in questo repository.

È lo strumento "B" rispetto alla skill `substack-business`: dichiaratamente fuori dal suo perimetro, perché accede all'account, legge profili di terzi e può pubblicare. La skill resta la regia delle decisioni; questo è un banco di lavoro.

## Cosa fa oggi

| Sezione | Cosa fa |
|---|---|
| Oggi | Cosa fare adesso, prossime uscite, lista dei primi passi |
| Studio | Scrittura, bozze, calendario settimanale, pubblica ora, data e ora libere, orari ricorrenti |
| Genera, Voce | Claude propone tracce o bozze; profilo di voce strutturato. Nulla esce senza approvazione |
| Statistiche | Interazioni, iscritti e clic portati da ogni Note, fonti di iscrizione, andamento giornaliero |
| Attività | Risposte in attesa, con risposta suggerita |
| Persone | Lato iscritti (cerchia, suggeriti, scheda, registro contatti) e lato creator (radar, massimo 10) |
| Feed, Materiali | Notes dei creator osservati, ispirazioni; documenti di ricerca in sola lettura |
| Impostazioni | Collegamento, pianificazione, avvisi, connettore MCP per Claude, otto lingue |

## Cosa è verificato sul vero Substack

- Lettura di profili, Notes, risposte, articoli.
- Pubblicazione immediata di una Note (11/11/2026, una Note di un paragrafo).
- Statistiche per singola Note e fonti di iscrizione.
- Connettore MCP usato davvero da una sessione Claude.

## Cosa non è verificato

- Pubblicazione programmata dal timer dell'app.
- Programmazione nativa di Substack (costruita leggendo il codice pubblico del sito, spenta di default).
- Note con più paragrafi, link o immagini.
- Tutte le funzioni che chiamano Claude: mai eseguite con una chiave reale.
- Avviso di cookie scaduto; invio degli avvisi verso ntfy o Make.

## Problemi noti

- Il cookie di sessione Substack sta sul server (cifrato). Chi lo ottiene entra nell'account.
- Si usano interfacce non ufficiali di Substack: possono cambiare o essere contestate.
- Nessun limite ai tentativi di login sulla password dell'app.
- Nessun tetto di spesa sulle chiamate a Claude.
- Dati personali di terzi salvati (nomi, bio, abbonamenti pubblici, testi delle risposte).
- Nessuna esportazione o copia di sicurezza dei dati.
- Nessun test sull'interfaccia né sulle chiamate a Substack; otto test sulle funzioni di base.
- Interfaccia in un unico file; traduzioni applicate sopra la pagina, con un controllo automatico (`tools/i18n-audit.js`).
- Solo testo nelle Notes: niente immagini, anteprima, annulla. Calendario di sette giorni. Niente trascinamento su telefono.
- Il profilo di voce di Cipriano è vuoto.

## Decisioni prese da Cipriano

- Scrittura assistita, non automatica: Claude propone, lui approva o riscrive.
- Contenuti di terzi letti una volta al giorno, a orario casuale; massimo 10 creator osservati.
- Iscritti: nessuna importazione di elenchi o email. Solo chi interagisce pubblicamente, più aggiunte a mano.
- Messaggi alle persone sempre inviati a mano da lui.
- Integrazione con gli assistenti tramite connettore, non con un secondo fornitore di API.

## Aperto

- Ricerca sul compratore tipo (vedi `docs/prompt-ricerca-buyer-persona.md`).
- Funzione per articoli lunghi o altri tipi di contenuto: da decidere dopo la ricerca.
- Passaggio da strumento personale a prodotto: richiederebbe account, accesso OAuth, niente cookie sul server.
