import {createHash} from 'node:crypto';

// C3 reviewed display copy only. Keys pin the original description's exact UTF-8 bytes.
// There is no projection into the card, fact DTO or sales indexes.
// Public source intentionally contains no merchant copy rows.
const display = Object.freeze({});

export function catalogDisplayDescription(card) {
  const original=card?.description;
  const row=typeof card?.cardId==='string'&&Object.hasOwn(display,card.cardId)?display[card.cardId]:null;
  if (row && typeof original==='string' && createHash('sha256').update(original,'utf8').digest('hex')===row.sourceDescriptionSha256)
    return row.copy;
  return typeof original==='string'&&original.trim()?original:'待补充图片描述';
}
