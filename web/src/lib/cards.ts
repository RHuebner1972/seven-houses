import cards from "@/data/cards.json";

export type CardMeta = {
  id: string;
  name: string;
  arcana: "major" | "minor";
  suit: "wands" | "cups" | "swords" | "pentacles" | null;
  number: number;
  upright: string[];
  reversed: string[];
  image: string;
};

export const CARDS: CardMeta[] = cards as CardMeta[];

export const CARD_BY_ID: Record<string, CardMeta> = Object.fromEntries(
  CARDS.map((c) => [c.id, c]),
);

export function cardById(id: string): CardMeta {
  const card = CARD_BY_ID[id];
  if (!card) throw new Error(`Unknown card id: ${id}`);
  return card;
}

export const imageUrl = (id: string): string => `/deck/${id}.webp`;

export const BACK_URL = "/deck/back.webp";

export function orientationLabel(reversed: boolean): "reversed" | "upright" {
  return reversed ? "reversed" : "upright";
}

export function cardAlt(id: string, reversed: boolean): string {
  return `${cardById(id).name}, ${orientationLabel(reversed)}`;
}
