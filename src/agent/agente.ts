/**
 * Ciclo del agente sobre LangGraph (createAgent de LangChain v1):
 * prompt -> modelo -> llamadas a herramientas -> respuesta, con tope de iteraciones, tope de tokens,
 * timeout al proveedor y confirmación humana validada en el servidor.
 */
import { createAgent } from "langchain"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { textoDe, type AdaptadorLLM } from "../llm/adapter"
import type { Registro } from "../db"
import { aLangChain } from "./herramientas-langchain"
import { middlewareReintentos, type ConfigReintentos } from "./reintentos"

export type LlamadaVisible = { id: string; nombre: string; args: Record<string, unknown>; ok: boolean; resumen: string; resultado: string }
export type Entrada = { rol: "usuario" | "agente" | "error"; texto: string; ts: string; toolCalls?: LlamadaVisible[]; needsConfirmation?: boolean; modelo?: string }
export type Sesion = { id: string; mensajes: BaseMessage[]; historial: Entrada[]; tokens: number; pendienteConfirmacion: boolean }
export type Respuesta = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error?: boolean; modelo?: string; uso?: { entrada: number; salida: number; sesion: number } }

export type Config = { maxIteraciones: number; maxTokensSesion: number; timeoutMs: number; reintentos: ConfigReintentos }

const AFIRMATIVO = /\b(s[ií]|confirmo|confirmado|env[ií]a(lo)?|enviar|adelante|procede|de acuerdo|autorizo|ok)\b/i
const NEGATIVO = /\b(no|todav[ií]a no|cancela|espera|detente)\b/i

export function esConfirmacion(texto: string): boolean {
  return AFIRMATIVO.test(texto) && !NEGATIVO.test(texto)
}

export function cargarPrompt(directorio: string): string {
  const prompt = readFileSync(join(directorio, "agent", "prompt.md"), "utf8")
  const conocimiento = readFileSync(join(directorio, "src", "knowledge", "registro-proveedor.md"), "utf8")
  return `${prompt}\n\n---\n\n${conocimiento}`
}

function resumir(resultado: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(resultado) as { ok: boolean; data?: Record<string, unknown>; error?: string }
    if (!r.ok) return { ok: false, resumen: r.error ?? "Error" }
    const d = r.data ?? {}
    const partes = ["cliente", "formato", "ruta", "listo_para_firma"].filter((k) => k in d).map((k) => `${k}: ${String(d[k])}`)
    if (Array.isArray(d.llenos)) partes.push(`${d.llenos.length} llenos, ${(d.faltantes as unknown[]).length} faltantes, ${(d.requiere_confirmacion as unknown[]).length} por confirmar`)
    return { ok: true, resumen: partes.join(" | ") || "ok" }
  } catch {
    return { ok: false, resumen: resultado.slice(0, 200) }
  }
}

function llamadasVisibles(nuevos: BaseMessage[]): LlamadaVisible[] {
  const resultados = new Map(nuevos.filter((m): m is ToolMessage => m instanceof ToolMessage).map((m) => [m.tool_call_id, textoDe(m)]))
  return nuevos
    .filter((m): m is AIMessage => m instanceof AIMessage)
    .flatMap((m) => m.tool_calls ?? [])
    .map((t) => {
      const resultado = resultados.get(t.id ?? "") ?? JSON.stringify({ ok: false, error: "Sin resultado (tope alcanzado)" })
      return { id: t.id ?? "", nombre: t.name, args: t.args, resultado, ...resumir(resultado) }
    })
}

export class Agente {
  private readonly sistema: string

  constructor(
    private readonly adaptador: AdaptadorLLM,
    private readonly directorio: string,
    private readonly registro: Registro,
    private readonly config: Config,
  ) {
    this.sistema = cargarPrompt(directorio)
  }

