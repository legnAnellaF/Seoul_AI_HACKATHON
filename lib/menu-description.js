const textLimits = { name: 80, taste: 60, portion: 60, features: 100, notes: 240 };
const descriptionLimit = 240;
const singleLine = value => value.trim().replace(/\s+/gu, ' ');

export function readMenuDescriptionInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('메뉴 정보를 입력해 주세요.');
  const menu = {};
  for (const [field, max] of Object.entries(textLimits)) {
    const value = body[field] ?? '';
    if (typeof value !== 'string' || value.length > max) throw new Error('메뉴 정보의 글자 수를 확인해 주세요.');
    menu[field] = singleLine(value);
  }
  if (!menu.name) throw new Error('메뉴명을 입력해 주세요.');
  if (!Number.isInteger(body.price) || body.price < 1 || body.price > 1000000) throw new Error('가격을 확인해 주세요.');
  const servings = body.servings ?? null;
  if (servings !== null && (!Number.isInteger(servings) || servings < 1 || servings > 20)) {
    throw new Error('인분은 1~20 사이의 숫자로 입력해 주세요.');
  }
  if (!(menu.taste || servings || menu.portion || menu.features || menu.notes)) {
    throw new Error('맛, 분량, 특징, 설명 메모 중 한 가지 이상 입력해 주세요.');
  }
  return { ...menu, price: body.price, servings };
}

export function formatMenuDescription({ name, taste, servings, portion, features, notes }) {
  const sentence = value => value && /[.!?。？！]$/u.test(value) ? value : `${value}.`;
  const facts = [taste, servings && `${servings}인분`, portion, features].filter(Boolean).join(' · ');
  const description = [sentence(`${name}입니다`), facts && sentence(facts), notes && sentence(notes)].filter(Boolean).join(' ');
  if (description.length <= descriptionLimit) return description;
  return description.slice(0, descriptionLimit - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '…';
}

export function validateMenuDraft(output, menu) {
  if (typeof output?.description !== 'string') return null;
  const description = singleLine(output.description);
  if (!description || description.length > descriptionLimit || /[<>\u0000-\u001f]/.test(description)) return null;
  const numbers = value => value.match(/\d[\d,]*(?:\.\d+)?/g)?.map(match => match.replace(/,/g, '')) ?? [];
  const enteredNumbers = new Set(numbers(Object.values(menu).filter(value => value !== null).join(' ')));
  return numbers(description).every(number => enteredNumbers.has(number)) ? description : null;
}
