# Kurier Nawigacja — PRD

Polish-language mobile app (Expo React Native + FastAPI + MongoDB) for couriers.

## Core flows
1. **Upload manifest (PDF)** — driver uploads a PDF manifest from their phone. Gemini 2.5-flash (via emergentintegrations / Emergent LLM Key) extracts every stop (address, recipient, phone, package numbers, COD amount) and orders them logically by city/postal-code/street.
2. **Route list** (`/`) — all routes with delivered/total ratio and total COD per route.
3. **Stop list** (`/route/[id]`) — every stop with COD (Pobranie) badge, package count, status (Oczekuje / Dostarczono / Nieobecny).
4. **Stop detail** (`/route/[id]/stop/[stopId]`) — address, recipient, phone, package numbers, big "Nawiguj" button (opens native Maps), pinned "Dostarczono" + "Nieobecny" actions.
5. **Dostarczono** — camera photo of drop-off spot, then signature pad with auto Polish header _"Potwierdzam odebranie przesyłki nr X przez Y"_. Saved to backend.
6. **Adresat nieobecny** — one-tap "Wyślij SMS: Proszę o kontakt" opens the native SMS app with the recipient's number and a prefilled Polish message.

## Backend
FastAPI + Motor + MongoDB. All endpoints under `/api`.
- `POST /api/manifest/upload` (body: pdf_base64, name?) → Gemini parses → Route persisted.
- `GET /api/routes`, `GET /api/routes/{id}`, `DELETE /api/routes/{id}`.
- `GET /api/routes/{rid}/stops/{sid}`.
- `POST /api/routes/{rid}/stops/{sid}/deliver` (photo_base64?, signature_base64?).
- `POST /api/routes/{rid}/stops/{sid}/absent` (note?).
- `POST /api/routes/{rid}/stops/{sid}/reset`.

## Frontend
Expo Router file-based screens. UUID ids, no `_id` exposure. SafeAreaProvider at root. `react-native-signature-canvas` (WebView-based) for signatures, `expo-camera` for photos, `expo-document-picker` + `expo-file-system` for PDF intake, `Linking` for Maps + SMS deep links.

## Design
Performance-Pro daylight theme (high-contrast, 56–64px touch targets, primary orange #FF5A00 for upload, success green for Dostarczono, error red for Nieobecny, amber Pobranie badges).

## Integrations
- **Gemini 2.5-flash** via Emergent LLM Key (`EMERGENT_LLM_KEY` in `/app/backend/.env`) using `emergentintegrations.llm.chat.LlmChat` + `FileContentWithMimeType`.
