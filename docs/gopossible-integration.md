# Integracja gopossible.pl ↔ Aplikacja Kurierska

Ten dokument opisuje jak przesłać trasę z platformy **gopossible.pl** (PC dyspozytora) na
telefon kuriera za pomocą **kodu QR**.

## Architektura przepływu

```
┌────────────────────────────┐      ┌──────────────────────┐      ┌──────────────────┐
│  gopossible.pl (backend)   │      │  Kurier API          │      │  Kurier App      │
│                            │      │  (FastAPI)           │      │  (Expo)          │
│  1. dyspozytor robi PDF/XLS│ ───► │ POST /api/transfer/  │ ───► │ Wyświetla QR     │
│  2. wywołuje endpoint      │      │ create (parsuje +    │      │ z payloadem      │
│                            │      │ zwraca kod 6-zn.)    │      │                  │
└────────────────────────────┘      └──────────────────────┘      └─────┬────────────┘
                                                                        │ skan QR
                                                                        ▼
                                    ┌──────────────────────┐      ┌──────────────────┐
                                    │ GET /api/transfer/   │ ◄─── │ Apka pobiera     │
                                    │ {code} (zwraca trasę)│      │ trasę i otwiera  │
                                    └──────────────────────┘      └──────────────────┘
```

## Klucz API

```
GOPOSSIBLE_API_KEY=Um5sYY1aoX4P7vnJU6XA5D067W36wj4rNmQQyuSED5g
```

Przechowuj go w pliku `.env` po stronie `gopossible.pl`, **nigdy** nie umieszczaj go w kodzie frontendu/HTML.

## Endpoint 1 — Utworzenie transferu (PC)

```http
POST https://<KURIER_API>/api/transfer/create
Content-Type: application/json
X-Api-Key: Um5sYY1aoX4P7vnJU6XA5D067W36wj4rNmQQyuSED5g

{
  "pdf_base64": "<plik PDF / XLS / XLSX zakodowany w base64>",
  "name": "Trasa Szczecin — 25.06.2026 (opcjonalnie)"
}
```

Odpowiedź (200):

```json
{
  "transfer_code": "AB7K23",
  "qr_payload": "gopossible:transfer:AB7K23",
  "route_id": "f381b3fc-d375-44f4-95a9-0baa6b75da56",
  "stops": 132,
  "expires_at": "2026-06-26T18:43:21.456+00:00"
}
```

### Co dalej?

1. Wygeneruj **kod QR** na PC zawierający `qr_payload` (np. biblioteką `qrcode` w Pythonie lub `qrcode.js`).
2. Wyświetl użytkownikowi obok kodu jego **6-znakowy alias** (do ręcznego wpisania, gdyby kamera nie działała).
3. Pokaż czas wygaśnięcia (`expires_at` — domyślnie 24h od utworzenia).

### Błędy

| Kod | Opis |
|-----|------|
| 400 | Plik za mały / nierozpoznany format (oczekiwany PDF, XLS, XLSX) / pusta lista paczek |
| 401 | Niepoprawny `X-Api-Key` |
| 500 | Błąd parsera AI (przy plikach PDF, gdy `EMERGENT_LLM_KEY` nie jest skonfigurowany) |

## Endpoint 2 — Pobranie trasy przez kuriera (app)

Aplikacja sama wywołuje ten endpoint po zeskanowaniu QR — nie potrzebujesz tego implementować po stronie gopossible.pl:

```http
GET /api/transfer/{transfer_code}
```

Odpowiedź:

```json
{
  "route": { "id": "...", "name": "...", "stops": [...] },
  "transfer": {
    "code": "AB7K23",
    "created_at": "...",
    "claimed_at": "2026-06-25T18:44:00+00:00",
    "expires_at": "...",
    "source": "gopossible.pl"
  }
}
```

## Endpoint 3 — Status (opcjonalny, do debugowania)

```http
GET /api/transfer/{code}/status
```

Bez autoryzacji — możesz po stronie gopossible.pl sprawdzić czy kod został już zeskanowany przez kuriera (`claimed_at != null`).

## Przykład w Pythonie

```python
import base64, requests

with open("manifest.xls", "rb") as f:
    b64 = base64.b64encode(f.read()).decode()

r = requests.post(
    "https://<KURIER_API>/api/transfer/create",
    json={"pdf_base64": b64, "name": "Trasa #142"},
    headers={"X-Api-Key": "Um5sYY1aoX4P7vnJU6XA5D067W36wj4rNmQQyuSED5g"},
    timeout=60,
)
r.raise_for_status()
data = r.json()

# Wygeneruj kod QR
import qrcode
img = qrcode.make(data["qr_payload"])
img.save("transfer.png")

print("Kod do wpisania ręcznego:", data["transfer_code"])
print("Wygasa:", data["expires_at"])
```

## Format QR

Aplikacja akceptuje payload w następujących formatach:

1. `gopossible:transfer:AB7K23` (preferowany)
2. `gopossible://transfer/AB7K23`
3. `https://gopossible.pl/transfer/AB7K23`
4. samo `AB7K23` (płaski kod)

## Bezpieczeństwo

- Kod jest 6-znakowy alfanumeryczny (bez 0/O/1/I dla czytelności) — ~10⁹ kombinacji.
- Ważny tylko **24h**.
- Klucz API trzymaj poza repozytorium.
- Jeden kod może być pobrany wielokrotnie (kurier może np. zamknąć i otworzyć apkę).

## Wsparcie

W razie problemów sprawdź logi backendu:

```bash
tail -f /var/log/supervisor/backend.err.log | grep transfer
```
