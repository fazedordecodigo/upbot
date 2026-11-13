import { expect, test } from "bun:test";
import { suggestedBots, suggestScore, tokenize } from "../src/lib/mesa-suggest";

const bot = (over: { id?: string; name?: string; role?: string; description?: string } = {}) => ({
  id: over.id ?? "b1",
  name: over.name ?? "Boto",
  role: over.role ?? "",
  description: over.description ?? "",
});

test("tokenize strips diacritics, drops stopwords and short tokens", () => {
  expect(tokenize("Corrija a autenticação no checkout, por favor")).toEqual([
    "corrija",
    "autenticacao",
    "checkout",
  ]);
  expect(tokenize("o e a de do em um uma para por com sem que")).toEqual([]);
  expect(tokenize("")).toEqual([]);
});

test("a name hit weighs more than a role or description hit", () => {
  const tokens = tokenize("cobrar o cliente no pix");
  const byName = suggestScore(tokens, bot({ name: "Pix", role: "finanças" }));
  const byRole = suggestScore(tokens, bot({ name: "Fin", role: "pix e cobranças" }));
  const byNothing = suggestScore(tokens, bot({ name: "X", role: "jardinagem" }));
  expect(byName).toBeGreaterThan(byRole);
  expect(byRole).toBeGreaterThan(byNothing);
  expect(byNothing).toBe(0);
});

test("suggestedBots picks bots over the threshold and stays empty without tokens", () => {
  const bots = [
    bot({ id: "fin", name: "Fin", role: "pagamentos, pix e estornos" }),
    bot({ id: "docs", name: "Docs", role: "escreve e revisa documentos" }),
    bot({ id: "ops", name: "Ops", role: "deploy e infra" }),
  ];
  const ids = suggestedBots("estouro de estorno no pix do cliente", bots);
  expect(ids).toEqual(["fin"]);
  expect(suggestedBots("o e de do", bots)).toEqual([]);
  expect(suggestedBots("", bots)).toEqual([]);
});
