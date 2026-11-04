# Reto 01: Agente conversacional "Registro como Proveedor"

Agente que lee una solicitud de registro como proveedor, mapea los campos al repositorio maestro, genera el formulario (xlsx o pdf; valores copiables para portal), arma el paquete para firma y simula el envío solo con confirmación explícita.

- Link de prueba: `<URL de Render>` (completar tras el despliegue)
- Clave de acceso: no requerida, salvo que se defina `ACCESS_KEY`.

## Requisitos

Bun 1.4 o superior (o Docker).

## Levantar en local (un comando)

```bash
cp .env.example .env      # completar GEMINI_API_KEY
bun install && bun run dev
# o bien
docker compose up --build
```

Abrir http://localhost:3000. Sin `GEMINI_API_KEY` el servidor arranca con el proveedor `simulado` (guion determinista, sin red), útil para probar el front y el ciclo.

## Verificación sin modelo

```bash
bun install && bun run demo.ts   # ejecuta las herramientas sobre los 4 casos; limpia out/ al inicio
bun test                         # 18 pruebas de reglas de negocio, errores y confirmación
bun run typecheck
```

`FECHA_EJECUCION=2026-09-02 bun run demo.ts` fija la fecha con la que se evalúan las vigencias.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `GEMINI_API_KEY` | Sí (para usar Gemini) | Clave de Google AI Studio. Solo en el backend. |
| `GEMINI_MODEL` | No | Por defecto `gemini-3.8-flash`. |
| `LLM_PROVIDER` | No | `gemini` (defecto) o `simulado`. |
| `MAX_ITERACIONES` | No | Tope de iteraciones modelo-herramienta por turno (25). |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión (200000). |
| `LLM_TIMEOUT_MS` | No | Timeout al proveedor (60000). |
| `MENSAJES_POR_MINUTO` | No | Límite por IP (12). |
| `ACCESS_KEY` | No | Si se define, la API exige la cabecera `x-access-key`. |
| `PRECIO_ENTRADA_USD_MTOK`, `PRECIO_SALIDA_USD_MTOK` | No | Precios para estimar costo en métricas. |
| `FECHA_EJECUCION` | No | Fecha fija (YYYY-MM-DD) para evaluar vigencias. |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, uso }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `GET` | `/api/health` | `{ ok, provider, model }` sin exponer claves |
| `GET` | `/api/metricas` | Tokens, latencia y costo estimado por modelo (SQLite) |
| `GET` | `/api/archivos/:caso[/ruta]` | Lista y descarga los archivos generados en `out/<caso>/` |

## Despliegue en Render

1. Crear un Web Service desde el repositorio, runtime Docker (o usar `render.yaml` como Blueprint).
2. Definir `GEMINI_API_KEY` en Environment. No subir `.env`.
3. Health check: `/api/health`.

En el plan gratuito el disco es efímero: `out/` y `out/app.db` se pierden al reiniciar o redesplegar, y el servicio se suspende tras inactividad (la primera petición tarda más).

## Estructura

```
agent/prompt.md                     comportamiento (system prompt)
src/knowledge/                      conocimiento: registro-proveedor.md y reglas.json
src/tools/proveedor.ts              ejecución: herramientas zod (proveedor_*)
src/agent/                          ciclo del agente (LangGraph) y adaptación de herramientas
src/llm/                            adaptador propio + Gemini + simulado
src/server.ts, src/db.ts            API Hono y registro SQLite
web/index.html                      front de chat
modulo/                             bonus: agente empaquetado (bun run modulo)
demo.ts, test/                      verificación sin modelo
```
