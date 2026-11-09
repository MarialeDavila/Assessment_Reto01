import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
import { HarmBlockThreshold, HarmCategory } from "@google/generative-ai"
import type { BaseMessage } from "@langchain/core/messages"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { StructuredToolInterface } from "@langchain/core/tools"
import { enviarConModelo, type AdaptadorLLM } from "./adapter"
import { ChatSimulado } from "./simulado"

const CATEGORIAS = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
]

function crear(apiKey: string, model: string): ChatGoogleGenerativeAI {
  return new ChatGoogleGenerativeAI({
    apiKey,
    model,
    temperature: 0,
    maxRetries: 0, // los reintentos ante 429 los maneja src/agent/reintentos.ts
    safetySettings: CATEGORIAS.map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE })),
  })
}

/** Adaptador para Google Gemini. La clave solo se lee de GEMINI_API_KEY en el backend. */
export class AdaptadorGemini implements AdaptadorLLM {
  readonly proveedor = "google-gemini"
  readonly modelo: string
  readonly precio: { entrada: number; salida: number }
  readonly modeloDeRespaldo?: string
  private readonly chat: ChatGoogleGenerativeAI
  private readonly respaldo?: ChatGoogleGenerativeAI

  private readonly simulado?: ChatSimulado

  constructor(apiKey: string, modelo: string, respaldo?: string, respaldoSimulado = true) {
    this.modelo = modelo
    this.modeloDeRespaldo = respaldo && respaldo !== modelo ? respaldo : undefined
    this.precio = { entrada: Number(process.env.PRECIO_ENTRADA_USD_MTOK ?? 0.75), salida: Number(process.env.PRECIO_SALIDA_USD_MTOK ?? 3.75) }
    this.chat = crear(apiKey, modelo)
    this.respaldo = this.modeloDeRespaldo ? crear(apiKey, this.modeloDeRespaldo) : undefined
    this.simulado = respaldoSimulado ? new ChatSimulado({ etiqueta: "[Modo de respaldo sin IA: el proveedor de lenguaje alcanzó su límite de uso. Los datos provienen de las mismas herramientas.]" }) : undefined
  }

  /** Cadena de respaldo ante límite de uso: modelo liviano y, como último recurso, el guion determinista. */
  modelosRespaldo() {
    const cadena: { nombre: string; modelo: BaseChatModel }[] = []
    if (this.respaldo && this.modeloDeRespaldo) cadena.push({ nombre: this.modeloDeRespaldo, modelo: this.respaldo })
    if (this.simulado) cadena.push({ nombre: "modo de respaldo sin IA", modelo: this.simulado })
    return cadena
  }

  enviar(mensajes: BaseMessage[], herramientas: StructuredToolInterface[]) {
    return enviarConModelo(this.chat, mensajes, herramientas)
  }

  modeloChat() {
    return this.chat
  }
}