  async turno(sesion: Sesion, mensaje: string): Promise<Respuesta> {
    const ts = new Date().toISOString()
    sesion.historial.push({ rol: "usuario", texto: mensaje, ts })
    if (sesion.tokens >= this.config.maxTokensSesion) {
      return this.cerrar(sesion, { reply: `Se alcanzó el tope de ${this.config.maxTokensSesion} tokens de esta sesión. Inicie una sesión nueva para continuar.`, toolCalls: [], needsConfirmation: false, error: true })
    }
    // CA3 / RN4: la confirmación solo vale si el turno anterior la pidió y este mensaje la da explícitamente.
    const confirmacionHumana = sesion.pendienteConfirmacion && esConfirmacion(mensaje)
    const ctx = { directory: this.directorio, sessionId: sesion.id, confirmacionHumana }
    const agente = createAgent({ model: this.adaptador.modeloChat(), tools: aLangChain(ctx), systemPrompt: this.sistema, middleware: [middlewareReintentos(this.config.reintentos, this.adaptador.modelo, this.adaptador.modelosRespaldo?.() ?? [])] })
    const entrada = [...sesion.mensajes, new HumanMessage(mensaje)]
    const inicio = Date.now()
    let estado: BaseMessage[] = entrada
    let tope = false
    try {
      const flujo = await agente.stream(
        { messages: entrada },
        { streamMode: "values", recursionLimit: this.config.maxIteraciones * 2 + 1, signal: AbortSignal.timeout(this.config.timeoutMs) },
      )
      for await (const paso of flujo) estado = (paso as { messages: BaseMessage[] }).messages
    } catch (e) {
      const nombre = e instanceof Error ? e.name : ""
      const texto = e instanceof Error ? e.message : String(e)
      if (nombre === "GraphRecursionError" || /recursion/i.test(texto)) tope = true
      else return this.fallar(sesion, nombre, texto, estado.slice(entrada.length))
    }
    return this.completar(sesion, entrada, estado, tope, Date.now() - inicio)
  }

  private completar(sesion: Sesion, entrada: BaseMessage[], estado: BaseMessage[], tope: boolean, latenciaMs: number): Respuesta {
    const nuevos = estado.slice(entrada.length)
    const toolCalls = llamadasVisibles(nuevos)
    const ias = nuevos.filter((m): m is AIMessage => m instanceof AIMessage)
    const uso = ias.reduce((a, m) => ({ entrada: a.entrada + (m.usage_metadata?.input_tokens ?? 0), salida: a.salida + (m.usage_metadata?.output_tokens ?? 0) }), { entrada: 0, salida: 0 })
    sesion.tokens += uso.entrada + uso.salida
    const costo = (uso.entrada * this.adaptador.precio.entrada + uso.salida * this.adaptador.precio.salida) / 1e6
    this.registro.metrica({ sesion: sesion.id, proveedor: this.adaptador.proveedor, modelo: this.adaptador.modelo, entrada: uso.entrada, salida: uso.salida, latenciaMs, costoUsd: costo, iteraciones: ias.length })
    this.registrarTareas(sesion.id, toolCalls)
    const final = [...ias].reverse().find((m) => !m.tool_calls?.length)
    let reply = final ? textoDe(final).trim() : ""
    if (tope) reply = `Alcancé el tope de ${this.config.maxIteraciones} iteraciones en este turno. Lo realizado: ${toolCalls.map((t) => `${t.nombre} (${t.ok ? "ok" : "error"})`).join(", ") || "ninguna herramienta"}. Pida que continúe para completar lo que falta.`
    if (!reply) reply = "No obtuve una respuesta del modelo. Intente de nuevo."
    const envioHecho = toolCalls.some((t) => t.nombre === "proveedor_simular_envio" && t.ok)
    const paquete = toolCalls.some((t) => (t.nombre === "proveedor_armar_paquete" || t.nombre === "proveedor_procesar_caso") && t.ok)
    const envioRechazado = toolCalls.some((t) => t.nombre === "proveedor_simular_envio" && !t.ok)
    const needsConfirmation = !envioHecho && (paquete || envioRechazado || (sesion.pendienteConfirmacion && /\?\s*$/.test(reply)))
    sesion.mensajes = tope ? entrada.concat(new AIMessage(reply)) : estado
    sesion.pendienteConfirmacion = needsConfirmation
    const modelos = [...new Set(ias.map((m) => m.response_metadata?.modelo_usado).filter((x): x is string => typeof x === "string"))]
    return this.cerrar(sesion, { reply, toolCalls, needsConfirmation, modelo: modelos.join(", ") || this.adaptador.modelo, uso: { ...uso, sesion: sesion.tokens } })
  }

