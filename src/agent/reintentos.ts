/** Reintenta la llamada al modelo ante límite de uso (429) con espera exponencial, respetando el tiempo que indique el proveedor. */
import { createMiddleware } from "langchain"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"

export type ConfigReintentos = { intentos: number; esperaBaseMs: number; esperaMaximaMs: number; timeoutLlamadaMs: number; presupuestoMs: number }
export type ModeloNombrado = { nombre: string; modelo: BaseChatModel }

export function esLimiteDeUso(e: unknown): boolean {
  const texto = e instanceof Error ? `${e.message} ${(e as { status?: number }).status ?? ""}` : String(e)
  return /\b429\b|quota|rate.?limit|resource.?exhausted|too many requests/i.test(texto)
}

/** Lee la espera sugerida por el proveedor ("retryDelay":"30s" o "retry in 12.5s"). */
export function esperaSugeridaMs(e: unknown): number | undefined {
  const texto = e instanceof Error ? e.message : String(e)
  const m = texto.match(/retry[_ ]?delay"?\s*:?\s*"?(\d+(?:\.\d+)?)s/i) ?? texto.match(/retry in (\d+(?:\.\d+)?)\s*s/i)
  return m?.[1] ? Math.ceil(Number(m[1]) * 1000) : undefined
}

const dormir = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), rej(signal.reason)), { once: true })
  })

export function esCuotaDiaria(e: unknown): boolean {
  return /per.?day|daily|PerDay/i.test(e instanceof Error ? e.message : String(e))
}

export class TiempoAgotado extends Error {
  constructor(ms: number) {
    super(`timeout: el modelo no respondió en ${Math.round(ms / 1000)} s`)
    this.name = "TiempoAgotado"
  }
}

function conTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new TiempoAgotado(ms)), ms)
    p.then((v) => (clearTimeout(t), res(v)), (e) => (clearTimeout(t), rej(e)))
  })
}

/** Modelos agotados o lentos recientemente: se saltan sin esperar mientras dure el bloqueo. */
const bloqueados = new WeakMap<object, number>()
const disponible = (m: object) => (bloqueados.get(m) ?? 0) <= Date.now()

/**
 * Cadena de respaldo por llamada al modelo:
 * - cada llamada tiene su propio timeout (timeoutLlamadaMs);
 * - ante timeout o cuota diaria agotada pasa de inmediato al siguiente modelo;
 * - ante límite por minuto (429) reintenta con espera, solo si cabe en el presupuesto del turno;
 * - el último modelo de la cadena (determinista) siempre se intenta.
 * La respuesta lleva en response_metadata.modelo_usado qué modelo o modo respondió.
 */
export function middlewareReintentos(c: ConfigReintentos, principal: string, respaldos: ModeloNombrado[] = []) {
  return createMiddleware({
    name: "CadenaDeRespaldo",
    wrapModelCall: async (request, handler) => {
      const inicio = Date.now()
      const restante = () => c.presupuestoMs - (Date.now() - inicio)
      const cadena: ModeloNombrado[] = [{ nombre: principal, modelo: request.model as BaseChatModel }, ...respaldos]
      const ultimo = cadena[cadena.length - 1] as ModeloNombrado
      let error: unknown
      for (const m of cadena) {
        const esUltimo = m === ultimo
        if (!esUltimo && (!disponible(m.modelo) || restante() < 2_000)) continue
        for (let intento = 0; ; intento++) {
          try {
            const limite = esUltimo ? Math.max(restante(), c.timeoutLlamadaMs) : Math.min(c.timeoutLlamadaMs, restante())
            const r = await conTimeout(Promise.resolve(handler({ ...request, model: m.modelo })), limite)
            if (r && typeof r === "object" && "response_metadata" in r) (r as { response_metadata: Record<string, unknown> }).response_metadata.modelo_usado = m.nombre
            return r
          } catch (e) {
            error = e
            const lento = e instanceof TiempoAgotado
            if (!lento && !esLimiteDeUso(e)) throw e
            if (lento || esCuotaDiaria(e)) {
              bloqueados.set(m.modelo, Date.now() + (lento ? 2 : 60) * 60_000)
              break
            }
            const espera = Math.min(esperaSugeridaMs(e) ?? c.esperaBaseMs * 2 ** intento, c.esperaMaximaMs)
            if (intento >= c.intentos || espera + c.timeoutLlamadaMs > restante()) {
              bloqueados.set(m.modelo, Date.now() + 60_000)
              break
            }
            await dormir(espera, request.runtime?.signal)
          }
        }
      }
      throw error
    },
  })
}
