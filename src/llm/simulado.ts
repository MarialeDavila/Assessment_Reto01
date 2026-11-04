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

class ChatSimulado extends BaseChatModel {
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
    if (!caso) return new AIMessage({ content: "Indique el nombre del caso que desea procesar, por ejemplo ec-corp-andina.", usage_metadata: uso })
    if (/^\s*(s[ií]|confirmo|env[ií]a|adelante|procede)/i.test(humano)) {
      if (!herramientas.length) return llamar("proveedor_simular_envio", { caso, confirmado: true })
      return new AIMessage({ content: `Resultado del envío simulado: ${textoDe(herramientas[0] as BaseMessage)}`, usage_metadata: uso })
    }
    const siguiente = PASOS[herramientas.length]
    if (siguiente === "proveedor_mapear_campos") {
      const campos = (JSON.parse(textoDe(herramientas[0] as BaseMessage)) as { data?: { campos?: { etiqueta: string }[] } }).data?.campos?.map((c) => c.etiqueta) ?? []
      return llamar(siguiente, { caso, campos })
    }
    if (siguiente) return llamar(siguiente, { caso })
    const paquete = textoDe(herramientas[herramientas.length - 1] as BaseMessage)
    return new AIMessage({ content: `[Modo simulado] Paquete de ${caso} armado. Resultado: ${paquete}\n\n¿Confirma que desea simular el envío del paquete?`, usage_metadata: uso })
  }
}

export class AdaptadorSimulado implements AdaptadorLLM {
  readonly proveedor = "simulado"
  readonly modelo = "guion-determinista"
  readonly precio = { entrada: 0, salida: 0 }
  private readonly chat = new ChatSimulado({})
  enviar(mensajes: BaseMessage[], herramientas: StructuredToolInterface[]) {
    return enviarConModelo(this.chat, mensajes, herramientas)
  }
  modeloChat() {
    return this.chat
  }
}
