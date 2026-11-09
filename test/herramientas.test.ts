import { describe, expect, test, beforeAll } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { herramientas, type Ctx } from "../src/tools/proveedor"
import { esConfirmacion } from "../src/agent/agente"
import type { BaseMessage } from "@langchain/core/messages"

// En las pruebas se accede libremente a los datos devueltos; el código de producción no usa any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = { ok: boolean; data?: any; error?: string }
const raiz = resolve(import.meta.dir, "..")
let dir = ""
let ctx: Ctx
const run = async (h: { execute: (a: never, c: Ctx) => Promise<string> }, a: unknown, c = ctx): Promise<R> => JSON.parse(await h.execute(a as never, c))

beforeAll(() => {
  // Copia aislada: los fixtures originales nunca se modifican.
  dir = mkdtempSync(join(tmpdir(), "reto01-"))
  cpSync(join(raiz, "fixtures"), join(dir, "fixtures"), { recursive: true })
  cpSync(join(raiz, "src", "knowledge"), join(dir, "src", "knowledge"), { recursive: true })
  cpSync(join(raiz, "agent"), join(dir, "agent"), { recursive: true })
  ctx = { directory: dir, sessionId: "test" }
  process.env.FECHA_EJECUCION = "2026-09-02"
})

describe("HU-1 leer_solicitud", () => {
  test("devuelve país, formato, campos y soportes", async () => {
    const r = await run(herramientas.leer_solicitud, { caso: "ec-corp-andina" })
    expect(r.ok).toBe(true)
    expect(r.data.pais).toBe("EC")
    expect(r.data.formato).toBe("pdf")
    expect(r.data.campos).toHaveLength(15)
    expect(r.data.soportes).toContain("certificado_cumplimiento_tributario")
  })
  test("caso inexistente devuelve error claro sin lanzar", async () => {
    const r = await run(herramientas.leer_solicitud, { caso: "no-existe" })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("no existe")
  })
  test("plantilla corrupta: aviso claro y el paquete se arma igual", async () => {
    const otro = mkdtempSync(join(tmpdir(), "reto01c-"))
    cpSync(dir, otro, { recursive: true })
    writeFileSync(join(otro, "fixtures/reto-01/casos/co-industrias-delta/plantilla-celdas.json"), "{ corrupto")
    const c = { directory: otro, sessionId: "t" }
    const r = await run(herramientas.leer_solicitud, { caso: "co-industrias-delta" }, c)
    expect(r.ok).toBe(true)
    expect(r.data.advertencias[0]).toMatch(/corrupt/)
    const p = await run(herramientas.armar_paquete, { caso: "co-industrias-delta" }, c)
    expect(p.ok).toBe(true)
  })
})

describe("HU-2 mapear_campos", () => {
  test("RN1: identificador extranjero requiere confirmación", async () => {
    const r = await run(herramientas.mapear_campos, { caso: "hn-agroexport-sula", campos: ["RTN"] })
    expect(r.data.requiere_confirmacion[0].nota).toContain("identificador extranjero")
    expect(r.data.requiere_confirmacion[0].propuesta).toBe("RTN")
  })
  test("etiqueta ambigua propone el equivalente del país", async () => {
    const r = await run(herramientas.mapear_campos, { caso: "ec-corp-andina", campos: ["Identificación tributaria"] })
    expect(r.data.requiere_confirmacion[0].propuesta).toBe("RUC")
  })
  test("nunca inventa: un campo sin fuente es faltante", async () => {
    const r = await run(herramientas.mapear_campos, { caso: "hn-agroexport-sula", campos: ["Referencias comerciales", "Color favorito"] })
    expect(r.data.faltantes.map((f: { etiqueta: string }) => f.etiqueta)).toEqual(["Referencias comerciales", "Color favorito"])
    expect(r.data.llenos).toHaveLength(0)
  })
  test("NIT en Colombia queda lleno con su ruta", async () => {
    const r = await run(herramientas.mapear_campos, { caso: "co-industrias-delta", campos: ["NIT"] })
    expect(r.data.llenos[0]).toMatchObject({ ruta: "nit", valor: "900123456" })
  })
})

