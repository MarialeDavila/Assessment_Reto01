import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"

export type Ctx = {
  directory: string
  sessionId: string
  /** Lo fija el servidor: true solo si el mensaje del usuario de este turno confirma una pregunta previa. */
  confirmacionHumana?: boolean
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

export const ok = <T>(data: T): Resultado<T> => ({ ok: true, data })
export const fallo = (error: string): Resultado<never> => ({ ok: false, error })

const CASO_VALIDO = /^[a-z0-9][a-z0-9-]{0,80}$/

export function rutas(ctx: Ctx, caso?: string) {
  const raiz = resolve(ctx.directory)
  const fixtures = join(raiz, "fixtures", "reto-01")
  const out = join(raiz, "out")
  return {
    raiz,
    fixtures,
    out,
    casos: join(fixtures, "casos"),
    caso: caso ? join(fixtures, "casos", caso) : "",
    salida: caso ? join(out, caso) : "",
    maestro: join(fixtures, "repositorio", "maestro.json"),
    soportes: join(fixtures, "repositorio", "soportes"),
    glosario: join(fixtures, "glosario-campos.json"),
    reglas: join(raiz, "src", "knowledge", "reglas.json"),
  }
}

export function validarCaso(ctx: Ctx, caso: string): Resultado<string> {
  if (!CASO_VALIDO.test(caso)) return fallo(`Nombre de caso no válido: "${caso}".`)
  const dir = rutas(ctx, caso).caso
  if (!existsSync(dir)) return fallo(`El caso "${caso}" no existe en fixtures/reto-01/casos/.`)
  return ok(dir)
}

/** Lee y parsea JSON; nunca lanza. */
export function leerJson<T = unknown>(ruta: string, nombre: string): Resultado<T> {
  if (!existsSync(ruta)) return fallo(`No se encontró ${nombre}.`)
  try {
    return ok(JSON.parse(readFileSync(ruta, "utf8")) as T)
  } catch {
    return fallo(`${nombre} está corrupto o no es JSON válido.`)
  }
}

export function asegurarDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** Garantiza que una ruta quede dentro de la raíz indicada (evita path traversal). */
export function dentroDe(raiz: string, ruta: string): boolean {
  const r = resolve(ruta)
  const base = resolve(raiz)
  return r === base || r.startsWith(base + sep)
}

export function relativa(ctx: Ctx, ruta: string): string {
  return resolve(ruta).slice(resolve(ctx.directory).length + 1).split(sep).join("/")
}

/** RN5 / CA4: registra la ejecución en out/log.jsonl y out/<caso>/log.jsonl. */
export function registrar(ctx: Ctx, herramienta: string, caso: string | undefined, r: Resultado<unknown>, resumen: string): void {
  try {
    const { out, salida } = rutas(ctx, caso && CASO_VALIDO.test(caso) ? caso : undefined)
    const linea = JSON.stringify({ ts: new Date().toISOString(), sesion: ctx.sessionId, caso: caso ?? null, herramienta, ok: r.ok, resumen }) + "\n"
    asegurarDir(out)
    appendFileSync(join(out, "log.jsonl"), linea)
    if (salida && existsSync(rutas(ctx, caso).caso)) {
      asegurarDir(salida)
      appendFileSync(join(salida, "log.jsonl"), linea)
    }
  } catch {
    // El registro nunca debe interrumpir la herramienta.
  }
}

/** Obtiene un valor del maestro por ruta con puntos ("banco.swift"). */
export function valorEnRuta(obj: unknown, ruta: string): unknown {
  return ruta.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj)
}

export function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

/** Fecha de ejecución (YYYY-MM-DD). FECHA_EJECUCION permite fijarla para pruebas reproducibles. */
export function fechaEjecucion(): string {
  const f = process.env.FECHA_EJECUCION
  if (f && /^\d{4}-\d{2}-\d{2}$/.test(f)) return f
  return new Date().toISOString().slice(0, 10)
}
