# Seoul_AI_HACKATHON
서울AI해커톤

## 메뉴 추천

주문자 홈의 메뉴 추천 탭에서 지역을 선택하고 음식·인원·예산·취향을 입력합니다. 추천 API(`/api/recommend`)는 Supabase의 합성 가게·메뉴를 조회하고 DB 메뉴 가격과 배달비로 예상 총액을 계산합니다.

Google AI Studio에서 받은 키를 Vercel Production 환경 변수 `GEMINI_API_KEY`에 저장하고 새로 배포하면 Gemini가 조건 분석과 후보 판단에 사용됩니다. 모델 기본값은 `gemini-3.5-flash-lite`이며 `GEMINI_MODEL`로 변경할 수 있습니다. Gemini를 사용할 수 없으면 같은 Supabase 데이터로 기본 추천을 제공합니다.
