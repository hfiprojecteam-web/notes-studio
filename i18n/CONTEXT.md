# Notes Studio: translation brief

Notes Studio is a private web app for one writer who publishes on Substack. Screens: Studio (write and schedule Substack Notes on a weekly calendar), Generate (Claude proposes writing prompts), Voice (the writer's style profile), Materials (research documents), Statistics, Activity (replies waiting for an answer), People (two sides: the writer's subscribers, and other creators the writer studies), Feed, Settings.

`i18n/keys.json` lists every Italian source string. Each language file `i18n/<lang>.json` maps each Italian string (the key, character for character) to its translation.

## What a good translation is here
- Adapted, not literal. Write what a well-made app in that language would say on that button, label or message. Rephrase freely; keep the meaning and the length class (buttons stay short).
- Consistent terminology across the whole file: pick one word per concept (draft, queue, slot, circle, label/tag, subscriber, follower, connector) and use it everywhere.
- Grammatical number must be right for the place the string appears:
  - GROUP labels (tabs, filters, section names, navigation) are PLURAL when they name a set of things or people. In particular these keys are group labels: "Creator" (the side of the People screen listing many creators: English "Creators"), "Iscritti" (Subscribers), "Persone", "Suggeriti", "Tutti", "Bozze", "Materiali", "Ispirazioni", "Lettori", "Potenziali clienti", "Clienti", "Ambasciatori", "Imprenditori", "Competitor" (group: "Competitors"), "Coopetitor" (group: "Coopetitors"), "Affini" (kindred creators), "Creator seguiti".
  - Lowercase single words "lettore", "potenziale cliente", "cliente", "ambasciatore", "imprenditore", "competitor", "coopetitor", "affine", "ispirazione" are a tag on ONE person: singular, lowercase.
- Never translate: Notes Studio, Substack, Note / Notes (the Substack feature: keep the English word, capitalised; choose "Note" or "Notes" by number), Claude, Cloudflare, restack, ANTHROPIC_API_KEY, APP_PASSWORD, SECRET_KEY, substack.sid, F12, HH:MM, URLs, @handles.
- Some keys are fragments of a sentence split around a dynamic value (they start or end with punctuation, a colon or a lowercase word). Translate them as fragments, keeping leading and trailing punctuation, so that the pieces still read correctly around the inserted value.
- No em dashes. One line per value. No exclamation marks unless the Italian has one.

## Numbers and plural forms
"#" in a key stands for a number inserted at runtime. Keep the same number of "#" in every form.
When the correct wording depends on the number (noun, verb or adjective agreement), give ALL plural forms of the language separated by " ||| " (space, three pipes, space), in the order of the language's CLDR plural categories:
- Italian, English, German, Spanish: one ||| other
- French, Brazilian Portuguese: one ||| other  (French and Portuguese treat 0 and 1 as "one")
- Hindi: one ||| other  (Hindi treats 0 and 1 as "one")
- Russian: one ||| few ||| many ||| other
The form is chosen from the FIRST "#" in the string. Example, key "# Notes programmate": English "# Note scheduled ||| # Notes scheduled"; Russian needs four forms.
If the wording does not change with the number (e.g. "#%", a time, a label before a colon), give a single form without separators.
Keys containing "#":
- # risposte
- .
          Le Notes programmate escono fino a # minuti dopo lo slot, mai al minuto esatto.
- Brevi (<#)
- Contenuti di altri (risposte, creator seguiti, profili): letti una volta al giorno, a un orario casuale tra le # e le #, con pause tra una richiesta e l'altra.
           Ultima lettura
- Da oggi l'app salva un'istantanea al giorno dei tuoi numeri (follower oggi: #, iscritti: #K+). Il grafico compare dal secondo giorno.
- Dom: media # su # Notes
- Fonti di crescita non disponibili (HTTP #)
- Gio: media # su # Notes
- Ha # follower
- Hai appena sincronizzato: riprova tra # minuti
- I creator sono stati letti da poco: riprova tra # minuti
- I testi campione superano i # caratteri complessivi: accorciali
- Il controllo si ripete da solo ogni #-# ore.
- Il cookie appartiene a un altro account (#)
- Importate # Notes
- Impossibile leggere il post (HTTP #)
- Lun: media # su # Notes
- Lunghe (>#)
- Mar: media # su # Notes
- Massimo # profili osservati
- Medie (#-#)
- Mer: media # su # Notes
- Paga già # newsletter
- Per esempio: sessione Substack, # novembre
- Risposte alle tue Notes degli ultimi # giorni ancora senza replica.
- Sab: media # su # Notes
- Scrivi # bozze mie da questo spunto
- Sincronizzate # Notes
- Su substack.com da loggato: F#, Application, Cookies, riga substack.sid. Viene salvato cifrato e non è più mostrato. Chi lo possiede può agire come te.
- Testo #
- Testo troppo lungo (massimo # caratteri)
- Ti ha risposto # volte
- Ultimi # giorni
- Una descrizione a parole di come scrivi. Puoi scriverla tu o farla proporre a Claude dai testi campione e dalle tue # Notes, poi correggerla.
- Ven: media # su # Notes
- brevi (#-# righe)
- e altre #
- in # giorni
- · #k caratteri

Some lowercase keys are shown right after a number that is in a separate element, so the app cannot pick a form for them: "follower", "iscritti", "Notes al giorno", "interazioni medie", "Notes con link", "caratteri in media", "ora più frequente", "articoli a settimana", "articoli riservati", "volte la sua media", "like", "restack", "risposte", "Notes". Use the plural (or the form that reads acceptably after any number) for these.
