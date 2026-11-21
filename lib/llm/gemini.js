// Gemini 어댑터: complete({ system, payload, schema, timeoutMs }) → 응답 문자열
export function createGeminiProvider(env = process.env) {
  const key = env.GEMINI_API_KEY?.trim();
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  return {
    name: 'gemini',
    available: !!key,
    async complete({ system, payload, schema, timeoutMs }) {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload) }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 2200 }
        })
      });
      if (!response.ok) {
        const error = new Error('Gemini HTTP ' + response.status);
        // 4xx(429 제외)는 다시 보내도 같은 결과
        error.fatal = response.status >= 400 && response.status < 500 && response.status !== 429;
        throw error;
      }
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('') ?? '';
    }
  };
}
