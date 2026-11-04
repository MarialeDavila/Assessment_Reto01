/**
 * Interfaz propia del proveedor de lenguaje. El ciclo del agente solo conoce esta interfaz:
 * cambiar de proveedor (Gemini, OpenAI, Anthropic, local) consiste en agregar otra implementación.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { BaseMessage } from "@langchain/core/messages"
import type { StructuredToolInterface } from "@langchain/core/tools"

export type Uso = { entrada: number; salida: number }
export type LlamadaHerramienta = { id: string; nombre: string; args: Record<string, unknown> }
export type RespuestaModelo = { mensaje: BaseMessage; texto: string; llamadas: LlamadaHerramienta[]; uso: Uso }

export interface AdaptadorLLM {
  readonly proveedor: string
  readonly modelo: string
  /** Precio estimado en USD por millón de tokens (entrada, salida), para métricas de costo. */
  readonly precio: { entrada: number; salida: number }
  /** Una llamada al modelo con las herramientas disponibles. */
  enviar(mensajes: BaseMessage[], herramientas: StructuredToolInterface[]): Promise<RespuestaModelo>
  /** Modelo de chat compatible con LangChain, que usa el ciclo de LangGraph. */
  modeloChat(): BaseChatModel
  /** Modelo de respaldo ante límite de uso del modelo principal (opcional). */
  modeloRespaldo?(): BaseChatModel | undefined
  readonly modeloDeRespaldo?: string
}

export function textoDe(m: BaseMessage): string {
  const c = m.content
  if (typeof c === "string") return c
  return c.map((p) => (typeof p === "object" && p && "text" in p && typeof p.text === "string" ? p.text : "")).join("")
}

/** Implementación genérica de enviar() sobre cualquier BaseChatModel con soporte de herramientas. */
export async function enviarConModelo(modelo: BaseChatModel, mensajes: BaseMessage[], herramientas: StructuredToolInterface[]): Promise<RespuestaModelo> {
  if (!modelo.bindTools) throw new Error("El modelo no soporta herramientas.")
  const r = await modelo.bindTools(herramientas).invoke(mensajes)
  const meta = "usage_metadata" in r ? (r.usage_metadata as { input_tokens?: number; output_tokens?: number } | undefined) : undefined
  const llamadas = ("tool_calls" in r && Array.isArray(r.tool_calls) ? r.tool_calls : []).map((t: { id?: string; name: string; args: Record<string, unknown> }) => ({ id: t.id ?? "", nombre: t.name, args: t.args }))
  return { mensaje: r, texto: textoDe(r), llamadas, uso: { entrada: meta?.input_tokens ?? 0, salida: meta?.output_tokens ?? 0 } }
}
