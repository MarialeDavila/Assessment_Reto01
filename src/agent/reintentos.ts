/** Reintenta la llamada al modelo ante límite de uso (429) con espera exponencial, respetando el tiempo que indique el proveedor. */
import { createMiddleware } from "langchain"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"

export type ConfigReintentos = { intentos: number; esperaBaseMs: number; esperaMaximaMs: number }

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

/** Modelos agotados recientemente: se saltan sin esperar mientras dure el bloqueo. */
const bloqueados = new WeakMap<object, number>()
const disponible = (m: object) => (bloqueados.get(m) ?? 0) <= Date.now()

/**
 * Ante límite de uso (429): reintenta con espera exponencial (o la sugerida por el proveedor) y, si persiste,
 * pasa al siguiente modelo de la cadena de respaldos. Una cuota diaria agotada se salta de inmediato.
 */
export function middlewareReintentos(c: ConfigReintentos, respaldos: BaseChatModel[] = []) {
  return createMiddleware({
    name: "ReintentoLimiteDeUso",
    wrapModelCall: async (request, handler) => {
      const cadena = [request.model, ...respaldos].filter((m, i, a) => a.indexOf(m) === i)
      const candidatos = cadena.filter(disponible)
      let ultimo: unknown
      for (const modelo of candidatos.length ? candidatos : cadena) {
        for (let intento = 0; ; intento++) {
          try {
            return await handler({ ...request, model: modelo })
          } catch (e) {
            if (!esLimiteDeUso(e)) throw e
            ultimo = e
            if (esCuotaDiaria(e)) {
              bloqueados.set(modelo, Date.now() + 60 * 60_000)
              break
            }
            if (intento >= c.intentos) {
              bloqueados.set(modelo, Date.now() + 60_000)
              break
            }
            const espera = Math.min(esperaSugeridaMs(e) ?? c.esperaBaseMs * 2 ** intento, c.esperaMaximaMs)
            await dormir(espera, request.runtime?.signal)
          }
        }
      }
      throw ultimo
    },
  })
}
