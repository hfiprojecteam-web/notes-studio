# Notes Studio

Strumento personale per Substack Notes: coda e pubblicazione programmata, generatore nella tua voce, statistiche, risposte in sospeso e feed dei creator seguiti.

Gira su Cloudflare Workers con un database D1. Un cron ogni minuto pubblica le Notes in scadenza; ogni 30 minuti aggiorna metriche, feed e risposte.

## Avvertenze

- Substack non ha API ufficiali per le Notes. L'app usa gli endpoint interni del sito: possono cambiare senza preavviso.
- La pubblicazione usa il tuo cookie di sessione `substack.sid`, salvato cifrato nel database. Chi lo possiede può agire come te: usa una `SECRET_KEY` lunga e casuale.
- Una pubblicazione fallita non viene ritentata in automatico, per non rischiare doppioni. La Note passa in "Da controllare".

## Installazione

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler d1 create notes-studio
```

Copia il `database_id` restituito dentro `wrangler.jsonc`, poi crea le tabelle:

```bash
npx wrangler d1 execute notes-studio --remote --file=schema.sql
```

Imposta i segreti (uno alla volta, il valore viene chiesto a terminale):

```bash
npx wrangler secret put APP_PASSWORD
```

```bash
npx wrangler secret put SECRET_KEY
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Pubblica:

```bash
npx wrangler deploy
```

## Primo avvio

1. Apri l'URL del Worker ed entra con `APP_PASSWORD`.
2. In **Impostazioni** inserisci handle, cookie `substack.sid`, fuso orario e slot orari.
3. Premi **Verifica collegamento**: tutte le righe devono essere verdi.
4. In **Statistiche** premi **Importa storico**: le tue Notes diventano anche il riferimento di voce per il generatore.
5. Prova con una sola Note e **Pubblica ora** prima di affidarti alla coda.

## Sviluppo locale

Crea `.dev.vars` con `APP_PASSWORD` e `SECRET_KEY`, poi:

```bash
npx wrangler d1 execute notes-studio --local --file=schema.sql
```

```bash
npx wrangler dev --test-scheduled
```

## Struttura

- `src/substack.ts` — client degli endpoint Substack
- `src/jobs.ts` — pubblicazione e sincronizzazione
- `src/generate.ts` — generatore (Claude)
- `src/index.ts` — API e cron
- `public/index.html` — interfaccia

## Controlli

```bash
npm test
```

Prova le parti che non devono rompersi: orari e fusi (compreso il cambio d'ora), slot liberi, regola di riscrittura degli spunti, formato del testo inviato a Substack.

```bash
npm run check
```

Controlla i tipi di tutto il codice.

`tools/i18n-audit.js` apre ogni schermata in inglese su un'istanza locale e scrive le stringhe rimaste in italiano. Serve un Substack simulato in ascolto (vedi `SUBSTACK_API_BASE` in `.dev.vars`).

Gli errori imprevisti del server finiscono tra gli avvisi dell'app, uno per errore distinto all'ora.
