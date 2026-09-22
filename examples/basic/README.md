# example-basic

App de ejemplo que consume `@arcton/core` y muestra las capacidades actuales del framework:

- `GET /` y `GET /health` — un handler retorna un valor plano y el framework lo mapea a JSON automáticamente.
- `GET /text` — un handler puede retornar un `Response` propio (texto plano, headers/status custom) y se usa tal cual, sin envolverlo en JSON.
- `POST /echo` — lee el body de la request (`request.json()`) y lo retorna.
- `WS /chat` — ruta de WebSocket: responde `"connected"` al abrir la conexión y hace echo de cada mensaje.

## Uso

```bash
bun install
bun run dev
```

Luego:

```bash
curl http://localhost:3001/health
```
