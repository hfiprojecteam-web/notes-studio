import it from "../i18n/it.json";
import en from "../i18n/en.json";
import de from "../i18n/de.json";
import es from "../i18n/es.json";
import ru from "../i18n/ru.json";
import fr from "../i18n/fr.json";
import hi from "../i18n/hi.json";
import pt from "../i18n/pt.json";

/** Interface languages. Italian is the source text; the others are dictionaries keyed by the Italian string. */
export const UI_LANGS: Record<string, { name: string; dict: Record<string, string> | null }> = {
  it: { name: "Italian", dict: it },
  en: { name: "English", dict: en },
  de: { name: "German", dict: de },
  es: { name: "Spanish", dict: es },
  ru: { name: "Russian", dict: ru },
  fr: { name: "French", dict: fr },
  hi: { name: "Hindi", dict: hi },
  pt: { name: "Brazilian Portuguese", dict: pt },
};


/** Server-side translation of a fixed Italian string (used for push notifications). */
export function trServer(lang: string, text: string): string {
  const v = UI_LANGS[lang]?.dict?.[text];
  return v ? v.split(" ||| ").pop()! : text;
}
