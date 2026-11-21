import { createLLM } from '../lib/llm/index.js';
import { formatMenuDescription, readMenuDescriptionInput, validateMenuDraft } from '../lib/menu-description.js';

export default async function menuDescription(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: '지원하지 않는 요청입니다.' });
  }

  let menu;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    menu = readMenuDescriptionInput(body);
  } catch (error) {
    const message = error instanceof SyntaxError ? '메뉴 요청을 읽을 수 없습니다.' : error.message;
    return res.status(400).json({ error: message });
  }

  if (process.env.GEMINI_API_KEY?.trim()) {
    try {
      const llm = createLLM(process.env, { deadline: Date.now() + 7500 });
      const draft = await llm.describeMenu(menu);
      const description = validateMenuDraft(draft, menu);
      if (description) return res.status(200).json({ description, provider: llm.provider });
    } catch {
      // The same input can produce a draft without a model call.
    }
  }
  return res.status(200).json({ description: formatMenuDescription(menu), provider: 'rules' });
}
