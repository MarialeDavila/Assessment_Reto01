/**
 * Herramientas del agente "Registro como Proveedor".
 * Cada export es { description, args (zod), execute(args, ctx) } y el modelo la ve como proveedor_<export>.
 * Son la única fuente de valores que el agente puede afirmar. Nunca lanzan: devuelven JSON con { ok, data } o { ok: false, error }.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { generarPdf, generarReporteFaltantes, generarValoresPortal, generarXlsx } from "./formularios"
import { asegurarDir, fallo, fechaEjecucion, ok, registrar, relativa, rutas, validarCaso, type Ctx, type Resultado } from "./lib"
import { cargarBase, mapear, type Mapeo } from "./mapeo"
import { construirChecklist, escribirPaquete } from "./paquete"
import { cargarCaso, type Caso } from "./solicitud"

export type { Ctx } from "./lib"

const argCaso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, por ejemplo ec-corp-andina")

/** Ejecuta la lógica, captura cualquier error inesperado, registra en log.jsonl y serializa. */
async function ejecutar<T>(ctx: Ctx, herramienta: string, caso: string | undefined, fn: () => Promise<Resultado<T>> | Resultado<T>, resumir: (d: T) => string): Promise<string> {
  let r: Resultado<T>
  try {
    r = await fn()
  } catch (e) {
    r = fallo(`Error interno en ${herramienta}: ${e instanceof Error ? e.message : "desconocido"}.`)
  }
  registrar(ctx, herramienta, caso, r, r.ok ? resumir(r.data) : r.error)
  return JSON.stringify(r)
}

function abrirCaso(ctx: Ctx, caso: string): Resultado<Caso> {
  const dir = validarCaso(ctx, caso)
  if (!dir.ok) return dir
  return cargarCaso(dir.data)
}

function calcularMapeo(ctx: Ctx, c: Caso, etiquetas?: string[]): Resultado<Mapeo> {
  const base = cargarBase(ctx)
  if (!base.ok) return base
  const obligatorios = new Map(c.campos.map((x) => [x.etiqueta, x.obligatorio]))
  return ok(mapear(etiquetas ?? c.campos.map((x) => x.etiqueta), c.solicitud.pais, base.data, obligatorios))
}

export const leer_solicitud = {
  description: "Lee el correo y la plantilla de un caso y devuelve país, cliente, formato de salida, campos solicitados y soportes exigidos.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return ejecutar(ctx, "proveedor_leer_solicitud", args.caso, () => {
      const c = abrirCaso(ctx, args.caso)
      if (!c.ok) return c
      const base = cargarBase(ctx)
      const reglas = base.ok ? base.data.reglas : undefined
      const s = c.data.solicitud
      const ambiguos = (reglas?.etiquetas_ambiguas ?? []).filter((a) => c.data.campos.some((x) => x.etiqueta === a))
      return ok({
        caso: s.id,
        pais: s.pais,
        cliente: s.cliente,
        formato: s.formato,
        asunto: s.asunto,
        fecha: s.fecha,
        de: s.de,
        plantilla: c.data.plantilla,
        identificador_tributario_pais: reglas?.identificador_tributario_por_pais[s.pais] ?? null,
        campos: c.data.campos.map((x) => ({ etiqueta: x.etiqueta, obligatorio: x.obligatorio })),
        requiere_confirmacion: ambiguos.map((a) => ({ etiqueta: a, propuesta: reglas?.identificador_tributario_por_pais[s.pais] ?? null })),
        soportes: c.data.soportes,
        advertencias: c.data.errorPlantilla ? [c.data.errorPlantilla] : [],
      })
    }, (d) => `${d.cliente} (${d.pais}), formato ${d.formato}, ${d.campos.length} campos, ${d.soportes.length} soportes`)
  },
}

export const mapear_campos = {
  description: "Cruza cada campo solicitado con el repositorio maestro y lo clasifica como lleno, faltante o requiere_confirmacion, con la ruta del dato.",
  args: {
    caso: argCaso,
    campos: z.array(z.string()).describe("Etiquetas de los campos tal como las devolvió proveedor_leer_solicitud"),
  },
  async execute(args: { caso: string; campos: string[] }, ctx: Ctx): Promise<string> {
    return ejecutar(ctx, "proveedor_mapear_campos", args.caso, () => {
      const c = abrirCaso(ctx, args.caso)
      if (!c.ok) return c
      const etiquetas = args.campos.length ? args.campos : c.data.campos.map((x) => x.etiqueta)
      return calcularMapeo(ctx, c.data, etiquetas)
    }, (d) => `${d.llenos.length} llenos, ${d.faltantes.length} faltantes, ${d.requiere_confirmacion.length} por confirmar`)
  },
}

const MapeoArg = z
  .object({
    llenos: z.array(z.object({ etiqueta: z.string().describe("Etiqueta del campo") })).describe("Campos llenos"),
    faltantes: z.array(z.object({ etiqueta: z.string().describe("Etiqueta del campo") })).describe("Campos faltantes"),
    requiere_confirmacion: z.array(z.object({ etiqueta: z.string().describe("Etiqueta del campo") })).describe("Campos por confirmar"),
  })
  .partial()

