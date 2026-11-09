/**
 * Proveedor simulado y determinista, sin red ni clave. Sirve para probar el ciclo, el front y el despliegue
 * sin gastar tokens (LLM_PROVIDER=simulado). No interpreta lenguaje: sigue un guion fijo sobre el último mensaje.
 */
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import type { StructuredToolInterface } from "@langchain/core/tools"
import { enviarConModelo, textoDe, type AdaptadorLLM } from "./adapter"

const PASOS = ["proveedor_procesar_caso"]

type Resumen = {
  cliente: string; pais: string; formato: string; campos_llenos: number; campos_faltantes: string[]
  requiere_confirmacion: { etiqueta: string; nota?: string }[]; carpeta: string
  paquete: { listo_para_firma?: boolean; soportes?: { tipo: string; estado: string; vigencia_hasta: string | null }[]; bloqueos?: string[]; error?: string }
}

/** Redacta el resumen del caso a partir del resultado de proveedor_procesar_caso, sin agregar datos propios. */
function resumirCaso(resultado: string): string {
  const r = JSON.parse(resultado) as { ok: boolean; data?: Resumen; error?: string }
  if (!r.ok || !r.data) return `No fue posible procesar el caso: ${r.error ?? "error desconocido"}.`
  const d = r.data
  const lista = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- Ninguno.")
  const soportes = d.paquete.soportes ?? []
  return [
    `**Caso y cliente:** ${d.cliente} (${d.pais}), formato ${d.formato}.`,
    `**Campos llenos:** ${d.campos_llenos}.`,
    `**Campos faltantes:**\n${lista(d.campos_faltantes)}`,
    `**Requieren confirmación:**\n${lista(d.requiere_confirmacion.map((x) => `${x.etiqueta}: ${x.nota ?? ""}`))}`,
    `**Soportes:**\n${lista(soportes.map((x) => `${x.tipo}: ${x.estado}${x.vigencia_hasta ? ` (vigencia hasta ${x.vigencia_hasta})` : ""}`))}`,
    `**Estado:** listo_para_firma = ${d.paquete.listo_para_firma ? "sí" : "no"}.${d.paquete.bloqueos?.length ? ` Bloqueos:\n${lista(d.paquete.bloqueos)}` : ""}`,
    `**Ruta:** ${d.carpeta}`,
    "¿Confirma que desea simular el envío del paquete?",
  ].join("\n\n")
}

export class ChatSimulado extends BaseChatModel {
  private readonly etiqueta: string
  constructor(campos: { etiqueta?: string } = {}) {
    super({})
    this.etiqueta = campos.etiqueta ?? "[Modo simulado]"
  }
  _llmType() {
    return "simulado"
  }
  override bindTools(): this {
    return this
  }
  async _generate(mensajes: BaseMessage[]): Promise<ChatResult> {
    const msg = this.decidir(mensajes)
    return { generations: [{ message: msg, text: textoDe(msg) }] }
  }
  private decidir(mensajes: BaseMessage[]): AIMessage {
    const iHumano = mensajes.map((m) => m.getType()).lastIndexOf("human")
    const humano = iHumano >= 0 ? textoDe(mensajes[iHumano] as BaseMessage) : ""
    const herramientas = mensajes.slice(iHumano + 1).filter((m): m is ToolMessage => m instanceof ToolMessage)
    const historial = mensajes.map(textoDe).join("\n")
    const caso = (humano.match(/[a-z]{2}-[a-z0-9-]+/) ?? historial.match(/"caso":"([a-z]{2}-[a-z0-9-]+)"/)?.slice(1) ?? [])[0]
    const uso = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    const llamar = (name: string, args: Record<string, unknown>) => new AIMessage({ content: "", tool_calls: [{ id: `sim-${herramientas.length}`, name, args, type: "tool_call" }], usage_metadata: uso })
    if (!caso) return new AIMessage({ content: `${this.etiqueta} Indique el nombre del caso que desea procesar, por ejemplo ec-corp-andina.`, usage_metadata: uso })
    if (/^\s*(s[ií]|confirmo|env[ií]a|adelante|procede)/i.test(humano)) {
      if (!herramientas.length) return llamar("proveedor_simular_envio", { caso, confirmado: true })
      const r = JSON.parse(textoDe(herramientas[0] as BaseMessage)) as { ok: boolean; data?: { ruta: string }; error?: string }
      return new AIMessage({ content: `${this.etiqueta}\n\n${r.ok ? `Envío simulado registrado en ${r.data?.ruta}. No se envió ningún correo real.` : `No se realizó el envío: ${r.error}.`}`, usage_metadata: uso })
    }
    const siguiente = PASOS[herramientas.length]
    if (siguiente === "proveedor_mapear_campos") {
      const campos = (JSON.parse(textoDe(herramientas[0] as BaseMessage)) as { data?: { campos?: { etiqueta: string }[] } }).data?.campos?.map((c) => c.etiqueta) ?? []
      return llamar(siguiente, { caso, campos })
    }
    if (siguiente) return llamar(siguiente, { caso })
    const resumen = resumirCaso(textoDe(herramientas[herramientas.length - 1] as BaseMessage))
    return new AIMessage({ content: `${this.etiqueta}\n\n${resumen}`, usage_metadata: uso })
  }
}

export class AdaptadorSimulado implements AdaptadorLLM {
  readonly proveedor = "simulado"
  readonly modelo = "guion-determinista"
  readonly precio = { entrada: 0, salida: 0 }
  private readonly chat = new ChatSimulado()
  enviar(mensajes: BaseMessage[], herramientas: StructuredToolInterface[]) {
    return enviarConModelo(this.chat, mensajes, herramientas)
  }
  modeloChat() {
    return this.chat
  }
}
