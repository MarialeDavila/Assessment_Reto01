/** API HTTP del agente y servidor del front de chat. */
import { Hono } from "hono"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, resolve } from "node:path"
import { Agente } from "./agent/agente"
import { Registro } from "./db"
import { crearAdaptador } from "./llm"
import { Sesiones } from "./sesiones"
import { dentroDe } from "./tools/lib"

const directorio = resolve(import.meta.dir, "..")
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d)
const config = {
  maxIteraciones: num(process.env.MAX_ITERACIONES, 25),
  maxTokensSesion: num(process.env.MAX_TOKENS_SESION, 200_000),
  timeoutMs: num(process.env.LLM_TIMEOUT_MS, 90_000),
  reintentos: { intentos: num(process.env.LLM_REINTENTOS, 3), esperaBaseMs: num(process.env.LLM_ESPERA_BASE_MS, 2_000), esperaMaximaMs: num(process.env.LLM_ESPERA_MAXIMA_MS, 30_000) },
}
const LIMITE_POR_MINUTO = num(process.env.MENSAJES_POR_MINUTO, 12)
const CLAVE_ACCESO = process.env.ACCESS_KEY ?? ""

const adaptador = crearAdaptador()
const registro = new Registro(directorio)
const agente = new Agente(adaptador, directorio, registro, config)
const sesiones = new Sesiones(directorio)
const ventanas = new Map<string, number[]>()

const app = new Hono()

// Protección opcional del link con una clave de acceso (cabecera x-access-key).
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health" || !CLAVE_ACCESO) return next()
  if (c.req.header("x-access-key") !== CLAVE_ACCESO) return c.json({ ok: false, error: "Clave de acceso inválida." }, 401)
  return next()
})

function excedeLimite(ip: string): boolean {
  const ahora = Date.now()
  const lista = (ventanas.get(ip) ?? []).filter((t) => ahora - t < 60_000)
  lista.push(ahora)
  ventanas.set(ip, lista)
  return lista.length > LIMITE_POR_MINUTO
}

app.get("/api/health", (c) => c.json({ ok: true, provider: adaptador.proveedor, model: adaptador.modelo, accessKeyRequired: Boolean(CLAVE_ACCESO) }))

app.post("/api/chat", async (c) => {
  const cuerpo = (await c.req.json().catch(() => null)) as { sessionId?: unknown; message?: unknown } | null
  const sessionId = typeof cuerpo?.sessionId === "string" ? cuerpo.sessionId : ""
  const message = typeof cuerpo?.message === "string" ? cuerpo.message.trim() : ""
  if (!sesiones.valido(sessionId)) return c.json({ ok: false, error: "sessionId inválido." }, 400)
  if (!message || message.length > 4000) return c.json({ ok: false, error: "El mensaje debe tener entre 1 y 4000 caracteres." }, 400)
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"
  if (excedeLimite(ip)) return c.json({ ok: false, error: "Demasiados mensajes en un minuto. Espere un momento." }, 429)
  const sesion = sesiones.obtenerOCrear(sessionId)
  try {
    const r = await agente.turno(sesion, message)
    sesiones.guardar(sesion)
    return c.json(r)
  } catch (e) {
    registro.log(sessionId, "error", "turno", e instanceof Error ? e.message : String(e))
    return c.json({ reply: "Ocurrió un error inesperado. La sesión sigue activa; intente de nuevo.", toolCalls: [], needsConfirmation: false, error: true })
  }
})

app.get("/api/sessions/:id", (c) => {
  const s = sesiones.obtener(c.req.param("id"))
  if (!s) return c.json({ ok: false, error: "Sesión no encontrada." }, 404)
  return c.json({ id: s.id, tokens: s.tokens, pendienteConfirmacion: s.pendienteConfirmacion, historial: s.historial })
})

app.get("/api/metricas", (c) => c.json({ ok: true, metricas: registro.resumenMetricas() }))

const salida = join(directorio, "out")
const listar = (dir: string, base = ""): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? listar(join(dir, n), `${base}${n}/`) : [`${base}${n}`]))

app.get("/api/archivos/:caso", (c) => {
  const dir = join(salida, c.req.param("caso"))
  if (!/^[a-z0-9-]+$/.test(c.req.param("caso")) || !existsSync(dir)) return c.json({ ok: false, error: "Sin archivos para ese caso." }, 404)
  return c.json({ ok: true, archivos: listar(dir) })
})

const TIPOS: Record<string, string> = { ".md": "text/markdown; charset=utf-8", ".json": "application/json", ".jsonl": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }

app.get("/api/archivos/:caso/*", (c) => {
  const relativo = decodeURIComponent(c.req.path.split(`/api/archivos/${c.req.param("caso")}/`)[1] ?? "")
  const ruta = join(salida, c.req.param("caso"), relativo)
  if (!dentroDe(salida, ruta) || !existsSync(ruta) || statSync(ruta).isDirectory()) return c.json({ ok: false, error: "Archivo no encontrado." }, 404)
  return new Response(readFileSync(ruta), { headers: { "content-type": TIPOS[extname(ruta)] ?? "application/octet-stream" } })
})

app.get("/", (c) => c.html(readFileSync(join(directorio, "web", "index.html"), "utf8")))

const port = num(process.env.PORT, 3000)
console.log(`Agente listo en http://localhost:${port} | proveedor: ${adaptador.proveedor} | modelo: ${adaptador.modelo}`)

export default { port, fetch: app.fetch, idleTimeout: 120 }