describe("HU-3 y HU-4", () => {
  test("xlsx escribe etiqueta y valor en la celda indicada", async () => {
    const r = await run(herramientas.generar_formulario, { caso: "co-industrias-delta" })
    expect(r.data.ruta).toBe("out/co-industrias-delta/formulario.xlsx")
    const ExcelJS = (await import("exceljs")).default
    const libro = new ExcelJS.Workbook()
    await libro.xlsx.readFile(join(dir, r.data.ruta))
    expect(libro.getWorksheet("Datos Proveedor")?.getCell("B4").value).toBe("NIT")
    expect(libro.getWorksheet("Datos Proveedor")?.getCell("C4").value).toBe("900123456")
    expect(libro.getWorksheet("Datos Bancarios")?.getCell("C5").value).toBe("03100012345")
  })
  test("portal: formato no soportado y valores-portal.md", async () => {
    const r = await run(herramientas.generar_formulario, { caso: "pa-logistica-istmo" })
    expect(r.data.soportado).toBe(false)
    expect(r.data.ruta).toContain("valores-portal.md")
  })
  test("RN3: soporte vencido bloquea listo_para_firma", async () => {
    const r = await run(herramientas.armar_paquete, { caso: "hn-agroexport-sula" })
    expect(r.data.listo_para_firma).toBe(false)
    expect(r.data.checklist.soportes.find((s: { tipo: string }) => s.tipo === "parafiscales").estado).toBe("vencido")
  })
  test("co-industrias-delta queda listo con soportes vigentes", async () => {
    const r = await run(herramientas.armar_paquete, { caso: "co-industrias-delta" })
    expect(r.data.listo_para_firma).toBe(true)
  })
  test("RN2: el borrador de correo no contiene datos bancarios", async () => {
    await run(herramientas.armar_paquete, { caso: "ec-corp-andina" })
    const correo = readFileSync(join(dir, "out/ec-corp-andina/paquete/borrador-correo.md"), "utf8")
    for (const dato of ["03100012345", "COLOCOBM", "Bancolombia"]) expect(correo).not.toContain(dato)
  })
})

describe("RN4 confirmación", () => {
  test("simular_envio sin confirmación se rechaza", async () => {
    const r = await run(herramientas.simular_envio, { caso: "ec-corp-andina", confirmado: false })
    expect(r).toEqual({ ok: false, error: "requiere confirmación explícita" })
  })
  test("el servidor bloquea aunque el modelo diga confirmado", async () => {
    const r = await run(herramientas.simular_envio, { caso: "ec-corp-andina", confirmado: true }, { ...ctx, confirmacionHumana: false })
    expect(r.ok).toBe(false)
  })
  test("con confirmación escribe ENVIO-SIMULADO.md", async () => {
    const r = await run(herramientas.simular_envio, { caso: "ec-corp-andina", confirmado: true }, { ...ctx, confirmacionHumana: true })
    expect(r.data.ruta).toBe("out/ec-corp-andina/ENVIO-SIMULADO.md")
  })
  test("detección de confirmación explícita", () => {
    expect(esConfirmacion("Sí, confirmo")).toBe(true)
    expect(esConfirmacion("envía")).toBe(true)
    expect(esConfirmacion("No envíes nada todavía")).toBe(false)
    expect(esConfirmacion("¿qué falta?")).toBe(false)
  })
})

describe("Bonus: módulo reutilizable", () => {
  test("modulo/ coincide con las fuentes de la aplicación", async () => {
    const { contenidoModulo } = await import("../scripts/empaquetar-modulo")
    for (const [ruta, contenido] of Object.entries(contenidoModulo())) expect(readFileSync(join(raiz, ruta), "utf8")).toBe(contenido)
  })
  test("las herramientas del módulo son las de la aplicación", async () => {
    const m = await import("../modulo/tools/proveedor")
    expect(m.leer_solicitud).toBe(herramientas.leer_solicitud)
  })
})

describe("Reintentos ante límite de uso", () => {
  test("detecta 429 y lee la espera sugerida", async () => {
    const { esLimiteDeUso, esperaSugeridaMs } = await import("../src/agent/reintentos")
    expect(esLimiteDeUso(new Error("[429 Too Many Requests] Resource exhausted"))).toBe(true)
    expect(esLimiteDeUso(new Error("[400 Bad Request]"))).toBe(false)
    expect(esperaSugeridaMs(new Error('{"retryDelay":"27s"}'))).toBe(27000)
    expect(esperaSugeridaMs(new Error("Please retry in 12.5s."))).toBe(12500)
  })
})

describe("procesar_caso (un solo paso)", () => {
  test("ejecuta el flujo completo sin exponer datos bancarios", async () => {
    const r = await run(herramientas.procesar_caso, { caso: "ec-corp-andina" })
    expect(r.ok).toBe(true)
    expect(r.data.campos_faltantes).toEqual(["Número de contribuyente especial"])
    expect(r.data.paquete.listo_para_firma).toBe(false)
    expect(r.data.formulario.ruta).toBe("out/ec-corp-andina/formulario.pdf")
    for (const dato of ["03100012345", "COLOCOBM"]) expect(JSON.stringify(r)).not.toContain(dato)
  })
})