export const generar_formulario = {
  description: "Genera el formulario lleno en el formato del cliente (xlsx o pdf) en out/<caso>/; para portal produce valores-portal.md e indica formato no soportado.",
  args: {
    caso: argCaso,
    mapeo: MapeoArg.optional().describe("Resultado de proveedor_mapear_campos. Los valores se vuelven a leer del maestro; nunca se toman de este argumento"),
  },
  async execute(args: { caso: string; mapeo?: z.infer<typeof MapeoArg> }, ctx: Ctx): Promise<string> {
    return ejecutar(ctx, "proveedor_generar_formulario", args.caso, () => generar(ctx, args.caso), (d) => `${d.formato}: ${d.ruta}`)
  },
}

type Generado = { ruta: string; formato: string; soportado: boolean; reporte_faltantes: string; mensaje?: string }

async function generar(ctx: Ctx, caso: string): Promise<Resultado<Generado>> {
  const c = abrirCaso(ctx, caso)
  if (!c.ok) return c
  if (c.data.errorPlantilla) return fallo(`${c.data.errorPlantilla} No se puede generar el formulario; el paquete de soportes sí puede armarse.`)
  // CA2: el mapeo se recalcula aquí para que ningún valor provenga del modelo.
  const m = calcularMapeo(ctx, c.data)
  if (!m.ok) return m
  const s = c.data.solicitud
  const dir = rutas(ctx, caso).salida
  asegurarDir(dir)
  const reporte = relativa(ctx, generarReporteFaltantes(dir, s, m.data))
  if (s.formato === "xlsx") {
    const ruta = join(dir, "formulario.xlsx")
    await generarXlsx(ruta, c.data.campos, m.data)
    return ok({ ruta: relativa(ctx, ruta), formato: "xlsx", soportado: true, reporte_faltantes: reporte })
  }
  if (s.formato === "pdf") {
    const ruta = join(dir, "formulario.pdf")
    await generarPdf(ruta, s, c.data.campos, m.data)
    return ok({ ruta: relativa(ctx, ruta), formato: "pdf", soportado: true, reporte_faltantes: reporte })
  }
  const ruta = join(dir, "valores-portal.md")
  generarValoresPortal(ruta, s, c.data.campos, m.data)
  return ok({ ruta: relativa(ctx, ruta), formato: "portal", soportado: false, reporte_faltantes: reporte, mensaje: "formato no soportado: el portal web lo diligencia una persona; se generó valores-portal.md con los valores listos para copiar." })
}

export const armar_paquete = {
  description: "Arma out/<caso>/paquete/ con formulario, soportes exigidos, checklist.md y borrador-correo.md, e indica si está listo para firma.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return ejecutar(ctx, "proveedor_armar_paquete", args.caso, async () => {
      const c = abrirCaso(ctx, args.caso)
      if (!c.ok) return c
      const base = cargarBase(ctx)
      if (!base.ok) return base
      const g = await generar(ctx, args.caso)
      const m = calcularMapeo(ctx, c.data)
      if (!m.ok) return m
      const checklist = construirChecklist(ctx, c.data, m.data, base.data.reglas)
      if (!g.ok) checklist.observaciones.push(g.error)
      const formulario = g.ok ? join(rutas(ctx).raiz, g.data.ruta) : undefined
      const p = escribirPaquete(ctx, c.data, checklist, formulario)
      return ok({ ruta: relativa(ctx, p.ruta), listo_para_firma: p.listo, checklist })
    }, (d) => `listo_para_firma=${d.listo_para_firma}, ${d.checklist.bloqueos.length} bloqueos`)
  },
}

export const simular_envio = {
  description: "Simula el envío del paquete escribiendo out/<caso>/ENVIO-SIMULADO.md; solo procede si el usuario confirmó explícitamente en su último mensaje.",
  args: {
    caso: argCaso,
    confirmado: z.boolean().describe("true solo si el usuario confirmó el envío de forma explícita en su último mensaje"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: Ctx): Promise<string> {
    return ejecutar(ctx, "proveedor_simular_envio", args.caso, () => {
      // RN4: la confirmación la exige el argumento y, en el servidor, el mensaje real del usuario.
      if (!args.confirmado || ctx.confirmacionHumana === false) return fallo("requiere confirmación explícita")
      const v = validarCaso(ctx, args.caso)
      if (!v.ok) return v
      const dir = rutas(ctx, args.caso).salida
      const estadoRuta = join(dir, "estado.json")
      if (!existsSync(estadoRuta)) return fallo("Primero debe armarse el paquete con proveedor_armar_paquete.")
      const estado = JSON.parse(readFileSync(estadoRuta, "utf8")) as { listo_para_firma: boolean; adjuntos: string[]; checklist: { bloqueos: string[] } }
      const ruta = join(dir, "ENVIO-SIMULADO.md")
      writeFileSync(ruta, [
        `# Envío simulado: ${args.caso}`,
        "",
        `Fecha: ${fechaEjecucion()}`,
        `Sesión: ${ctx.sessionId}`,
        `Estado del paquete al confirmar: ${estado.listo_para_firma ? "listo_para_firma" : "bloqueado"}`,
        "",
        "Adjuntos que se enviarían:",
        ...estado.adjuntos.map((a) => `- ${a}`),
        ...(estado.checklist.bloqueos.length ? ["", "Advertencias (bloqueos vigentes):", ...estado.checklist.bloqueos.map((b) => `- ${b}`)] : []),
        "",
        "Simulación: no se envió ningún correo ni se firmó ningún documento.",
      ].join("\n") + "\n")
      return ok({ ruta: relativa(ctx, ruta), listo_para_firma: estado.listo_para_firma })
    }, (d) => d.ruta)
  },
}

export const herramientas = { leer_solicitud, mapear_campos, generar_formulario, armar_paquete, simular_envio }
