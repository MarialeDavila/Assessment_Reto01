/** Reintenta la llamada al modelo ante límite de uso (429) con espera exponencial, respetando el tiempo que indique el proveedor. */
import { createMiddleware } from "langchain"

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

export function middlewareReintentos(c: ConfigReintentos) {
  return createMiddleware({
    name: "ReintentoLimiteDeUso",
    wrapModelCall: async (request, handler) => {
      for (let intento = 0; ; intento++) {
        try {
          return await handler(request)
        } catch (e) {
          if (!esLimiteDeUso(e) || intento >= c.intentos) throw e
          const espera = Math.min(esperaSugeridaMs(e) ?? c.esperaBaseMs * 2 ** intento, c.esperaMaximaMs)
          await dormir(espera, request.runtime?.signal)
        }
      }
    },
  })
}