  private registrarTareas(sesion: string, toolCalls: LlamadaVisible[]): void {
    for (const t of toolCalls) {
      const caso = typeof t.args.caso === "string" ? t.args.caso : ""
      if (!caso || !t.ok) continue
      const datos = (JSON.parse(t.resultado) as { data?: { listo_para_firma?: boolean; ruta?: string } }).data
      if (t.nombre === "proveedor_leer_solicitud") this.registro.tarea(sesion, caso, "en_proceso")
      if (t.nombre === "proveedor_armar_paquete") this.registro.tarea(sesion, caso, datos?.listo_para_firma ? "listo_para_firma" : "bloqueado")
      if (t.nombre === "proveedor_procesar_caso") {
        const listo = (JSON.parse(t.resultado) as { data?: { paquete?: { listo_para_firma?: boolean } } }).data?.paquete?.listo_para_firma
        this.registro.tarea(sesion, caso, listo ? "listo_para_firma" : "bloqueado")
      }
      if (t.nombre === "proveedor_simular_envio") {
        this.registro.tarea(sesion, caso, "envio_simulado")
        this.registro.transaccion(sesion, caso, datos?.ruta ?? "", Boolean(datos?.listo_para_firma))
      }
    }
  }

  /** CA5: un error del proveedor se explica en lenguaje claro y la sesión sigue viva. */
  private fallar(sesion: Sesion, nombre: string, detalle: string, parciales: BaseMessage[]): Respuesta {
    this.registro.log(sesion.id, "error", nombre || "error_llm", detalle)
    const timeout = /abort|timeout/i.test(nombre + detalle)
    const cuota = /429|quota|rate/i.test(detalle)
    const clave = /401|403|api key|permission/i.test(detalle)
    const motivo = timeout
      ? `El proveedor de lenguaje no respondió en ${Math.round(this.config.timeoutMs / 1000)} segundos.`
      : cuota
        ? /per.?day|daily|PerDay/i.test(detalle)
          ? "Se agotó la cuota diaria del proveedor de lenguaje para esta clave. Se restablece al día siguiente; también puede habilitar facturación en Google AI Studio o configurar otro modelo."
          : "El proveedor de lenguaje rechazó la solicitud por límite de uso por minuto, incluso después de reintentar. Espere un minuto e intente de nuevo."
        : clave
          ? "El proveedor de lenguaje rechazó la credencial configurada en el servidor."
          : "Ocurrió un error al comunicarse con el proveedor de lenguaje."
    const toolCalls = llamadasVisibles(parciales)
    const reply = `${motivo} La sesión sigue activa; puede intentar de nuevo.${toolCalls.length ? ` Herramientas ejecutadas antes del error: ${toolCalls.map((t) => t.nombre).join(", ")}.` : ""}`
    return this.cerrar(sesion, { reply, toolCalls, needsConfirmation: false, error: true })
  }

  private cerrar(sesion: Sesion, r: Respuesta): Respuesta {
    sesion.historial.push({ rol: r.error ? "error" : "agente", texto: r.reply, ts: new Date().toISOString(), toolCalls: r.toolCalls, needsConfirmation: r.needsConfirmation, modelo: r.modelo })
    return r
  }
}
