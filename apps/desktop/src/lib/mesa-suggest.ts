// Suggestion scoring for "Nova mesa": tokenize the problem statement
// (lowercase, no diacritics, no stopwords) and match each token against a
// bot's name + role + description. A name hit weighs double a field hit; the
// score is normalized to 0–1 and SUGGEST_THRESHOLD decides the "sugerido" chip.
// The caller applies the result — nothing here ever selects or deselects.

const STOPWORDS = new Set(
  (
    "a o as os e é de do da dos das em um uma uns umas para por com sem que no na nos nas " +
    "se ao à às ou eu meu minha meus minhas nós você voce ele ela isso esse essa este esta " +
    "como quando onde mais menos muito não nao sim foi ser ter são sao já ja também tambem " +
    "seu sua seus suas lhe lo la los las pro pra entre sobre até ate depois antes agora " +
    "aqui ali lá la tudo nada cada qual quais qualquer outro outra outros outras mesmo mesma " +
    "desse dessa disso daquilo aquele aquela seja sejam está estao estão eram era foram será " +
    "sera ha há favor então entao assim ainda só so pode podem queria quero gostaria preciso " +
    "the an and or of to in on for with without is are be it this that we you i our your my " +
    "can should must will not please help me"
  ).split(" "),
);

/** Content tokens of free text: NFD-stripped, lowercase, ≥3 chars, no stopwords. */
export function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * 0–1 match of the problem against a bot: each token scores 2 on a name hit,
 * 1 on a role/description hit, normalized by 2× tokens so all-name = 1.
 */
export function suggestScore(
  tokens: string[],
  bot: { name: string; role?: string; description?: string },
): number {
  if (!tokens.length) return 0;
  const name = strip(bot.name);
  const hay = strip(`${bot.name} ${bot.role ?? ""} ${bot.description ?? ""}`);
  let hits = 0;
  for (const t of tokens) {
    if (name.includes(t)) hits += 2;
    else if (hay.includes(t)) hits += 1;
  }
  return hits / (tokens.length * 2);
}

export const SUGGEST_THRESHOLD = 0.2;

/** Ids of bots at or above the threshold; empty when the problem has no content tokens. */
export function suggestedBots(
  problem: string,
  bots: { id: string; name: string; role?: string; description?: string }[],
): string[] {
  const tokens = tokenize(problem);
  if (!tokens.length) return [];
  return bots.filter((b) => suggestScore(tokens, b) >= SUGGEST_THRESHOLD).map((b) => b.id);
}
