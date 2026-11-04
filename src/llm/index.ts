import type { AdaptadorLLM } from "./adapter"
import { AdaptadorGemini } from "./gemini"
import { AdaptadorSimulado } from "./simulado"

/** Elige el proveedor por variable de entorno. Agregar uno nuevo no toca el ciclo del agente. */
export function crearAdaptador(): AdaptadorLLM {
  const proveedor = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase()
  if (proveedor === "simulado") return new AdaptadorSimulado()
  const clave = process.env.GEMINI_API_KEY
  if (!clave) {
    console.warn("GEMINI_API_KEY no está definida: se usa el proveedor simulado.")
    return new AdaptadorSimulado()
  }
  return new AdaptadorGemini(clave, process.env.GEMINI_MODEL || "gemini-3.8-flash", process.env.GEMINI_MODEL_RESPALDO ?? "gemini-3.1-flash-lite")
}