describe("Cadena de respaldo ante límite de uso", () => {
  test("cuota diaria agotada: pasa directo al modo determinista y responde con datos de herramientas", async () => {
    const { createAgent } = await import("langchain")
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { HumanMessage } = await import("@langchain/core/messages")
    const { middlewareReintentos } = await import("../src/agent/reintentos")
    const { ChatSimulado } = await import("../src/llm/simulado")
    const { aLangChain } = await import("../src/agent/herramientas-langchain")
    class Agotado extends BaseChatModel {
      _llmType() { return "agotado" }
      override bindTools() { return this }
      async _generate(): Promise<never> { throw new Error("[429 Too Many Requests] Quota exceeded: GenerateRequestsPerDayPerProjectPerModel") }
    }
    const agente = createAgent({ model: new Agotado({}), tools: aLangChain(ctx), middleware: [middlewareReintentos({ intentos: 3, esperaBaseMs: 10, esperaMaximaMs: 20, timeoutLlamadaMs: 1000, presupuestoMs: 3000 }, "agotado", [{ nombre: "respaldo", modelo: new ChatSimulado({ etiqueta: "[Respaldo]" }) }])] })
    const r = await agente.invoke({ messages: [new HumanMessage("Procesa el caso ec-corp-andina")] })
    const texto = String(r.messages.at(-1)?.content)
    expect(texto).toContain("[Respaldo]")
    expect(texto).toContain("Número de contribuyente especial")
    expect(texto).not.toContain("03100012345")
  })
})

describe("Respaldo ante modelo lento", () => {
  test("un timeout por llamada pasa al respaldo sin agotar el turno", async () => {
    const { createAgent } = await import("langchain")
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { HumanMessage } = await import("@langchain/core/messages")
    const { middlewareReintentos } = await import("../src/agent/reintentos")
    const { ChatSimulado } = await import("../src/llm/simulado")
    const { aLangChain } = await import("../src/agent/herramientas-langchain")
    class Lento extends BaseChatModel {
      _llmType() { return "lento" }
      override bindTools() { return this }
      async _generate(): Promise<never> { await new Promise((r) => setTimeout(r, 5000)); throw new Error("no debería llegar") }
    }
    const inicio = Date.now()
    const agente = createAgent({ model: new Lento({}), tools: aLangChain(ctx), middleware: [middlewareReintentos({ intentos: 2, esperaBaseMs: 10, esperaMaximaMs: 20, timeoutLlamadaMs: 300, presupuestoMs: 2000 }, "lento", [{ nombre: "modo de respaldo sin IA", modelo: new ChatSimulado({ etiqueta: "[Respaldo]" }) }])] })
    const r = await agente.invoke({ messages: [new HumanMessage("Procesa el caso co-industrias-delta")] })
    const ultimo = r.messages.at(-1)
    expect(String(ultimo?.content)).toContain("[Respaldo]")
    expect((ultimo?.response_metadata as Record<string, unknown>).modelo_usado).toBe("modo de respaldo sin IA")
    expect(Date.now() - inicio).toBeLessThan(3000)
  })
})

describe("Envío con confirmación explícita y paquete bloqueado", () => {
  test("si el modelo se niega, el servidor registra el envío simulado con advertencias", async () => {
    const { BaseChatModel } = await import("@langchain/core/language_models/chat_models")
    const { AIMessage } = await import("@langchain/core/messages")
    const { Agente } = await import("../src/agent/agente")
    const { Registro } = await import("../src/db")
    const { ChatSimulado } = await import("../src/llm/simulado")
    const guion = new ChatSimulado()
    class Reticente extends BaseChatModel {
      _llmType() { return "reticente" }
      override bindTools() { return this }
      async _generate(mensajes: BaseMessage[]) {
        const ultimo = String(mensajes.filter((m: BaseMessage) => m.getType() === "human").at(-1)?.content)
        if (/confirmo/i.test(ultimo)) return { generations: [{ message: new AIMessage("No puedo enviarlo porque el certificado está vencido."), text: "" }] }
        return guion._generate(mensajes)
      }
    }
    const modelo = new Reticente({})
    const adaptador = { proveedor: "prueba", modelo: "reticente", precio: { entrada: 0, salida: 0 }, enviar: () => Promise.reject(new Error("no usado")), modeloChat: () => modelo }
    const config = { maxIteraciones: 25, maxTokensSesion: 1e6, timeoutMs: 10000, reintentos: { intentos: 0, esperaBaseMs: 10, esperaMaximaMs: 10, timeoutLlamadaMs: 5000, presupuestoMs: 5000 } }
    const agente = new Agente(adaptador, dir, new Registro(dir), config)
    const sesion = { id: "envio-test", mensajes: [], historial: [], tokens: 0, pendienteConfirmacion: false }
    const r1 = await agente.turno(sesion, "Procesa el caso hn-agroexport-sula. No envíes nada todavía.")
    expect(r1.needsConfirmation).toBe(true)
    const r2 = await agente.turno(sesion, "Sí, confirmo el envío.")
    expect(r2.toolCalls.some((t) => t.nombre === "proveedor_simular_envio" && t.ok)).toBe(true)
    expect(r2.needsConfirmation).toBe(false)
    const archivo = readFileSync(join(dir, "out/hn-agroexport-sula/ENVIO-SIMULADO.md"), "utf8")
    expect(archivo).toContain("Advertencias")
  })
})
