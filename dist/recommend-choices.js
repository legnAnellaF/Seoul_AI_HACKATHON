export const knownTastes = new Set([
  '안 매운', '매운', '순살', '뼈', '치즈 듬뿍', '푸짐', '바삭', '마늘', '간장', '양념', '치즈', '로제',
  '짜장', '짬뽕', '마라', '국물', '담백', '반반', '불향', '해물', '크림', '얼큰', '칼칼', '달콤', '화덕', '세트',
  '단맛', '신맛', '짠맛', '쓴맛', '고소함', '감칠맛',
  '콜라 포함', '콜라 미포함', '쌈채소 포함', '쌈채소 미포함',
]);

const compact = text => typeof text === 'string' ? text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';
const answerText = text => compact(typeof text === 'string' ? text.replace(/\(\s*\d+\s*곳\s*\)\s*$/, '') : '')
  .replace(/(?:으로|로)?(?:해주세요|해줘|할래요|할게요|주세요|좋아요|좋아|이요|요)$/, '')
  .replace(/(?:으로|로)$/, '');

const addonSubjects = [
  { name: '콜라', terms: /콜라/ },
  { name: '쌈채소', terms: /쌈채소|쌈야채|쌈채/ },
];

export function addonAnswer(text, question = '') {
  const answer = compact(text);
  const subject = addonSubjects.find(({ terms }) => terms.test(answer)) ??
    addonSubjects.find(({ terms }) => terms.test(compact(question)));
  if (!subject || /\?|나요[.! ]*$|냐[.! ]*$|는지[.! ]*$/.test(text)) return null;
  const without = /미포함|제외|빼|없이|빠진|없(?:는|음|어$|어요$)|안오|안주|안먹|못먹|넣지|말고|싫|아니/.test(answer);
  const withAddon = /포함|기본|같이|함께|넣|있음|있으면|먹어요|먹을래|먹고싶|^네$|^예$|^응$/.test(answer);
  return without || withAddon ? [subject.name, without ? '미포함' : '포함'].join(' ') : null;
}

export function priorityChoice(text) {
  if (/[?？]|(?:나요|냐)[.! ]*$/.test(text)) return null;
  const key = compact(text);
  if (/맛보다가격|가격(?:이|을)?(?:더|가장)?(?:중요|우선|먼저)|^가성비/.test(key)) return 'price';
  if (/가격보다맛|맛(?:이|을)?(?:더|가장)?(?:중요|우선|먼저)/.test(key)) return 'taste';
  return null;
}

const tasteAliases = new Map([
  ['맵지않은', '안 매운'], ['안매운맛', '안 매운'], ['안매운거', '안 매운'], ['순한맛', '안 매운'],
  ['매운맛', '매운'], ['매운거', '매운'], ['매콤', '매운'], ['매콤한맛', '매운'],
  ['뼈있는치킨', '뼈'], ['뼈치킨', '뼈'], ['순살치킨', '순살'],
]);
const tasteNames = new Map([...knownTastes].map(taste => [compact(taste), taste]));

function tasteChoice(label) {
  const key = compact(label);
  const value = tasteAliases.get(key) ?? tasteNames.get(key);
  if (!value) return null;
  const subject = addonSubjects.find(({ name }) => value.startsWith(name + ' '));
  const group = subject ? 'addon-' + subject.name : ['안 매운', '매운'].includes(value) ? 'heat' :
    ['순살', '뼈'].includes(value) ? 'chicken-cut' : 'taste';
  return { group, value };
}

export function choicesForConditions({ people, menu, taste, budget, budget_unit, price_pref } = {}) {
  const choices = [];
  if (Number.isInteger(people) && people >= 1 && people <= 20) choices.push({ group: 'people', value: String(people) });
  if (typeof menu === 'string' && /^[가-힣·]{2,16}$/.test(menu)) choices.push({ group: 'menu', value: menu });
  if (Number.isSafeInteger(budget) && budget > 0) {
    choices.push({ group: budget_unit === 'per_person' ? 'budget-per-person' : 'budget-total', value: String(budget) });
  }
  if (price_pref === 'cheap') choices.push({ group: 'priority', value: 'price' });
  if (Array.isArray(taste)) choices.push(...taste.map(tasteChoice).filter(Boolean));
  return choices;
}

// Generic model questions keep their own group, even when the label is reused elsewhere.
function questionKey(text) {
  let hash = 2166136261;
  for (const character of compact(text)) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

export function followUpChoice(label, question, category) {
  const addon = addonAnswer(label, question);
  const taste = tasteChoice(addon ?? label);
  if (taste) return taste;
  const priority = priorityChoice(label);
  if (priority) return { group: 'priority', value: priority };
  const value = answerText(label);
  return question && value ? { group: ['question', category ?? '', questionKey(question)].join('-'), value } : null;
}

export function followUpAnswerIndex(text, options, question, category) {
  if (!options?.length || /[?？]|(?:나요|냐)[.! ]*$/.test(text)) return -1;
  const value = answerText(text);
  if (!value) return -1;
  const exact = options.findIndex(option => answerText(option.label) === value);
  if (exact >= 0) return exact;
  const taste = tasteChoice(addonAnswer(text, question) ?? value);
  return taste ? options.findIndex(option => choiceKey(followUpChoice(option.label, question, category)) === choiceKey(taste)) : -1;
}

export function choiceKey(choice) {
  const { group, value } = choice ?? {};
  return typeof group === 'string' && group.length > 0 && group.length <= 48 &&
    typeof value === 'string' && value.length > 0 && value.length <= 40 ? group + ':' + value : '';
}

export function recommendedChoiceKeys(choices, counts, sameQuestion = false) {
  const winners = new Map();
  for (const choice of choices) {
    const key = choiceKey(choice);
    const count = key ? counts.get(key) ?? 0 : 0;
    if (count < 2) continue;
    const group = sameQuestion ? 'question' : choice.group;
    const current = winners.get(group);
    if (!current || count > current.count) winners.set(group, { key, count, tied: false });
    else if (count === current.count && key !== current.key) current.tied = true;
  }
  return new Set([...winners.values()].filter(winner => !winner.tied).map(winner => winner.key));
}
