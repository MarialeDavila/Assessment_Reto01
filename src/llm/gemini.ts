import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
import { HarmBlockThreshold, HarmCategory } from "@google/generative-ai"
import type { BaseMessage } from "@langchain/core/messages"
import type { StructuredToolInterface } from "@langchain/core/tools"
import { enviarConModelo, type AdaptadorLLM } from "./adapter"

const CATEGORIAS = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
]

/** Adaptador para Google Gemini. La clave solo se lee de GEMINI_API_KEY en el backend. */
export class AdaptadorGemini implements AdaptadorLLM {
  readonly proveedor = "google-gemini"
  readonly modelo: string
  readonly precio: { entrada: number; salida: number }
  private readonly chat: ChatGoogleGenerativeAI

  constructor(apiKey: string, modelo: string) {
    this.modelo = modelo
    this.precio = { entrada: Number(process.env.PRECIO_ENTRADA_USD_MTOK ?? 0.75), salida: Number(process.env.PRECIO_SALIDA_USD_MTOK ?? 3.75) }
    this.chat = new ChatGoogleGenerativeAI({
      apiKey,
      model: modelo,
      temperature: 0,
      maxRetries: 1,
      safetySettings: CATEGORIAS.map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE })),
    })
  }

  enviar(mensajes: BaseMessage[], herramientas: StructuredToolInterface[]) {
    return enviarConModelo(this.chat, mensajes, herramientas)
  }

  modeloChat() {
    return this.chat
  }
}
